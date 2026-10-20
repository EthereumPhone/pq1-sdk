// The ERC-4337 bundler a PQ1 wallet sends its UserOps through. PQ1 wallets
// use EntryPoint v0.6, so the bundler must serve v0.6 and accept a state
// override as the third parameter of `eth_estimateUserOperationGas` (used to
// stub the SPHINCS+ verifier during estimation, see `send.ts`). Pimlico does
// both; `pimlicoBundler` is the ready-made client.

import { ENTRY_POINT_V06, pimlicoBundlerUrl } from '../config'
import { Pq1Error } from '../errors'
import { HttpError, fetchJson, redactUrl } from '../utils/fetchJson'
import type { UserOpGasEstimate, UserOpJson } from './userop'

/** How long to wait for the bundler. */
const BUNDLER_TIMEOUT_MS = 30_000

/** eth_call-style state-override set passed as the optional 3rd param of
 *  `eth_estimateUserOperationGas`. Keyed by address; the SDK only ever sets
 *  `code`, but the full shape is allowed for completeness. */
export type StateOverride = Record<
  `0x${string}`,
  {
    code?: string
    balance?: string
    nonce?: string
    state?: Record<string, string>
    stateDiff?: Record<string, string>
  }
>

/** Fee per gas for a UserOp, in wei. */
export type UserOpFees = {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/** The parts of `eth_getUserOperationReceipt` the SDK reads. */
export type UserOperationReceipt = {
  userOpHash: `0x${string}`
  /** Whether the calls succeeded. A UserOp can be included and still revert. */
  success: boolean
  /** The fee paid, in wei. */
  actualGasCost: bigint
  /** Hash of the transaction the bundler put the UserOp in. */
  transactionHash: `0x${string}`
  blockNumber: bigint
  /** The full JSON the bundler returned, for anything else you need. */
  raw: Record<string, unknown>
}

/**
 * What the SDK needs from a bundler. Every method takes the chain, so one
 * client can serve all PQ1 networks. Throw `BundlerError` for a JSON-RPC
 * error answer; any other error from `estimateUserOperationGas` counts as
 * "unreachable" and from `sendUserOperation` as "unconfirmed".
 */
export interface Pq1Bundler {
  estimateUserOperationGas(
    chainId: number,
    op: UserOpJson,
    stateOverride?: StateOverride
  ): Promise<UserOpGasEstimate>
  /** Resolves with the UserOp hash once the bundler accepts `op`. */
  sendUserOperation(chainId: number, op: UserOpJson): Promise<`0x${string}`>
  /** The receipt, or null while the UserOp isn't included yet. */
  getUserOperationReceipt(
    chainId: number,
    userOpHash: `0x${string}`
  ): Promise<UserOperationReceipt | null>
  /** Fees this bundler will accept. Optional: without it the SDK asks the
   *  chain (`eth_maxPriorityFeePerGas` and the latest base fee). */
  getGasPrice?(chainId: number): Promise<UserOpFees>
}

/** A JSON-RPC error answer from the bundler. `message` is the bundler's own
 *  (for example "AA21 didn't pay prefund"); `userMessage` explains the
 *  common ones in plain words. */
export class BundlerError extends Pq1Error {
  /** The JSON-RPC error code. */
  readonly rpcCode: number

  readonly data: unknown

  constructor(rpcCode: number, message: string, data?: unknown) {
    super('bundler-rejected', message, { userMessage: describeBundlerError(message) })
    this.name = 'BundlerError'
    this.rpcCode = rpcCode
    this.data = data
  }
}

/** Plain words for the bundler errors users run into most, or undefined.
 *  ERC-4337 error messages start with a code such as `AA21`. */
export function describeBundlerError(message: string): string | undefined {
  if (message.includes('AA21')) {
    return "This account doesn't have enough ETH to pay the network fee. Add some ETH to it and try again. Nothing was sent."
  }
  if (message.includes('AA25')) {
    return 'Another transaction from this account is still being processed. Wait for it to finish, then try again. Nothing was sent.'
  }
  return undefined
}

/** Options for `erc4337Bundler`. */
export interface Erc4337BundlerOptions {
  /** The bundler's JSON-RPC URL for a chain. Return undefined for chains it
   *  doesn't serve. */
  url: (chainId: number) => string | undefined
  fetch?: typeof fetch
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number
}

/** A `Pq1Bundler` for any ERC-4337 v0.6 bundler that supports a state
 *  override on `eth_estimateUserOperationGas`. */
export function erc4337Bundler(options: Erc4337BundlerOptions): Pq1Bundler & {
  /** Raw JSON-RPC call to the bundler of `chainId`. */
  request<T>(chainId: number, method: string, params: unknown[]): Promise<T>
} {
  let nextId = 1
  const timeoutMs = options.timeoutMs ?? BUNDLER_TIMEOUT_MS

  async function request<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
    const url = options.url(chainId)
    if (!url)
      throw new Pq1Error('unsupported-network', `no bundler configured for chain ${chainId}`)
    let body: { result?: T; error?: { code: number; message: string; data?: unknown } }
    try {
      body = (await fetchJson(url, {
        body: { jsonrpc: '2.0', id: nextId++, method, params },
        timeoutMs,
        fetch: options.fetch
      })) as typeof body
    } catch (e) {
      // An HTTP error status is an answer; a timeout or network failure is not.
      if (e instanceof HttpError) {
        throw new BundlerError(-32603, `HTTP ${e.status} from the bundler: ${e.body.slice(0, 200)}`)
      }
      throw new Error(`${method}: no answer from the bundler at ${redactUrl(url)} (${String(e)})`)
    }
    if (body.error) throw new BundlerError(body.error.code, body.error.message, body.error.data)
    if (body.result === undefined) throw new BundlerError(-32603, 'empty bundler response')
    return body.result
  }

  return {
    request,
    estimateUserOperationGas(chainId, op, stateOverride) {
      const params: unknown[] = [op, ENTRY_POINT_V06]
      if (stateOverride) params.push(stateOverride)
      return request<UserOpGasEstimate>(chainId, 'eth_estimateUserOperationGas', params)
    },
    sendUserOperation(chainId, op) {
      return request<`0x${string}`>(chainId, 'eth_sendUserOperation', [op, ENTRY_POINT_V06])
    },
    async getUserOperationReceipt(chainId, userOpHash) {
      const raw = await request<Record<string, unknown> | null>(
        chainId,
        'eth_getUserOperationReceipt',
        [userOpHash]
      ).catch((e: unknown) => {
        // Some bundlers answer "not found" with an error instead of null.
        if (e instanceof BundlerError) return null
        throw e
      })
      return raw ? parseReceipt(userOpHash, raw) : null
    }
  }
}

/** Options for `pimlicoBundler`. */
export interface PimlicoBundlerOptions {
  /** Your Pimlico API key (https://dashboard.pimlico.io). */
  apiKey: string
  fetch?: typeof fetch
  /** Which of Pimlico's gas price tiers to use. Default `fast`. */
  gasPriceTier?: 'slow' | 'standard' | 'fast'
}

/** A `Pq1Bundler` for Pimlico, including its gas price endpoint
 *  (`pimlico_getUserOperationGasPrice`). Pimlico serves every PQ1 network. */
export function pimlicoBundler(options: PimlicoBundlerOptions): Pq1Bundler {
  const base = erc4337Bundler({
    url: (chainId) => pimlicoBundlerUrl(chainId, options.apiKey),
    fetch: options.fetch
  })
  const tier = options.gasPriceTier ?? 'fast'
  return {
    estimateUserOperationGas: base.estimateUserOperationGas,
    sendUserOperation: base.sendUserOperation,
    getUserOperationReceipt: base.getUserOperationReceipt,
    async getGasPrice(chainId) {
      const tiers = await base.request<
        Record<string, { maxFeePerGas: string; maxPriorityFeePerGas: string }>
      >(chainId, 'pimlico_getUserOperationGasPrice', [])
      const chosen = tiers[tier]
      if (!chosen) throw new Error(`Pimlico returned no "${tier}" gas price`)
      return {
        maxFeePerGas: BigInt(chosen.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(chosen.maxPriorityFeePerGas)
      }
    }
  }
}

function parseReceipt(
  userOpHash: `0x${string}`,
  raw: Record<string, unknown>
): UserOperationReceipt {
  const receipt = (raw.receipt ?? {}) as Record<string, unknown>
  const transactionHash = receipt.transactionHash
  if (typeof transactionHash !== 'string') {
    throw new Error('eth_getUserOperationReceipt: answer has no receipt.transactionHash')
  }
  return {
    userOpHash,
    success: raw.success === true,
    actualGasCost: BigInt((raw.actualGasCost as string | undefined) ?? 0),
    transactionHash: transactionHash as `0x${string}`,
    blockNumber: BigInt((receipt.blockNumber as string | undefined) ?? 0),
    raw
  }
}
