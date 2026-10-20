// Read a Safe transaction from the Safe Transaction Service, for the bundle
// that lets the device show a Safe `approveHash` (see `safeV1Trailer.ts`).
// Nothing read here is trusted: the transaction is hashed and checked
// against the hash being approved, by the SDK and again by the device.

import { isAddress, isHex, zeroAddress } from 'viem'

import type { Pq1Context, SafeTxService } from '../context'
import { fetchJson } from '../utils/fetchJson'

const SAFE_API_TIMEOUT_MS = 15_000

/** Short names the Safe Transaction Service uses in its URLs, for the PQ1
 *  networks. */
const SAFE_TX_SERVICE_SHORT_NAMES: Record<number, string> = {
  1: 'eth',
  8453: 'base',
  84532: 'basesep'
}

/** Options for `safeTransactionService`. */
export interface SafeTransactionServiceOptions {
  /** API key from https://developer.safe.global. `api.safe.global` refuses
   *  requests without one. */
  apiKey?: string
  /** URL of the service for a chain, ending in `/api`. Defaults to
   *  `https://api.safe.global/tx-service/<shortName>/api`. */
  baseUrl?: (chainId: number) => string | undefined
  fetch?: typeof fetch
}

/** A `SafeTxService` that reads the official Safe Transaction Service (or
 *  your own deployment of it, via `baseUrl`). */
export function safeTransactionService(options: SafeTransactionServiceOptions = {}): SafeTxService {
  const baseUrl =
    options.baseUrl ??
    ((chainId: number) => {
      const shortName = SAFE_TX_SERVICE_SHORT_NAMES[chainId]
      return shortName ? `https://api.safe.global/tx-service/${shortName}/api` : undefined
    })
  return {
    async getTransaction(chainId, safeTxHash) {
      const base = baseUrl(chainId)
      if (!base) throw new Error(`no Safe Transaction Service for chain ${chainId}`)
      const headers: Record<string, string> = { accept: 'application/json' }
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
      return fetchJson(`${base}/v2/multisig-transactions/${safeTxHash}/`, {
        headers,
        timeoutMs: SAFE_API_TIMEOUT_MS,
        fetch: options.fetch
      })
    }
  }
}

type SafeMultisigTransactionResponse = Record<string, unknown>

/** The fields of a Safe transaction the bundle needs. The API returns u256
 *  values as decimal strings and addresses as 0x-prefixed hex. */
export interface SafeTxFields {
  to: `0x${string}`
  value: bigint
  data: `0x${string}`
  operation: number
  safeTxGas: bigint
  baseGas: bigint
  gasPrice: bigint
  gasToken: `0x${string}`
  refundReceiver: `0x${string}`
  nonce: bigint
  safeTxHash: `0x${string}`
}

/** Fetch the Safe transaction `safeTxHash` on `chainId` through
 *  `ctx.safeTxService`. Throws when there is no service, it fails, or the
 *  answer isn't a well-formed Safe transaction. */
export async function fetchSafeTx(
  ctx: Pick<Pq1Context, 'safeTxService'>,
  chainId: number | bigint,
  safeTxHash: `0x${string}`
): Promise<SafeTxFields> {
  if (!ctx.safeTxService) {
    throw new Error(
      'no Safe Transaction Service configured (pass `safeTxService` to createPq1Wallet)'
    )
  }
  let raw: unknown
  try {
    raw = await ctx.safeTxService.getTransaction(Number(chainId), safeTxHash)
  } catch (e) {
    throw new Error(
      `Safe Transaction Service GET ${safeTxHash} failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Safe Transaction Service answer is not an object')
  }
  return parseSafeTx(raw as SafeMultisigTransactionResponse)
}

function parseSafeTx(t: SafeMultisigTransactionResponse): SafeTxFields {
  return {
    to: ensureAddress(t.to, 'to'),
    value: parseU256(t.value, 'value'),
    data: ensureHex(t.data ?? '0x', 'data'),
    operation: ensureOperation(t.operation),
    safeTxGas: parseU256(t.safeTxGas, 'safeTxGas'),
    baseGas: parseU256(t.baseGas, 'baseGas'),
    gasPrice: parseU256(t.gasPrice, 'gasPrice'),
    gasToken: ensureAddress(t.gasToken, 'gasToken'),
    refundReceiver: t.refundReceiver
      ? ensureAddress(t.refundReceiver, 'refundReceiver')
      : zeroAddress,
    nonce: parseU256(t.nonce, 'nonce'),
    safeTxHash: ensureBytes32(t.safeTxHash, 'safeTxHash')
  }
}

function ensureAddress(v: unknown, name: string): `0x${string}` {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) {
    throw new Error(`${name}: not an address: ${String(v).slice(0, 60)}`)
  }
  return v.toLowerCase() as `0x${string}`
}

function ensureBytes32(v: unknown, name: string): `0x${string}` {
  if (typeof v !== 'string' || !isHex(v, { strict: true }) || v.length !== 2 + 64) {
    throw new Error(`${name}: not a bytes32: ${String(v).slice(0, 80)}`)
  }
  return v.toLowerCase() as `0x${string}`
}

function ensureHex(v: unknown, name: string): `0x${string}` {
  if (typeof v !== 'string' || !isHex(v, { strict: true }) || v.length % 2 !== 0) {
    throw new Error(`${name}: not hex bytes`)
  }
  return v.toLowerCase() as `0x${string}`
}

function parseU256(v: unknown, name: string): bigint {
  if (typeof v === 'number') return BigInt(v)
  if (typeof v !== 'string') throw new Error(`${name}: expected u256 string, got ${typeof v}`)
  try {
    return BigInt(v)
  } catch {
    throw new Error(`${name}: not a u256 string: ${v}`)
  }
}

function ensureOperation(v: unknown): number {
  if (v !== 0 && v !== 1) throw new Error(`operation: expected 0 or 1, got ${String(v)}`)
  return v
}
