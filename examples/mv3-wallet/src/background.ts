// The example wallet's service worker. It owns the one connection to the PQ1
// (`Pq1DeviceManager`), signs with `createPq1Wallet`, and answers dapps'
// EIP-1193 requests that arrive from the content script.

import {
  createPq1Wallet,
  getUserMessage,
  isPq1Error,
  pimlicoBundler,
  type Pq1Account,
  type PreparedTransaction
} from 'pq1-sdk'
import { extensionCatalogs, onPermissionGranted, Pq1DeviceManager } from 'pq1-sdk/extension'
import {
  buildCallsStatus,
  buildPq1Capabilities,
  callsFromSendCalls,
  callsFromTransaction,
  isPq1AccountCodeQuery,
  resolvePq1AccountCode,
  type SendCallsParams
} from 'pq1-sdk/provider'
import { formatEther, hexToString, isHex } from 'viem'

import {
  DEFAULT_CHAIN_ID,
  NETWORKS,
  PROVIDER_PORT,
  type ApprovalRequest,
  type PageMessage,
  type PageReply,
  type WalletSettings
} from './shared'

declare const PIMLICO_API_KEY: string

// ── The PQ1 ──────────────────────────────────────────────────────────

const manager = new Pq1DeviceManager({
  onChange: (connected) => console.info(`[example] PQ1 ${connected ? 'connected' : 'disconnected'}`)
})

const bundler = pimlicoBundler({ apiKey: PIMLICO_API_KEY })

const wallet = createPq1Wallet({
  device: () => manager.getDevice(),
  rpc: (chainId) => NETWORKS[chainId]?.rpc,
  bundler,
  // Copied from pq1-sdk-catalogs into build/pq1/ by build.mjs.
  catalogs: extensionCatalogs('pq1/'),
  chains: Object.keys(NETWORKS).map(Number)
})

// A page granted access to a PQ1: connect now, so the first request is fast.
onPermissionGranted(() => {
  manager.getDevice().catch((e: unknown) => console.warn('[example] connecting the PQ1 failed', e))
})

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('connect.html') })
})

// ── Settings ─────────────────────────────────────────────────────────

async function getSettings(): Promise<WalletSettings> {
  const { settings } = await chrome.storage.local.get('settings')
  return {
    chainId: DEFAULT_CHAIN_ID,
    connectedOrigins: [],
    ...(settings as Partial<WalletSettings>)
  }
}

async function updateSettings(patch: Partial<WalletSettings>): Promise<WalletSettings> {
  const settings = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ settings })
  return settings
}

// ── Pages (connect, approval) ────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: PageMessage, _sender, sendResponse) => {
  handlePageMessage(message).then(
    (result) => sendResponse({ ok: true, result } satisfies PageReply<unknown>),
    (e: unknown) => {
      console.warn('[example]', e)
      sendResponse({ ok: false, error: getUserMessage(e) } satisfies PageReply<unknown>)
    }
  )
  return true // the reply is async
})

async function handlePageMessage(message: PageMessage): Promise<unknown> {
  switch (message.type) {
    case 'pq1:list-accounts':
      return wallet.getAccounts({ start: message.start, count: message.count })
    case 'pq1:show-address': {
      const accounts = await wallet.getAccounts({ start: message.index, count: 1 })
      return wallet.showAddress(accounts[0]!)
    }
    case 'pq1:select-account': {
      const settings = await updateSettings({ account: message.account, connectedOrigins: [] })
      broadcast('accountsChanged', [])
      return settings
    }
    case 'pq1:get-settings':
      return getSettings()
    case 'approval:get':
      return approvals.get(message.id)?.request
    case 'approval:resolve':
      approvals.get(message.id)?.resolve(message.approved)
      return true
    default:
      return undefined
  }
}

// ── Approval windows ─────────────────────────────────────────────────

const approvals = new Map<
  string,
  { request: ApprovalRequest; resolve: (approved: boolean) => void }
>()

/** Show `request` in a small window; resolves with the user's decision.
 *  Closing the window counts as a rejection. */
async function askUser(request: Omit<ApprovalRequest, 'id'>): Promise<boolean> {
  const id = crypto.randomUUID()
  const popup = await chrome.windows.create({
    url: chrome.runtime.getURL(`approve.html?id=${id}`),
    type: 'popup',
    width: 400,
    height: 620
  })
  const popupId = popup?.id
  return new Promise<boolean>((resolve) => {
    const onRemoved = (windowId: number) => {
      if (windowId === popupId) finish(false)
    }
    const finish = (approved: boolean) => {
      approvals.delete(id)
      chrome.windows.onRemoved.removeListener(onRemoved)
      // Already closed when the user closed it; nothing to clean up then.
      if (popupId !== undefined) chrome.windows.remove(popupId).catch(() => {})
      resolve(approved)
    }
    approvals.set(id, { request: { ...request, id }, resolve: finish })
    chrome.windows.onRemoved.addListener(onRemoved)
  })
}

// ── Dapp requests (EIP-1193) ─────────────────────────────────────────

/** An EIP-1193 error. */
class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

const userRejected = () => new ProviderRpcError(4001, 'The user rejected the request.')

const ports = new Set<chrome.runtime.Port>()

function broadcast(event: string, data: unknown): void {
  for (const port of ports) port.postMessage({ event, data })
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PROVIDER_PORT) return
  ports.add(port)
  port.onDisconnect.addListener(() => ports.delete(port))
  port.onMessage.addListener((message: { id: number; method: string; params?: unknown[] }) => {
    const origin = port.sender?.origin ?? 'unknown'
    handleRpc(origin, message.method, message.params ?? []).then(
      (result) => port.postMessage({ id: message.id, result }),
      (e: unknown) => port.postMessage({ id: message.id, error: toRpcError(e) })
    )
  })
})

function toRpcError(e: unknown): { code: number; message: string } {
  if (e instanceof ProviderRpcError) return { code: e.code, message: e.message }
  if (isPq1Error(e)) {
    if (e.code === 'rejected') return { code: 4001, message: e.userMessage }
    if (e.code === 'unsupported-network') return { code: 4901, message: e.userMessage }
    return { code: -32603, message: e.userMessage }
  }
  console.error('[example] unexpected error', e)
  return { code: -32603, message: getUserMessage(e) }
}

/** The account, if `origin` is connected to it. */
async function connectedAccount(origin: string): Promise<Pq1Account | undefined> {
  const settings = await getSettings()
  return settings.account && settings.connectedOrigins.includes(origin)
    ? settings.account
    : undefined
}

async function requireConnected(origin: string): Promise<{ account: Pq1Account; chainId: number }> {
  const settings = await getSettings()
  const account = await connectedAccount(origin)
  if (!account) throw new ProviderRpcError(4100, 'Connect this site to your PQ1 account first.')
  return { account, chainId: settings.chainId }
}

const sendCallsChains = new Map<string, number>()

async function handleRpc(origin: string, method: string, params: unknown[]): Promise<unknown> {
  const settings = await getSettings()
  const chainId = settings.chainId
  switch (method) {
    case 'eth_chainId':
      return `0x${chainId.toString(16)}`
    case 'net_version':
      return String(chainId)

    case 'eth_accounts': {
      const account = await connectedAccount(origin)
      return account ? [account.address] : []
    }

    case 'eth_requestAccounts': {
      const existing = await connectedAccount(origin)
      if (existing) return [existing.address]
      if (!settings.account) {
        await chrome.tabs.create({ url: chrome.runtime.getURL('connect.html') })
        throw new ProviderRpcError(4001, 'Set up your PQ1 in the wallet first, then try again.')
      }
      const approved = await askUser({
        origin,
        kind: 'connect',
        chainName: NETWORKS[chainId]!.name,
        account: settings.account.address,
        details: [`${origin} wants to see your PQ1 account address.`]
      })
      if (!approved) throw userRejected()
      await updateSettings({ connectedOrigins: [...settings.connectedOrigins, origin] })
      broadcast('accountsChanged', [settings.account.address])
      return [settings.account.address]
    }

    case 'wallet_switchEthereumChain': {
      const target = Number(BigInt((params[0] as { chainId: string }).chainId))
      if (!NETWORKS[target])
        throw new ProviderRpcError(4902, 'PQ1 accounts are not available on that network.')
      await updateSettings({ chainId: target })
      broadcast('chainChanged', `0x${target.toString(16)}`)
      return null
    }

    case 'personal_sign': {
      const { account } = await requireConnected(origin)
      const data = params[0] as `0x${string}`
      const preview = isHex(data) ? safeText(data) : String(data)
      const approved = await askUser({
        origin,
        kind: 'sign-message',
        chainName: NETWORKS[chainId]!.name,
        account: account.address,
        details: [preview]
      })
      if (!approved) throw userRejected()
      return wallet.signMessage({ account, chainId, message: { raw: data } })
    }

    case 'eth_signTypedData_v4': {
      const { account } = await requireConnected(origin)
      // Most dapps send the typed data as a JSON string; some send the object.
      const typedData = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
      const approved = await askUser({
        origin,
        kind: 'sign-typed-data',
        chainName: NETWORKS[chainId]!.name,
        account: account.address,
        details: [`Type: ${typedData.primaryType}`, JSON.stringify(typedData.message, null, 2)]
      })
      if (!approved) throw userRejected()
      return wallet.signTypedData({ account, chainId, typedData })
    }

    case 'eth_sendTransaction': {
      const { account } = await requireConnected(origin)
      const calls = callsFromTransaction(
        params[0] as Parameters<typeof callsFromTransaction>[0],
        account.address
      )
      const prepared = await wallet.prepareTransaction({ account, chainId, calls })
      if (!(await confirmTransaction(origin, account, prepared))) throw userRejected()
      const { userOpHash } = await wallet.sendPrepared(prepared, account)
      // Dapps expect a transaction hash they can look up, not a UserOp hash.
      const receipt = await wallet.waitForReceipt({ chainId, userOpHash })
      return receipt.transactionHash
    }

    case 'wallet_sendCalls': {
      const { account } = await requireConnected(origin)
      const request = callsFromSendCalls(params[0] as SendCallsParams, account.address)
      if (request.chainId !== chainId)
        throw new ProviderRpcError(4901, 'Switch to that network first.')
      const prepared = await wallet.prepareTransaction({ account, chainId, calls: request.calls })
      if (!(await confirmTransaction(origin, account, prepared))) throw userRejected()
      const { userOpHash } = await wallet.sendPrepared(prepared, account)
      sendCallsChains.set(userOpHash, chainId)
      return { id: userOpHash }
    }

    case 'wallet_getCallsStatus': {
      const id = params[0] as `0x${string}`
      const callsChainId = sendCallsChains.get(id) ?? chainId
      const receipt = await bundler.getUserOperationReceipt(callsChainId, id)
      return buildCallsStatus({ id, chainId: callsChainId, receipt })
    }

    case 'wallet_getCapabilities': {
      const chainIds =
        (params[1] as string[] | undefined)?.map((c) => Number(BigInt(c))) ?? wallet.chains
      return buildPq1Capabilities(chainIds, wallet.chains)
    }

    case 'eth_getCode': {
      const [address] = params as [string, ...unknown[]]
      const account = await connectedAccount(origin)
      const isPq1Query = isPq1AccountCodeQuery({
        address,
        chainId,
        connectedAccounts: account ? [account.address] : [],
        pq1Accounts: settings.account ? [settings.account.address] : []
      })
      const request = (args: { method: string; params?: unknown[] }) =>
        wallet.chain(chainId).request(args.method, args.params)
      return isPq1Query
        ? resolvePq1AccountCode(request, params as [string, ...unknown[]])
        : request({ method, params })
    }

    case 'eth_sign':
      throw new ProviderRpcError(4200, 'eth_sign is not supported. Use personal_sign.')

    default:
      // Everything else is a read: pass it to the network.
      return wallet.chain(chainId).request(method, params)
  }
}

async function confirmTransaction(
  origin: string,
  account: Pq1Account,
  prepared: PreparedTransaction
): Promise<boolean> {
  return askUser({
    origin,
    kind: 'transaction',
    chainName: NETWORKS[prepared.chainId]!.name,
    account: account.address,
    details: prepared.calls.map(
      (call, i) =>
        `Action ${i + 1}: to ${call.to}${call.value ? `, sending ${formatEther(call.value)} ETH` : ''}${
          call.data !== '0x' ? ` (with ${(call.data.length - 2) / 2} bytes of data)` : ''
        }`
    ),
    maxFee: `${formatEther(prepared.fee.maxCost)} ETH`,
    isFirstDeploy: prepared.isFirstDeploy
  })
}

/** A `personal_sign` message as text for the approval window, or its hex. */
function safeText(data: `0x${string}`): string {
  try {
    return hexToString(data)
  } catch {
    return data
  }
}
