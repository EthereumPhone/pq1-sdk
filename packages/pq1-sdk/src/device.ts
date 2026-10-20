// One connected PQ1: the transport, its commands, unlocking, the device id
// and the init-code cache. `Pq1DeviceManager` (in `pq1-sdk/extension`) keeps
// one of these alive in an extension service worker and reconnects it.

import { isAccountIndex, SW_OK, SW_SECURITY_CONDITION } from './config'
import { consoleLogger, type Pq1Logger } from './context'
import { Pq1Error, userFacingError } from './errors'
import { memoryStore, type KeyValueStore } from './store'
import { bytesToHex0x, hexToBytes } from './transport/bytes'
import { DeviceCommands, type DeviceStatus } from './transport/commands'
import { DeviceError, HidTransport } from './transport/hid'

/** A PQ1 account: its number on the device and its address (the same on
 *  every chain). `deviceId` ties it to the PQ1 it came from. */
export type Pq1Account = {
  /** Account number on the device, 0-255. */
  index: number
  address: `0x${string}`
  /** `Pq1Device.getDeviceId()` of the PQ1 the account came from. */
  deviceId: string
}

/** What `Pq1Device.getInfo()` reports. */
export type Pq1DeviceInfo = {
  /** Wire-protocol version, e.g. 0x0203. Gate features on this (or on
   *  `capabilities`), never on `firmwareVersion`. */
  protocolVersion: number
  /** Capability bits (`CAP_*` constants). */
  capabilities: number
  /** Firmware version as reported. Current firmware sends a placeholder. */
  firmwareVersion: string
}

/** Options for `Pq1Device.connect`. */
export type Pq1DeviceConnectOptions = {
  /** Open this `HIDDevice` (or an object with the same shape, such as
   *  `FakePq1Device`). Otherwise the PQ1 this origin was already granted is
   *  used, or the browser's picker is shown (see `requestPermission`). */
  hidDevice?: HIDDevice
  /** Show the browser's device picker when no PQ1 is granted yet. Needs a
   *  user gesture on a page. Default true; pass false in a service worker. */
  requestPermission?: boolean
  /** Where to keep the init-code cache (see `Pq1Device.getInitCode`).
   *  Default in memory. In an extension, pass `chromeStorageCache()` so it
   *  survives service-worker restarts. */
  cache?: KeyValueStore
  logger?: Pq1Logger
}

/**
 * One open connection to a PQ1.
 *
 * PQ1 has no BIP-32 derivation: the device holds 256 numbered accounts, each
 * its own smart-contract wallet. Requests over one connection go one at a
 * time; keep a single `Pq1Device` per PQ1 (in an extension, in the service
 * worker) rather than opening one per page.
 */
export class Pq1Device {
  readonly transport: HidTransport

  readonly commands: DeviceCommands

  /** Called once if the PQ1 is unplugged while connected. */
  onDisconnect?: () => void

  private deviceId: string | null = null

  private readonly cache: KeyValueStore

  private readonly logger: Pq1Logger

  private constructor(transport: HidTransport, options: Pq1DeviceConnectOptions) {
    this.transport = transport
    this.commands = new DeviceCommands(transport)
    this.cache = options.cache ?? memoryStore()
    this.logger = options.logger ?? consoleLogger
    transport.onDisconnect = () => {
      this.deviceId = null
      this.onDisconnect?.()
    }
  }

  /** Open a PQ1 (see `Pq1DeviceConnectOptions`). Doesn't unlock it. */
  static async connect(options: Pq1DeviceConnectOptions = {}): Promise<Pq1Device> {
    const transport = new HidTransport()
    await transport.connect({
      device: options.hidDevice,
      requestPermission: options.requestPermission
    })
    return new Pq1Device(transport, options)
  }

  /** True while the USB connection is open. */
  isConnected(): boolean {
    return this.transport.isConnected()
  }

  /** Lock state and PIN attempts left. Works on a locked device. */
  getStatus(): Promise<DeviceStatus> {
    return this.commands.getStatus()
  }

  /**
   * Make sure the PQ1 is unlocked. If it's locked (it locks itself after two
   * minutes without use), the device asks for its PIN and this resolves once
   * the user has entered it. The PIN is typed on the device and never
   * crosses USB. A wrong or cancelled PIN throws a `rejected` error.
   */
  async unlock(): Promise<'already-unlocked' | 'unlocked'> {
    // GET_STATUS carries no `provisioned` flag (see DeviceStatus). A blank
    // device shows its first-boot wizard and refuses gated commands with
    // 0x6985 while reporting `locked: false`; the commands report that as
    // `refused`.
    if (!(await this.commands.getStatus()).locked) return 'already-unlocked'
    // INS_UNLOCK blocks until the user enters the PIN on the device (or
    // gives up). The transport timeout for this INS is 60 s.
    const sw = await this.commands.unlock()
    if (sw === SW_OK) return 'unlocked'
    // 0x6982 covers both "wrong PIN" and "user rejected the PIN prompt" —
    // either way it was an on-device decision, so surface it plainly and
    // never auto-retry.
    if (sw === SW_SECURITY_CONDITION) {
      throw new DeviceError('UNLOCK: PIN cancelled or wrong', sw, 'rejected')
    }
    throw new DeviceError(`UNLOCK refused: SW=0x${sw.toString(16).padStart(4, '0')}`, sw)
  }

  /**
   * A short id that tells two PQ1s apart: the first 6 bytes of its account
   * 0 address, as lowercase hex. Store it with each account and check it
   * before signing (the wallet facade does), so a different PQ1 is never
   * asked to sign for an account it doesn't own.
   *
   * GET_DEVICE_INFO can't provide one: its leading bytes are the protocol
   * version, a placeholder firmware version and a still-unset device UID,
   * the same on every PQ1. Account 0's wallet address is derived from the
   * device's own seed, so it tells two PQ1s apart.
   */
  async getDeviceId(): Promise<string> {
    if (!this.deviceId) {
      this.deviceId = toShortDeviceId(await this.commands.getWalletAddress(0))
    }
    return this.deviceId
  }

  /** Protocol version, capability bits and firmware version. */
  async getInfo(): Promise<Pq1DeviceInfo> {
    const raw = await this.commands.getDeviceInfo()
    return {
      protocolVersion: await this.commands.getProtocolVersion(),
      capabilities: await this.commands.getCapabilities(),
      firmwareVersion: raw.length >= 5 ? `${raw[2]}.${raw[3]}.${raw[4]}` : 'unknown'
    }
  }

  /** The address of account `index` (0-255). Derived on the device, so it
   *  needs no network. The first call after unlocking takes up to a second. */
  getAddress(index: number): Promise<`0x${string}`> {
    return this.commands.getWalletAddress(assertAccountIndex(index))
  }

  /** Show the address of account `index` on the device screen and wait for
   *  the user to confirm it matches what your wallet shows (protocol 0x0202
   *  and later; older firmware throws `outdated`). Resolves with the
   *  address; cancelling on the device throws `rejected`. Offer this before
   *  a user shares a receive address. */
  showAddress(index: number): Promise<`0x${string}`> {
    return this.commands.getWalletAddress(assertAccountIndex(index), { show: true })
  }

  /** `count` accounts from `start` (default: accounts 0-4). */
  async getAccounts(range: { start?: number; count?: number } = {}): Promise<Pq1Account[]> {
    const start = range.start ?? 0
    const count = range.count ?? 5
    if (!isAccountIndex(start) || count < 1 || !isAccountIndex(start + count - 1)) {
      throw new Pq1Error('invalid-request', `account range ${start}+${count} is outside 0-255`)
    }
    const deviceId = await this.getDeviceId()
    const accounts: Pq1Account[] = []
    // One at a time: the device handles one request at a time anyway.
    for (let index = start; index < start + count; index++) {
      accounts.push({ index, address: await this.commands.getWalletAddress(index), deviceId })
    }
    return accounts
  }

  /**
   * The factory init code that deploys account `index` on `chainId`, cached.
   *
   * Every GET_INIT_CODE makes the device sign with the wallet's bootstrap
   * key, a few-time signature key that can never be rotated (the wallet's
   * address depends on it), without asking the user. The firmware relies on
   * the host to cache the result until the wallet is deployed, so this keeps
   * it in the `cache` store as well as in memory.
   */
  async getInitCode(index: number, chainId: number): Promise<Uint8Array> {
    const key = `pq1:initCode:${await this.getDeviceId()}:${index}:${chainId}`
    let stored: string | undefined
    try {
      stored = await this.cache.get(key)
    } catch (e) {
      this.logger.warn('reading the init-code cache failed', e)
    }
    if (stored) return hexToBytes(stored as `0x${string}`)
    const initCode = await this.commands.getInitCode(index, chainId)
    try {
      await this.cache.set(key, bytesToHex0x(initCode))
    } catch (e) {
      this.logger.warn('writing the init-code cache failed', e)
    }
    return initCode
  }

  /** Close the connection. Never rejects. */
  async close(): Promise<void> {
    this.deviceId = null
    try {
      await this.transport.disconnect()
    } catch (e) {
      this.logger.warn('closing the PQ1 connection failed', e)
    }
  }
}

function assertAccountIndex(index: number): number {
  if (isAccountIndex(index)) return index
  throw userFacingError(
    'invalid-request',
    "This PQ1 account's saved details are damaged. Remove the account and add it again.",
    `account index ${String(index)} is outside 0-255`
  )
}

/** Lower-hex of the first 6 bytes of account 0's address — short, while
 *  still telling devices apart. */
function toShortDeviceId(account0Address: `0x${string}`): string {
  return account0Address.slice(2, 14).toLowerCase()
}
