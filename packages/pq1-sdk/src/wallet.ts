// `createPq1Wallet`: the high-level API most integrations need. It wires a
// connected PQ1, the chain, the bundler and the clear-signing catalogs
// together, checks that the right PQ1 signs for each account, and turns
// every failure into a `Pq1Error` with a message for the user.

import type { Pq1Bundler, UserOperationReceipt, UserOpFees } from './aa/bundler'
import {
  prepareTransaction,
  signPreparedTransaction,
  submitUserOperation,
  waitForUserOperationReceipt,
  type PreparedTransaction,
  type Pq1Call,
  type WaitForReceiptOptions
} from './aa/send'
import { PQ1_SUPPORTED_CHAIN_IDS } from './config'
import {
  createPq1Context,
  type CatalogSource,
  type Pq1Context,
  type Pq1Logger,
  type SafeTxService
} from './context'
import type { Pq1Account, Pq1Device } from './device'
import { isPq1Error, Pq1Error, toPq1Error } from './errors'
import {
  signPq1Message,
  signPq1TypedData,
  type Pq1SignableMessage,
  type Pq1TypedData,
  type SignOffchainContext
} from './messages'
import { createChainReader, type ChainReader, type RpcTransport } from './rpc'
import { DeviceError } from './transport/hid'

/** Options for `createPq1Wallet`. */
export interface Pq1WalletOptions {
  /** The PQ1 to use: a connected `Pq1Device`, or a function returning one
   *  (such as `() => manager.getDevice()`), called for every operation so
   *  a replugged device is picked up. */
  device: Pq1Device | (() => Promise<Pq1Device>)
  /** How to reach each chain: a JSON-RPC URL, an EIP-1193 `request`
   *  function or provider. A map or a function of the chain id. */
  rpc: Record<number, RpcTransport> | ((chainId: number) => RpcTransport | undefined)
  /** The ERC-4337 bundler (EntryPoint v0.6). Needed to send transactions;
   *  see `pimlicoBundler`. */
  bundler?: Pq1Bundler
  /** Where the clear-signing catalogs come from (see `pq1-sdk-catalogs`).
   *  Without them the device shows raw addresses, amounts and function
   *  selectors, and refuses calls it knows must be clear-signed. */
  catalogs?: CatalogSource
  /** Safe Transaction Service client (see `safeTransactionService`). Needed
   *  for Safe `approveHash` calls, which are refused without it. */
  safeTxService?: SafeTxService
  /** CoW orderbook API per chain; defaults to api.cow.fi on Ethereum and
   *  Base. */
  cowApiUrl?: (chainId: number) => string | undefined
  /** Where to report recoverable problems and unexpected errors. Default
   *  `console`. */
  logger?: Pq1Logger
  fetch?: typeof fetch
  /** Chains to allow. Default `PQ1_SUPPORTED_CHAIN_IDS`. */
  chains?: readonly number[]
}

/** Which account to act for: a `Pq1Account` from `getAccounts`, as you
 *  stored it. */
export type AccountRef = Pick<Pq1Account, 'index' | 'address'> & { deviceId?: string }

/** The high-level PQ1 API. Every method throws `Pq1Error`. */
export interface Pq1Wallet {
  /** The context the lower-level functions take. */
  readonly context: Pq1Context
  /** The chains this wallet allows. */
  readonly chains: readonly number[]
  /** The connected PQ1, unlocked (the user may be asked for the PIN). */
  getDevice(): Promise<Pq1Device>
  /** Accounts on the connected PQ1 (default 0-4), with its `deviceId`. */
  getAccounts(range?: { start?: number; count?: number }): Promise<Pq1Account[]>
  /** Show `account`'s address on the device for the user to compare. */
  showAddress(account: AccountRef): Promise<`0x${string}`>
  /** Build a transaction and its fee, without signing it. Show
   *  `prepared.fee.maxCost` to the user, then call `sendPrepared`. Needs
   *  the PQ1 only for an account's first transaction (for the init code
   *  that deploys it). */
  prepareTransaction(args: {
    account: AccountRef
    chainId: number
    calls: readonly Pq1Call[]
    fee?: UserOpFees
  }): Promise<PreparedTransaction>
  /** Have the device sign a prepared transaction and hand it to the
   *  bundler. Resolves with the UserOp hash once the bundler accepts it. */
  sendPrepared(
    prepared: PreparedTransaction,
    account: AccountRef
  ): Promise<{ userOpHash: `0x${string}`; chainId: number }>
  /** `prepareTransaction` + `sendPrepared`, for when you don't need to show
   *  the fee first. */
  sendTransaction(args: {
    account: AccountRef
    chainId: number
    calls: readonly Pq1Call[]
    fee?: UserOpFees
  }): Promise<{ userOpHash: `0x${string}`; chainId: number; prepared: PreparedTransaction }>
  /** Wait until a sent UserOp is included. `receipt.transactionHash` is the
   *  hash dapps expect from `eth_sendTransaction`. */
  waitForReceipt(
    args: { chainId: number; userOpHash: `0x${string}` } & WaitForReceiptOptions
  ): Promise<UserOperationReceipt>
  /** `personal_sign`: an ERC-1271 (or, undeployed, ERC-6492) signature. */
  signMessage(args: {
    account: AccountRef
    chainId: number
    message: Pq1SignableMessage
  }): Promise<`0x${string}`>
  /** `eth_signTypedData_v4`: an ERC-1271 (or ERC-6492) signature. */
  signTypedData(args: {
    account: AccountRef
    chainId: number
    typedData: Pq1TypedData
  }): Promise<`0x${string}`>
  /** Whether `address` has code (is deployed) on `chainId`. */
  isDeployed(args: { address: `0x${string}`; chainId: number }): Promise<boolean>
  /** The chain reader for `chainId`. */
  chain(chainId: number): ChainReader
}

/**
 * Create the high-level PQ1 API.
 *
 * ```ts
 * const pq1 = createPq1Wallet({
 *   device: () => manager.getDevice(),
 *   rpc: { 8453: 'https://mainnet.base.org' },
 *   bundler: pimlicoBundler({ apiKey }),
 *   catalogs: extensionCatalogs('pq1/'),
 * })
 * ```
 */
export function createPq1Wallet(options: Pq1WalletOptions): Pq1Wallet {
  const context = createPq1Context(options)
  const chains = options.chains ?? PQ1_SUPPORTED_CHAIN_IDS
  const readers = new Map<number, ChainReader>()
  // Account addresses this wallet has checked against the device, keyed by
  // `${deviceId}:${index}`.
  const verifiedAddresses = new Map<string, `0x${string}`>()

  function chain(chainId: number): ChainReader {
    let reader = readers.get(chainId)
    if (reader) return reader
    if (!chains.includes(chainId)) {
      throw new Pq1Error('unsupported-network', `chain ${chainId} is not enabled for this wallet`)
    }
    const transport =
      typeof options.rpc === 'function' ? options.rpc(chainId) : options.rpc[chainId]
    if (!transport)
      throw new Pq1Error('unsupported-network', `no RPC configured for chain ${chainId}`)
    reader = createChainReader(chainId, transport, { fetch: context.fetch })
    readers.set(chainId, reader)
    return reader
  }

  async function getDevice(): Promise<Pq1Device> {
    const device = typeof options.device === 'function' ? await options.device() : options.device
    await device.unlock()
    return device
  }

  /** The device, checked to be the one `account` belongs to. */
  async function deviceFor(account: AccountRef): Promise<Pq1Device> {
    const device = await getDevice()
    const deviceId = await device.getDeviceId()
    // Another PQ1 would sign with its own keys for the same account number,
    // producing a signature that fails verification.
    if (account.deviceId && account.deviceId !== deviceId) {
      throw new Pq1Error(
        'wrong-device',
        `account belongs to PQ1 ${account.deviceId}, connected PQ1 is ${deviceId}`
      )
    }
    const key = `${deviceId}:${account.index}`
    let address = verifiedAddresses.get(key)
    if (!address) {
      address = await device.getAddress(account.index)
      verifiedAddresses.set(key, address)
    }
    if (address.toLowerCase() !== account.address.toLowerCase()) {
      throw new Pq1Error(
        'wrong-device',
        `connected PQ1's account ${account.index} is ${address}, not ${account.address}`
      )
    }
    return device
  }

  /** Run a device operation with one automatic recovery pass: if the
   *  firmware idle-locks (2-minute timeout) between the pre-flight check and
   *  the command, the op fails with a typed 'locked' DeviceError *before*
   *  anything was signed — so the unlock flow runs again (the device asks
   *  for the PIN) and the operation is replayed once. Deliberate on-device
   *  rejections carry code 'rejected' and are never retried. */
  async function withDevice<T>(
    account: AccountRef,
    run: (device: Pq1Device) => Promise<T>
  ): Promise<T> {
    try {
      const device = await deviceFor(account)
      try {
        return await run(device)
      } catch (e) {
        if (!(e instanceof DeviceError) || e.code !== 'locked') throw e
        return await run(await deviceFor(account))
      }
    } catch (e) {
      throw report(e)
    }
  }

  /** Every error leaves as a `Pq1Error`; unexpected ones are reported. */
  function report(e: unknown): Pq1Error {
    if (isPq1Error(e) && e.code !== 'device-protocol' && e.code !== 'unknown') return e
    context.logger.error(e)
    return toPq1Error(e)
  }

  function offchainContext(
    device: Pq1Device,
    account: AccountRef,
    chainId: number
  ): SignOffchainContext {
    return {
      ctx: context,
      device: device.commands,
      chain: chain(chainId),
      accountIndex: account.index,
      sender: account.address,
      supportedChainIds: chains
    }
  }

  function requireBundler(): Pq1Bundler {
    if (options.bundler) return options.bundler
    throw new Pq1Error(
      'invalid-request',
      'no bundler configured (pass `bundler` to createPq1Wallet)'
    )
  }

  async function prepare(args: {
    account: AccountRef
    chainId: number
    calls: readonly Pq1Call[]
    fee?: UserOpFees
  }): Promise<PreparedTransaction> {
    try {
      const bundler = requireBundler()
      return await prepareTransaction({
        chain: chain(args.chainId),
        bundler,
        // The device is only needed for a first deployment's init code, so a
        // deployed account's fee can be shown before the PQ1 is plugged in.
        device: {
          getInitCode: async (index, chainId) =>
            (await deviceFor(args.account)).getInitCode(index, Number(chainId))
        },
        logger: context.logger,
        accountIndex: args.account.index,
        sender: args.account.address,
        calls: args.calls,
        fee: args.fee,
        supportedChainIds: chains
      })
    } catch (e) {
      throw report(e)
    }
  }

  async function sendPrepared(prepared: PreparedTransaction, account: AccountRef) {
    const bundler = requireBundler()
    if (account.address.toLowerCase() !== prepared.sender.toLowerCase()) {
      throw new Pq1Error('invalid-request', 'prepared transaction belongs to another account')
    }
    // A 'locked' replay is safe: a 'locked' error can only come from the
    // device, before the UserOp is handed to the bundler.
    const op = await withDevice(account, (device) =>
      signPreparedTransaction({ ctx: context, device: device.commands, prepared })
    )
    try {
      const userOpHash = await submitUserOperation(bundler, prepared.chainId, op)
      return { userOpHash, chainId: prepared.chainId }
    } catch (e) {
      throw report(e)
    }
  }

  return {
    context,
    chains,
    chain,
    async getDevice() {
      try {
        return await getDevice()
      } catch (e) {
        throw report(e)
      }
    },
    async getAccounts(range) {
      try {
        return await (await getDevice()).getAccounts(range)
      } catch (e) {
        throw report(e)
      }
    },
    showAddress: (account) => withDevice(account, (device) => device.showAddress(account.index)),
    prepareTransaction: prepare,
    sendPrepared,
    async sendTransaction(args) {
      const prepared = await prepare(args)
      return { ...(await sendPrepared(prepared, args.account)), prepared }
    },
    async waitForReceipt({ chainId, userOpHash, ...waitOptions }) {
      try {
        return await waitForUserOperationReceipt(requireBundler(), chainId, userOpHash, waitOptions)
      } catch (e) {
        throw report(e)
      }
    },
    signMessage: ({ account, chainId, message }) =>
      withDevice(account, (device) =>
        signPq1Message(offchainContext(device, account, chainId), message)
      ),
    signTypedData: ({ account, chainId, typedData }) =>
      withDevice(account, (device) =>
        signPq1TypedData(offchainContext(device, account, chainId), typedData)
      ),
    async isDeployed({ address, chainId }) {
      try {
        const code = await chain(chainId).getCode(address)
        return code !== '0x' && code.length > 2
      } catch (e) {
        throw report(e)
      }
    }
  }
}
