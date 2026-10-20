// Chain reads. The SDK only needs `eth_getCode`, `eth_call` and, when it
// picks fees itself, the latest block and `eth_maxPriorityFeePerGas`. Give it
// a JSON-RPC URL, or the `request` function of any EIP-1193 provider you
// already have (viem client, ethers `BrowserProvider`, your own).

import { Pq1Error } from './errors'
import { fetchJson, redactUrl } from './utils/fetchJson'

/** An EIP-1193 `request` function. */
export type Eip1193Request = (args: { method: string; params?: unknown[] }) => Promise<unknown>

/** How to reach a chain: a JSON-RPC URL, an EIP-1193 `request` function, or
 *  an object with one (a viem client or an EIP-1193 provider). */
export type RpcTransport = string | Eip1193Request | { request: Eip1193Request }

/** The chain reads the SDK makes. */
export interface ChainReader {
  readonly chainId: number
  /** Any JSON-RPC call. Errors become `Pq1Error` with code `rpc`. */
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>
  getCode(address: `0x${string}`): Promise<`0x${string}`>
  call(tx: { to: `0x${string}`; data: `0x${string}` }): Promise<`0x${string}`>
}

const RPC_TIMEOUT_MS = 20_000

/** An EIP-1193 `request` function that POSTs to a JSON-RPC `url`. */
export function httpRpc(
  url: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Eip1193Request {
  let nextId = 1
  return async ({ method, params }) => {
    const body = (await fetchJson(url, {
      body: { jsonrpc: '2.0', id: nextId++, method, params: params ?? [] },
      timeoutMs: options.timeoutMs ?? RPC_TIMEOUT_MS,
      fetch: options.fetch
    })) as { result?: unknown; error?: { code: number; message: string } }
    if (body.error) {
      throw new Error(
        `${method} failed at ${redactUrl(url)}: ${body.error.message} (${body.error.code})`
      )
    }
    return body.result
  }
}

/** A `ChainReader` for `chainId` over `rpc`. */
export function createChainReader(
  chainId: number,
  rpc: RpcTransport,
  options: { fetch?: typeof fetch } = {}
): ChainReader {
  const send: Eip1193Request =
    typeof rpc === 'string'
      ? httpRpc(rpc, options)
      : typeof rpc === 'function'
        ? rpc
        : (args) => rpc.request(args)

  async function request<T>(method: string, params: unknown[] = []): Promise<T> {
    try {
      return (await send({ method, params })) as T
    } catch (e) {
      throw new Pq1Error('rpc', `${method} on chain ${chainId} failed: ${String(e)}`, { cause: e })
    }
  }

  return {
    chainId,
    request,
    getCode: (address) => request<`0x${string}`>('eth_getCode', [address, 'latest']),
    call: (tx) => request<`0x${string}`>('eth_call', [{ to: tx.to, data: tx.data }, 'latest'])
  }
}
