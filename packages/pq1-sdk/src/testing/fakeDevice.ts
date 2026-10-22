// A fake PQ1 for tests: a `HIDDevice`-shaped object that speaks the real
// USB framing (64-byte reports, chained APDUs, GET_RESPONSE draining) and
// answers every command the SDK sends. It runs no cryptography: addresses
// are derived from a hash of the seed, and signatures are filler bytes of
// the right length. Use it to test your integration end to end without
// hardware; never anywhere near real funds.

import { keccak256, toBytes } from 'viem'

import {
  CAP_OFFCHAIN_COW_ORDER,
  CAP_OFFCHAIN_SAFE_TX,
  CAP_SIGN_USEROP_DATA_8K,
  maxCallDataLen,
  MAX_BATCH_CALL_DATA_TOTAL_LEN,
  SW_INTERNAL_ERROR,
  C10_SIG_LEN,
  CHANNEL_ID,
  ERC6492_WRAPPED_BLOB_LEN,
  FACTORY,
  FLAG_INCLUDE_INIT_CODE,
  INS_GET_DEVICE_INFO,
  INS_GET_INIT_CODE,
  INS_GET_RESPONSE,
  INS_GET_STATUS,
  INS_GET_WALLET_ADDRESS,
  INS_OFFCHAIN_SYNC,
  INS_SIGN_OFFCHAIN,
  INS_SIGN_USEROP,
  INS_SIGN_USEROP_BATCH,
  INS_UNLOCK,
  P1_MORE,
  PQ1_PID,
  PQ1_VID,
  PQ_INIT_CODE_LEN,
  REPORT_SIZE,
  SIG_WRAPPER_LEN,
  SW_CONDITIONS_NOT_SATISFIED,
  SW_INS_NOT_SUPPORTED,
  SW_OK,
  SW_SECURITY_CONDITION,
  TAG_APDU
} from '../config'
import {
  bytesToHex0x,
  concatBytes,
  hexToBytes,
  readU32Be,
  readU64Be,
  u32be,
  u64be
} from '../transport/bytes'

/** Largest data chunk the device returns before asking for GET_RESPONSE. */
const APDU_MAX_RESP = 253

/** `createAccount` selector, the start of a factory init code's calldata. */
const CREATE_ACCOUNT_SELECTOR = [0xf6, 0x18, 0x2a, 0x73]

/** A command the fake received, after reassembly and chaining. */
export type FakeCommand = { ins: number; payload: Uint8Array }

/** Options for `FakePq1Device`. */
export type FakePq1DeviceOptions = {
  /** Seed for the fake's addresses: two fakes with different seeds act like
   *  two different PQ1s. Default `'pq1-fake'`. */
  seed?: string
  /** Start locked (the PIN is "entered" on UNLOCK unless `pinAccepted`
   *  is false). Default false. */
  locked?: boolean
  /** Protocol version reported by GET_DEVICE_INFO. Default 0x0203. */
  protocolVersion?: number
  /** Capability bits. Default: what current firmware reports — Safe and CoW
   *  off-chain screens and 8 KB calls (`CAP_SIGN_USEROP_DATA_8K`). Clear that
   *  bit to act like older firmware, which refuses a call over 4096 bytes
   *  with a generic error. */
  capabilities?: number
}

type Listener = (event: { data: DataView; device?: unknown }) => void

/**
 * A fake PQ1 on the other end of WebHID. Pass it to
 * `Pq1Device.connect({ hidDevice: fake })`, or install it as
 * `navigator.hid` with `installFakeHid(fake)`.
 *
 * Behaviour you can steer between steps:
 * - `locked`, `pinAccepted`: the lock and the next UNLOCK's outcome;
 * - `rejectNext`: the user rejects the next signature or address check;
 * - `offchainCount`: the device's off-chain signature count.
 *
 * And inspect: `commands` (every command received), `initCodeRequests`.
 */
export class FakePq1Device {
  readonly vendorId = PQ1_VID

  readonly productId = PQ1_PID

  readonly productName = 'PQSigner OS (fake)'

  readonly collections: HIDCollectionInfo[] = []

  opened = false

  oninputreport: ((this: HIDDevice, ev: HIDInputReportEvent) => unknown) | null = null

  locked: boolean

  /** Whether the next UNLOCK succeeds. */
  pinAccepted = true

  /** When true, the next sign / show-address command is rejected on the
   *  "device" (SW 0x6982), then this resets. */
  rejectNext = false

  /** The device's off-chain signature count (raised by OFFCHAIN_SYNC). */
  offchainCount = 0n

  /** Every command received, in order (GET_RESPONSE excluded). */
  readonly commands: FakeCommand[] = []

  /** How many GET_INIT_CODE commands were answered. */
  initCodeRequests = 0

  /** Lock the device just before the next command with this INS, as its
   *  idle timer would mid-operation. See `lockBeforeNext`. */
  private lockOnIns: number | null = null

  private readonly seed: string

  private readonly protocolVersion: number

  private readonly capabilities: number

  private listeners = new Set<Listener>()

  private rxPending: Uint8Array | null = null

  private rxExpected = 0

  private chain: { ins: number; parts: Uint8Array[] } | null = null

  private pendingResponse: Uint8Array | null = null

  private outbox: Uint8Array[] = []

  private draining = false

  constructor(options: FakePq1DeviceOptions = {}) {
    this.seed = options.seed ?? 'pq1-fake'
    this.locked = options.locked ?? false
    this.protocolVersion = options.protocolVersion ?? 0x0203
    this.capabilities =
      options.capabilities ??
      0b1 | CAP_OFFCHAIN_SAFE_TX | CAP_OFFCHAIN_COW_ORDER | CAP_SIGN_USEROP_DATA_8K
  }

  // ── What the fake derives ─────────────────────────────────────────

  /** The bootstrap key of account `index`: the fields its init code carries
   *  and the factory derives the address from. */
  masterKeyOf(index: number): { seed: `0x${string}`; root: `0x${string}` } {
    return {
      seed: keccak256(toBytes(`${this.seed}:seed:${index}`)),
      root: keccak256(toBytes(`${this.seed}:root:${index}`))
    }
  }

  /** The address of account `index`. */
  addressOf(index: number): `0x${string}` {
    const { seed, root } = this.masterKeyOf(index)
    return this.predictAddress(seed, root)
  }

  /** What the factory's `getAddress(seed, root)` returns for this fake's
   *  keys (use it in a fake chain), or the zero address for unknown keys. */
  predictAddress(seed: `0x${string}`, root: `0x${string}`): `0x${string}` {
    const digest = keccak256(concatBytes([toBytes(seed), toBytes(root)]))
    return `0x${digest.slice(-40)}`
  }

  /** The init code of account `index` on `chainId`. */
  initCodeOf(index: number, chainId: bigint | number): Uint8Array {
    const { seed, root } = this.masterKeyOf(index)
    const out = new Uint8Array(PQ_INIT_CODE_LEN)
    out.set(hexToBytes(FACTORY), 0)
    out.set(CREATE_ACCOUNT_SELECTOR, 20)
    out.set(hexToBytes(seed), 24)
    out.set(hexToBytes(root), 56)
    out.set(u64be(chainId), 24 + 32 * 5 - 8)
    return out
  }

  /** Lock the fake, as its two-minute idle timer would. */
  lock(): void {
    this.locked = true
  }

  /** Lock the fake right before the next command `ins` (e.g. 0x30,
   *  SIGN_USEROP) arrives, to test recovery from an idle lock that hits
   *  between the wallet's checks and the command. */
  lockBeforeNext(ins: number): void {
    this.lockOnIns = ins
  }

  // ── HIDDevice surface ─────────────────────────────────────────────

  async open(): Promise<void> {
    this.opened = true
  }

  async close(): Promise<void> {
    this.opened = false
  }

  async forget(): Promise<void> {
    this.opened = false
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === 'inputreport') this.listeners.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === 'inputreport') this.listeners.delete(listener)
  }

  dispatchEvent(): boolean {
    return true
  }

  async sendFeatureReport(): Promise<void> {}

  async receiveFeatureReport(): Promise<DataView> {
    return new DataView(new ArrayBuffer(0))
  }

  async sendReport(_reportId: number, data: BufferSource): Promise<void> {
    const report = toUint8Array(data)
    const seq = (report[3]! << 8) | report[4]!
    if (seq === 0) {
      this.rxExpected = (report[5]! << 8) | report[6]!
      this.rxPending = report.slice(7, 7 + Math.min(this.rxExpected, REPORT_SIZE - 7))
    } else {
      const rest = this.rxExpected - this.rxPending!.length
      this.rxPending = concatBytes([
        this.rxPending!,
        report.slice(5, 5 + Math.min(rest, REPORT_SIZE - 5))
      ])
    }
    if (this.rxPending!.length < this.rxExpected) return
    const apdu = this.rxPending!
    this.rxPending = null
    this.emit(this.handleApdu(apdu))
  }

  /** This fake as the `HIDDevice` type WebHID APIs take. */
  asHidDevice(): HIDDevice {
    return this as unknown as HIDDevice
  }

  // ── Command handling ──────────────────────────────────────────────

  private handleApdu(apdu: Uint8Array): Uint8Array {
    const ins = apdu[1]!
    const p1 = apdu[2]!
    const lc = apdu.length > 4 ? apdu[4]! : 0
    const data = apdu.slice(5, 5 + lc)

    if (ins === INS_GET_RESPONSE) return this.drain()
    // Any other command scrubs an undrained response, like the firmware.
    this.pendingResponse = null

    if (p1 === P1_MORE) {
      if (!this.chain || this.chain.ins !== ins) this.chain = { ins, parts: [] }
      this.chain.parts.push(data)
      return sw(SW_OK)
    }
    let payload: Uint8Array = data
    if (this.chain && this.chain.ins === ins) {
      payload = concatBytes([...this.chain.parts, data])
    }
    this.chain = null
    if (this.lockOnIns === ins) {
      this.lockOnIns = null
      this.locked = true
    }
    this.commands.push({ ins, payload })
    return this.respond(this.execute(ins, payload))
  }

  /** `[data][sw]` as the device sends it: long data comes in 253-byte
   *  chunks with SW 61xx, drained by GET_RESPONSE. */
  private respond(result: { data?: Uint8Array; sw: number }): Uint8Array {
    const data = result.data ?? new Uint8Array(0)
    if (result.sw !== SW_OK || data.length <= APDU_MAX_RESP)
      return concatBytes([data, sw(result.sw)])
    this.pendingResponse = data.slice(APDU_MAX_RESP)
    return concatBytes([
      data.slice(0, APDU_MAX_RESP),
      sw(0x6100 | Math.min(0xff, this.pendingResponse.length))
    ])
  }

  private drain(): Uint8Array {
    const rest = this.pendingResponse
    if (!rest) return sw(SW_CONDITIONS_NOT_SATISFIED)
    const chunk = rest.slice(0, APDU_MAX_RESP)
    this.pendingResponse = rest.length > APDU_MAX_RESP ? rest.slice(APDU_MAX_RESP) : null
    const status = this.pendingResponse
      ? 0x6100 | Math.min(0xff, this.pendingResponse.length)
      : SW_OK
    return concatBytes([chunk, sw(status)])
  }

  private execute(ins: number, payload: Uint8Array): { data?: Uint8Array; sw: number } {
    switch (ins) {
      case INS_GET_DEVICE_INFO:
        return { data: this.deviceInfo(), sw: SW_OK }
      case INS_GET_STATUS:
        return { data: new Uint8Array([this.locked ? 1 : 0, 10]), sw: SW_OK }
      case INS_UNLOCK:
        if (!this.pinAccepted) return { sw: SW_SECURITY_CONDITION }
        this.locked = false
        return { sw: SW_OK }
      default:
        break
    }
    if (this.locked) return { sw: SW_CONDITIONS_NOT_SATISFIED }
    switch (ins) {
      case INS_GET_WALLET_ADDRESS: {
        const index = payload.length >= 4 ? readU32Be(payload, 0) : 0
        if (payload[4] === 1 && this.takeRejection()) return { sw: SW_SECURITY_CONDITION }
        return { data: hexToBytes(this.addressOf(index)), sw: SW_OK }
      }
      case INS_GET_INIT_CODE:
        this.initCodeRequests++
        return { data: this.initCodeOf(readU32Be(payload, 0), readU64Be(payload, 4)), sw: SW_OK }
      case INS_OFFCHAIN_SYNC: {
        const target = readU64Be(payload, 13)
        if (target > this.offchainCount) this.offchainCount = target
        return { sw: SW_OK }
      }
      case INS_SIGN_USEROP:
      case INS_SIGN_USEROP_BATCH:
        // Like the firmware: an over-cap call is refused with a generic
        // status before any screen, so the host must gate on the bit.
        if (!this.callDataFits(ins, payload)) return { sw: SW_INTERNAL_ERROR }
        if (this.takeRejection()) return { sw: SW_SECURITY_CONDITION }
        return { data: this.signUserOp(payload), sw: SW_OK }
      case INS_SIGN_OFFCHAIN:
        if (this.takeRejection()) return { sw: SW_SECURITY_CONDITION }
        return { data: this.signOffchain(payload), sw: SW_OK }
      default:
        return { sw: SW_INS_NOT_SUPPORTED }
    }
  }

  /** The firmware's call-data caps for this fake's capability bits: per
   *  call, and summed over a batch. */
  private callDataFits(ins: number, payload: Uint8Array): boolean {
    const cap = maxCallDataLen(this.capabilities)
    if (ins === INS_SIGN_USEROP) {
      const dataLen = payload.length >= 330 ? (payload[328]! << 8) | payload[329]! : 0
      return dataLen <= cap
    }
    // SIGN_USEROP_BATCH: UserOp header (276), wire version, call count, calls.
    let off = 278
    const count = payload[off - 1] ?? 0
    let total = 0
    for (let i = 0; i < count; i++) {
      off += 20 + 32
      const dataLen = (payload[off]! << 8) | payload[off + 1]!
      off += 2 + dataLen
      total += dataLen
      if (dataLen > cap || total > MAX_BATCH_CALL_DATA_TOTAL_LEN) return false
    }
    return true
  }

  private takeRejection(): boolean {
    if (!this.rejectNext) return false
    this.rejectNext = false
    return true
  }

  private deviceInfo(): Uint8Array {
    const out = new Uint8Array(40)
    out[0] = this.protocolVersion >> 8
    out[1] = this.protocolVersion & 0xff
    out.set([0, 1, 0], 2)
    out.set(u32be(this.capabilities), 21)
    out[25] = 2
    out.set([SIG_WRAPPER_LEN >> 8, SIG_WRAPPER_LEN & 0xff], 26)
    out.set([0x00, 0x06], 36)
    out.set([0x00, 0x60], 38)
    return out
  }

  /** SIGN_USEROP / SIGN_USEROP_BATCH: header is `chainId u64 ‖ flags u32
   *  ‖ …`. Answers count, init code (when asked), no type1, and a filler
   *  type2 wrapper. */
  private signUserOp(payload: Uint8Array): Uint8Array {
    this.offchainCount += 1n
    const chainId = readU64Be(payload, 0)
    const flags = readU32Be(payload, 8)
    const index = (flags >>> 22) & 0xff
    const initCode =
      flags & FLAG_INCLUDE_INIT_CODE ? this.initCodeOf(index, chainId) : new Uint8Array(0)
    return concatBytes([
      u64be(this.offchainCount),
      u32be(initCode.length),
      initCode,
      u32be(0),
      u32be(SIG_WRAPPER_LEN),
      new Uint8Array(SIG_WRAPPER_LEN).fill(0x5a)
    ])
  }

  /** SIGN_OFFCHAIN: header `acct u8 ‖ chain u64 ‖ slot u32 ‖ kind u8 ‖
   *  len u16 ‖ flags u8`, bit 0 of flags = deployed. */
  private signOffchain(payload: Uint8Array): Uint8Array {
    const deployed = (payload[16]! & 0x01) === 1
    if (deployed) {
      this.offchainCount += 1n
      return concatBytes([u64be(this.offchainCount), new Uint8Array(C10_SIG_LEN).fill(0x5b)])
    }
    const blob = new Uint8Array(ERC6492_WRAPPED_BLOB_LEN).fill(0x5c)
    // The ERC-6492 magic suffix: 0x6492 repeated.
    blob.set(
      Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 0x64 : 0x92)),
      blob.length - 32
    )
    return concatBytes([u64be(this.offchainCount), blob])
  }

  // ── Report I/O ────────────────────────────────────────────────────

  /** Replies leave in order, one report per tick, like a device that
   *  handles one request at a time. */
  private emit(reply: Uint8Array): void {
    this.outbox.push(...replyReports(reply))
    if (!this.draining) this.drainOutbox()
  }

  private drainOutbox(): void {
    const next = this.outbox.shift()
    this.draining = next !== undefined
    if (!next) return
    setTimeout(() => {
      const event = {
        data: new DataView(next.buffer, next.byteOffset, next.byteLength),
        device: this
      }
      this.listeners.forEach((listener) => listener(event))
      this.drainOutbox()
    }, 0)
  }
}

const sw = (status: number) => new Uint8Array([status >> 8, status & 0xff])

function toUint8Array(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return new Uint8Array(data)
}

/** Splits `bytes` into the device's reply reports. */
function replyReports(bytes: Uint8Array): Uint8Array[] {
  const reports: Uint8Array[] = []
  let offset = 0
  let seq = 0
  do {
    const report = new Uint8Array(REPORT_SIZE)
    report.set([CHANNEL_ID >> 8, CHANNEL_ID & 0xff, TAG_APDU, seq >> 8, seq & 0xff])
    const headerLen = seq === 0 ? 7 : 5
    if (seq === 0) report.set([bytes.length >> 8, bytes.length & 0xff], 5)
    const chunk = bytes.subarray(offset, offset + REPORT_SIZE - headerLen)
    report.set(chunk, headerLen)
    reports.push(report)
    offset += chunk.length
    seq += 1
  } while (offset < bytes.length)
  return reports
}

/** Hex of the fake's filler type-2 signature wrapper, for assertions. */
export const FAKE_USEROP_SIGNATURE = bytesToHex0x(new Uint8Array(SIG_WRAPPER_LEN).fill(0x5a))
