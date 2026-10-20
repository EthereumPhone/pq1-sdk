// Messages between the example's pages and its service worker, and the
// settings it keeps in chrome.storage.

import type { Pq1Account } from 'pq1-sdk'

/** The PQ1 networks this example offers, with public RPC endpoints. Use your
 *  own RPC provider in a real wallet: public endpoints are rate-limited. */
export const NETWORKS: Record<number, { name: string; rpc: string; explorer: string }> = {
  84532: {
    name: 'Base Sepolia',
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org'
  },
  8453: { name: 'Base', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' },
  1: {
    name: 'Ethereum',
    rpc: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io'
  }
}

export const DEFAULT_CHAIN_ID = 84532

/** What the example stores in chrome.storage.local. */
export type WalletSettings = {
  account?: Pq1Account
  chainId: number
  /** Origins the user connected the account to. */
  connectedOrigins: string[]
}

/** Messages the connect page sends the service worker. */
export type PageMessage =
  | { type: 'pq1:list-accounts'; start: number; count: number }
  | { type: 'pq1:show-address'; index: number }
  | { type: 'pq1:select-account'; account: Pq1Account }
  | { type: 'pq1:get-settings' }
  | { type: 'approval:get'; id: string }
  | { type: 'approval:resolve'; id: string; approved: boolean }

/** A pending request shown in the approval window. Values are strings so
 *  they survive `chrome.runtime` messaging. */
export type ApprovalRequest = {
  id: string
  origin: string
  kind: 'connect' | 'sign-message' | 'sign-typed-data' | 'transaction'
  chainName: string
  account: string
  /** Human-readable lines describing the request. */
  details: string[]
  /** For transactions: the most the user can pay, in ETH, as text. */
  maxFee?: string
  /** For transactions: whether this one also creates the account on-chain. */
  isFirstDeploy?: boolean
}

/** The answer to a page message: a result, or a message for the user. */
export type PageReply<T> = { ok: true; result: T } | { ok: false; error: string }

/** Send `message` to the service worker and unwrap its reply. */
export async function ask<T>(message: PageMessage): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(message)) as PageReply<T> | undefined
  if (!reply) throw new Error('The wallet did not answer. Reload the extension and try again.')
  if (!reply.ok) throw new Error(reply.error)
  return reply.result
}

/** Port name of the dapp provider connection (content script ↔ worker). */
export const PROVIDER_PORT = 'pq1-example-provider'

/** postMessage tags between the page's provider and the content script. */
export const INPAGE_TARGET = 'pq1-example-inpage'
export const CONTENT_TARGET = 'pq1-example-contentscript'
