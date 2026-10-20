// Dapp-facing (EIP-1193 / EIP-5792) answers for PQ1 accounts, for wallets
// that serve dapps.
//
// PQ1 accounts are smart-contract wallets at the same CREATE2 address on
// every PQ1 chain. A few dapp-facing answers must say so:
//
//   - `eth_getCode`: dapps tell a smart-contract wallet from an EOA by
//     whether its code is empty, and a wallet not deployed on the dapp's
//     chain yet has none. See `resolvePq1AccountCode`.
//   - `wallet_getCapabilities`: every PQ1 wallet runs up to 4 calls
//     atomically in one UserOp. See `buildPq1Capabilities`.
//   - `wallet_sendCalls` / `wallet_getCallsStatus` / `eth_sendTransaction`:
//     see `callsFromSendCalls`, `callsFromTransaction`, `buildCallsStatus`.

import type { UserOperationReceipt } from '../aa/bundler'
import type { Pq1Call } from '../aa/send'
import { MAX_BATCH_TXS, PQ1_SUPPORTED_CHAIN_IDS } from '../config'
import { Pq1Error } from '../errors'
import type { Eip1193Request } from '../rpc'

/** Non-empty `eth_getCode` answer for a connected PQ1 account that isn't
 *  deployed on the dapp's chain yet (counterfactual CREATE2 address). A
 *  single INVALID opcode (0xfe) is enough for dapps to treat it as the
 *  smart-contract wallet its first transaction deploys. */
export const PQ1_UNDEPLOYED_ACCOUNT_CODE = '0xfe'

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const isLatestBlockTag = (blockTag: unknown) =>
  blockTag === undefined || blockTag === null || blockTag === 'latest' || blockTag === 'pending'

/**
 * True when `eth_getCode` for `address` on `chainId` should get the PQ1
 * answer (`resolvePq1AccountCode`): `address` is a PQ1 account among the
 * accounts the dapp is connected to, on a PQ1 chain. Send every other query
 * to the chain unchanged, so the answer tells a site nothing about accounts
 * it isn't connected to.
 */
export function isPq1AccountCodeQuery(args: {
  address: string
  chainId: number
  /** Accounts this dapp is connected to. */
  connectedAccounts: readonly string[]
  /** Addresses of the user's PQ1 accounts. */
  pq1Accounts: readonly string[]
  chains?: readonly number[]
}): boolean {
  const chains = args.chains ?? PQ1_SUPPORTED_CHAIN_IDS
  return (
    chains.includes(args.chainId) &&
    args.connectedAccounts.some((a) => sameAddress(a, args.address)) &&
    args.pq1Accounts.some((a) => sameAddress(a, args.address))
  )
}

/**
 * `eth_getCode` for a connected PQ1 account (see `isPq1AccountCodeQuery`):
 *   - a query at a past block goes to the chain unchanged, since chain state
 *     at a past block must never be made up;
 *   - otherwise the chain's code, when the wallet is deployed there;
 *   - when it isn't yet, the one-byte stub (`PQ1_UNDEPLOYED_ACCOUNT_CODE`),
 *     so dapps choose their smart-contract-wallet flows for it. Until it is
 *     deployed, its signatures are ERC-6492 ones, which a dapp that follows
 *     ERC-6492 verifies whatever `eth_getCode` said.
 */
export async function resolvePq1AccountCode(
  request: Eip1193Request,
  params: readonly [string, ...unknown[]]
): Promise<`0x${string}`> {
  const [, blockTag] = params
  if (!isLatestBlockTag(blockTag)) {
    return (await request({ method: 'eth_getCode', params: [...params] })) as `0x${string}`
  }
  try {
    const code = (await request({ method: 'eth_getCode', params: [...params] })) as string
    if (code && code !== '0x') return code as `0x${string}`
  } catch {
    // A connected PQ1 account is a smart-contract wallet whatever this read
    // says, so a failed read gets the stub instead of failing the dapp's
    // request.
  }
  return PQ1_UNDEPLOYED_ACCOUNT_CODE
}

/** One chain's entry in a `wallet_getCapabilities` answer. */
export type Pq1ChainCapabilities = {
  atomic: { status: 'supported' | 'unsupported' }
  /** The pre-standard name some dapps still read. */
  atomicBatch: { supported: boolean }
  paymasterService: { supported: false }
  auxiliaryFunds: { supported: false }
}

/**
 * EIP-5792 `wallet_getCapabilities` answer for a PQ1 account: atomic
 * batching on every PQ1 chain, nothing else (no paymaster: a PQ1 account
 * always pays its own fee in the native token). Keys are hex chain ids.
 */
export function buildPq1Capabilities(
  chainIds: readonly number[],
  chains: readonly number[] = PQ1_SUPPORTED_CHAIN_IDS
): Record<`0x${string}`, Pq1ChainCapabilities> {
  const capabilities: Record<`0x${string}`, Pq1ChainCapabilities> = {}
  for (const chainId of chainIds) {
    const supported = chains.includes(chainId)
    capabilities[`0x${chainId.toString(16)}`] = {
      atomic: { status: supported ? 'supported' : 'unsupported' },
      atomicBatch: { supported },
      paymasterService: { supported: false },
      auxiliaryFunds: { supported: false }
    }
  }
  return capabilities
}

/** A call as EIP-5792 `wallet_sendCalls` and `eth_sendTransaction` pass it. */
export type RpcCall = { to?: string | null; value?: string | null; data?: string | null }

function toPq1Call(call: RpcCall, index: number): Pq1Call {
  if (!call.to) {
    throw new Pq1Error(
      'invalid-request',
      `call ${index} has no \`to\` (contract creation), which PQ1 accounts can't do`,
      { userMessage: "PQ1 accounts can't deploy contracts directly. Nothing was signed or sent." }
    )
  }
  return {
    to: call.to as `0x${string}`,
    value: call.value ? BigInt(call.value) : 0n,
    data: (call.data ?? '0x') as `0x${string}`
  }
}

/** The calls of an `eth_sendTransaction` request. Checks `from` against
 *  `account` when given. */
export function callsFromTransaction(tx: RpcCall & { from?: string }, account?: string): Pq1Call[] {
  if (account && tx.from && !sameAddress(tx.from, account)) {
    throw new Pq1Error('invalid-request', `from ${tx.from} is not the PQ1 account ${account}`)
  }
  return [toPq1Call(tx, 0)]
}

/** The `wallet_sendCalls` (EIP-5792 v2) parameters the SDK reads. */
export type SendCallsParams = {
  version?: string
  chainId: `0x${string}`
  from?: string
  calls: readonly RpcCall[]
  atomicRequired?: boolean
  capabilities?: Record<string, unknown>
}

/** The calls and chain of a `wallet_sendCalls` request. PQ1 batches are
 *  always atomic, so `atomicRequired` is always satisfied. More calls than
 *  one PQ1 signature covers are refused (EIP-5792 code 5740 territory: tell
 *  the dapp the batch is too large). */
export function callsFromSendCalls(
  params: SendCallsParams,
  account?: string
): { chainId: number; calls: Pq1Call[] } {
  if (account && params.from && !sameAddress(params.from, account)) {
    throw new Pq1Error('invalid-request', `from ${params.from} is not the PQ1 account ${account}`)
  }
  if (params.calls.length === 0)
    throw new Pq1Error('invalid-request', 'wallet_sendCalls with no calls')
  if (params.calls.length > MAX_BATCH_TXS) {
    throw new Pq1Error('too-large', `${params.calls.length} calls > ${MAX_BATCH_TXS}`, {
      userMessage: `A PQ1 can approve up to ${MAX_BATCH_TXS} actions in one transaction, and this request has ${params.calls.length}. Try again in smaller parts.`
    })
  }
  return { chainId: Number(BigInt(params.chainId)), calls: params.calls.map(toPq1Call) }
}

/** EIP-5792 `wallet_getCallsStatus` answer. */
export type CallsStatus = {
  version: '2.0.0'
  id: string
  chainId: `0x${string}`
  /** 100 pending, 200 confirmed, 500 reverted on-chain. */
  status: 100 | 200 | 500
  atomic: true
  receipts?: {
    logs: unknown[]
    status: '0x1' | '0x0'
    blockHash: `0x${string}`
    blockNumber: `0x${string}`
    gasUsed: `0x${string}`
    transactionHash: `0x${string}`
  }[]
}

/**
 * The `wallet_getCallsStatus` answer for a batch sent as one UserOp: `id` is
 * what you returned from `wallet_sendCalls` (the UserOp hash works well),
 * `receipt` the bundler's receipt or null while pending.
 *
 * A bundle transaction can hold other UserOps, so the receipt's logs are
 * filtered to the ones the bundler attributes to this UserOp (its `logs`
 * field), not the whole transaction's.
 */
export function buildCallsStatus(args: {
  id: string
  chainId: number
  receipt: UserOperationReceipt | null
}): CallsStatus {
  const base = {
    version: '2.0.0',
    id: args.id,
    chainId: `0x${args.chainId.toString(16)}`,
    atomic: true
  } as const
  if (!args.receipt) return { ...base, status: 100 }
  const { raw } = args.receipt
  const txReceipt = (raw.receipt ?? {}) as Record<string, unknown>
  return {
    ...base,
    status: args.receipt.success ? 200 : 500,
    receipts: [
      {
        logs: Array.isArray(raw.logs) ? raw.logs : [],
        status: args.receipt.success ? '0x1' : '0x0',
        blockHash: (txReceipt.blockHash ?? '0x') as `0x${string}`,
        blockNumber: `0x${args.receipt.blockNumber.toString(16)}`,
        gasUsed: (raw.actualGasUsed ?? txReceipt.gasUsed ?? '0x0') as `0x${string}`,
        transactionHash: args.receipt.transactionHash
      }
    ]
  }
}
