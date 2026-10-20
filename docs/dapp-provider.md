# Serving dapps from a PQ1 account

If your wallet injects an EIP-1193 provider into web pages, a few answers must change for PQ1 accounts, because they are ERC-4337 smart-contract wallets and not EOAs: `eth_getCode` must say "contract" even before the wallet is deployed, `wallet_getCapabilities` must advertise atomic batching, `eth_sendTransaction` must return a real transaction hash, and signatures are ERC-1271 or ERC-6492. The helpers in `pq1-sdk/provider` cover these; the rest is ordinary provider plumbing. The example extension's [`background.ts`](../examples/mv3-wallet/src/background.ts) is a complete, working router you can copy from.

## Announcing the provider (EIP-6963)

Announce on load and again on every `eip6963:requestProvider` event:

```ts
const info = Object.freeze({
  uuid: crypto.randomUUID(),          // a UUIDv4, new per page load
  name: 'My Wallet',
  icon: 'data:image/svg+xml;base64,…', // must be a data:image URI
  rdns: 'com.mywallet'                 // reverse DNS of a domain you control
})
const announce = () =>
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) })
  )
window.addEventListener('eip6963:requestProvider', announce)
announce()
```

- Freeze `detail` and `info`; some dapp libraries check.
- Use your own `rdns`. Don't reuse another wallet's (including the official PQ1 extension's).
- Don't signal "smart account" through `rdns` or provider flags. Dapps learn it from `wallet_getCapabilities` and `eth_getCode`.

Inject the in-page script with a `<script src=chrome.runtime.getURL('inpage.js')>` from a content script at `document_start`, so it runs before the page's own scripts and isn't blocked by the page's CSP. See [extension-architecture.md](extension-architecture.md).

## Method by method

`account` below is the `Pq1Account` the user chose (see [accounts.md](accounts.md)); `pq1` is your `createPq1Wallet` instance.

| Method | What to do |
| --- | --- |
| `eth_chainId`, `net_version` | Your current chain. |
| `eth_accounts` | `[account.address]` if this origin is connected, else `[]`. Never throw. |
| `eth_requestAccounts` | Ask the user to connect this origin, then return `[account.address]`. If no PQ1 account is set up yet, open your connect page and reject with 4001. |
| `wallet_switchEthereumChain` | Switch if the chain is in `pq1.chains`, emit `chainChanged`; otherwise reject with **4902**. |
| `personal_sign` `[data, address]` | `pq1.signMessage({ account, chainId, message: { raw: data } })`. `data` is hex: pass it as `{ raw }`, not as a string, or the hex text itself gets signed. |
| `eth_signTypedData_v4` `[address, json]` | `pq1.signTypedData({ account, chainId, typedData: JSON.parse(json) })`. |
| `eth_sendTransaction` `[tx]` | `callsFromTransaction(tx, account.address)` → `prepareTransaction` → show the fee → `sendPrepared` → `waitForReceipt`, and return `receipt.transactionHash`. Dapps look the hash up with `eth_getTransactionReceipt`; a UserOp hash would break them. |
| `wallet_sendCalls` `[params]` | `callsFromSendCalls(params, account.address)` (checks `from`, refuses more than 4 calls) → prepare → confirm → `sendPrepared`. Return `{ id: userOpHash }` and remember the chain for that id. |
| `wallet_getCallsStatus` `[id]` | `buildCallsStatus({ id, chainId, receipt: await bundler.getUserOperationReceipt(chainId, id) })`: 100 pending, 200 confirmed, 500 reverted. |
| `wallet_getCapabilities` `[address, chainIds?]` | `buildPq1Capabilities(chainIds ?? pq1.chains, pq1.chains)`: `atomic: { status: 'supported' }` on PQ1 chains, plus the legacy `atomicBatch` field. No paymaster, no auxiliary funds. |
| `eth_getCode` `[address, block?]` | If `isPq1AccountCodeQuery(...)`, answer with `resolvePq1AccountCode(request, params)`; otherwise forward. See below. |
| `eth_sign` | Reject with **4200**. It signs arbitrary hashes and PQ1 accounts don't need it. |
| anything else | It's a read: forward it with `pq1.chain(chainId).request(method, params)`. |

### `eth_sendTransaction` in code

```ts
import { callsFromTransaction } from 'pq1-sdk/provider'

const calls = callsFromTransaction(tx, account.address)
const prepared = await pq1.prepareTransaction({ account, chainId, calls })
if (!(await askUserToConfirm(prepared.fee.maxCost))) throw userRejected()
const { userOpHash } = await pq1.sendPrepared(prepared, account) // the user confirms on the PQ1
const receipt = await pq1.waitForReceipt({ chainId, userOpHash })
return receipt.transactionHash
```

`waitForReceipt` throws `send-unconfirmed` after its timeout (3 minutes by default). The transaction may still be included: tell the dapp it failed to confirm, not that it failed. Check `receipt.success` if you show a result yourself; an included UserOp can still have reverted.

### `eth_getCode` and the privacy rule

A PQ1 wallet that hasn't sent its first transaction on a chain has no code there yet, so a dapp would treat it as an EOA and pick the wrong signature flow. `resolvePq1AccountCode` returns the real code when the wallet is deployed and the one-byte stub `0xfe` (`PQ1_UNDEPLOYED_ACCOUNT_CODE`) when it isn't, and passes queries at past blocks through unchanged.

Only answer this way for the user's own PQ1 account, on a PQ1 chain, and only to a site that is connected to it. Anything else would let any site probe which addresses are PQ1 accounts. `isPq1AccountCodeQuery` encodes that rule:

```ts
import { isPq1AccountCodeQuery, resolvePq1AccountCode } from 'pq1-sdk/provider'

const request = (args: { method: string; params?: unknown[] }) =>
  pq1.chain(chainId).request(args.method, args.params)

if (
  isPq1AccountCodeQuery({
    address: params[0],
    chainId,
    connectedAccounts: originIsConnected ? [account.address] : [],
    pq1Accounts: [account.address],
    chains: pq1.chains
  })
) {
  return resolvePq1AccountCode(request, params)
}
return request({ method: 'eth_getCode', params })
```

### Signatures dapps receive

`signMessage` and `signTypedData` return `abi.encode(uint256 ownerIndex, bytes signature)` for a deployed wallet, verified through the wallet's ERC-1271 `isValidSignature`, or the device's ready-made ERC-6492 signature (ending in `0x6492…6492`) for one not deployed on that chain yet. A dapp that only calls `ecrecover` can't verify either; one that follows ERC-1271 and ERC-6492 (viem's `verifyMessage`/`verifyTypedData` do) verifies both. See [message-signing.md](message-signing.md).

## Mapping errors to EIP-1193 codes

Every SDK error is a `Pq1Error` (see [errors.md](errors.md)). Send dapps its `userMessage`, never its technical `message`:

| `Pq1Error.code` | EIP-1193 code |
| --- | --- |
| `rejected` (rejected on the device) | 4001 User Rejected Request |
| your own approval window closed or rejected | 4001 |
| `unsupported-network` | 4901 Chain Disconnected (or 4902 for `wallet_switchEthereumChain`) |
| origin not connected | 4100 Unauthorized |
| unsupported method (`eth_sign`) | 4200 Unsupported Method |
| everything else | -32603 Internal error, with `userMessage` |

```ts
import { getUserMessage, isPq1Error } from 'pq1-sdk'

function toRpcError(e: unknown): { code: number; message: string } {
  if (isPq1Error(e)) {
    if (e.code === 'rejected') return { code: 4001, message: e.userMessage }
    if (e.code === 'unsupported-network') return { code: 4901, message: e.userMessage }
    return { code: -32603, message: e.userMessage }
  }
  return { code: -32603, message: getUserMessage(e) }
}
```

Next: [errors.md](errors.md) · [transactions.md](transactions.md) · [security.md](security.md)
