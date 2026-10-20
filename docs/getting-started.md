# Getting started

This page takes a Manifest V3 extension from nothing to a first PQ1 signature. You add one page that asks the browser for permission to use the PQ1, and code in your service worker that owns the device and signs. The full working version of everything here is the example extension in [`examples/mv3-wallet`](../examples/mv3-wallet).

> **Requirements**
>
> - A Chromium-based browser, version 117 or later (Chrome, Brave, Edge, Arc, Opera). Firefox and Safari have no WebHID.
> - A PQ1 on firmware protocol `0x0203`. Batches of calls need at least `0x0200`; `showAddress` needs `0x0202`.
> - To send transactions: a [Pimlico](https://dashboard.pimlico.io) API key, or another ERC-4337 bundler that serves EntryPoint v0.6 and accepts a state override on `eth_estimateUserOperationGas` (see [Transactions](./transactions.md#bundler-requirements)).
> - On Linux, a udev rule so the browser may open the device (see [Troubleshooting](./troubleshooting.md)).

## Install

```sh
npm i pq1-sdk pq1-sdk-catalogs viem
```

- `pq1-sdk` is the library. Its only runtime dependency is `viem`, as a peer dependency.
- `pq1-sdk-catalogs` holds the four clear-signing catalogs (about 10.8 MB). The device needs them to show token amounts, contract names and function names instead of raw hex. Your build copies them into the extension; they are never bundled into JavaScript. See [Clear signing](./clear-signing.md).

## 1. The manifest

```json
{
  "manifest_version": 3,
  "minimum_chrome_version": "117",
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["storage"]
}
```

WebHID needs no manifest permission. `storage` is for the init-code cache (see [Extension architecture](./extension-architecture.md#the-init-code-cache)).

## 2. Copy the catalogs into your build

The service worker loads the catalogs from the extension's own files. Copy them to `pq1/` in your build output. With a plain Node build script:

```js
import { cpSync } from 'node:fs'
import { catalogDir } from 'pq1-sdk-catalogs'

cpSync(catalogDir, 'build/pq1', { recursive: true })
```

With webpack, Vite or another bundler, point its copy plugin at `node_modules/pq1-sdk-catalogs/data/`. Only Chromium builds need them.

## 3. A connect page

The browser's device picker (`navigator.hid.requestDevice()`) only opens from a click on a page. Use a full tab, not the action popup: Chrome closes the popup when the picker opens.

```ts
// connect.ts, loaded by connect.html (opened in a tab)
import { PQ1_ERROR_MESSAGES } from 'pq1-sdk'
import { getWebHidSupport, notifyPermissionGranted, requestPq1Permission } from 'pq1-sdk/extension'

const button = document.querySelector<HTMLButtonElement>('#connect')!

if (!getWebHidSupport().supported) {
  button.disabled = true
  document.querySelector('#error')!.textContent = PQ1_ERROR_MESSAGES.unsupported
}

button.addEventListener('click', async () => {
  // Must run inside the click handler: the picker needs a user gesture.
  const device = await requestPq1Permission()
  if (!device) return // the user closed the picker
  // The page doesn't open the device. It tells the service worker, which does.
  await notifyPermissionGranted()
})
```

The page never talks to the PQ1 itself. Everything below runs in the service worker, which keeps the only connection (see [Extension architecture](./extension-architecture.md) for why).

## 4. The service worker

```ts
// background.ts
import { createPq1Wallet, pimlicoBundler } from 'pq1-sdk'
import { extensionCatalogs, onPermissionGranted, Pq1DeviceManager } from 'pq1-sdk/extension'

// Owns the one connection to the PQ1, reconnects after an unplug or a
// service-worker restart, and keeps the init-code cache in chrome.storage.
const manager = new Pq1DeviceManager()

export const pq1 = createPq1Wallet({
  device: () => manager.getDevice(),
  rpc: {
    84532: 'https://sepolia.base.org',
    8453: 'https://mainnet.base.org'
  },
  bundler: pimlicoBundler({ apiKey: PIMLICO_API_KEY }),
  catalogs: extensionCatalogs('pq1/')
})

// Connect as soon as a page grants a PQ1, so the first request is fast.
onPermissionGranted(() => {
  manager.getDevice().catch((e) => console.warn('PQ1 connect failed', e))
})
```

`createPq1Wallet` unlocks the device when needed (the user types the PIN on the PQ1), checks that the right PQ1 signs for each account, and turns every failure into a `Pq1Error` with a message you can show the user. Public RPC endpoints are rate-limited; use your own provider in production.

## 5. List the accounts

```ts
const accounts = await pq1.getAccounts() // accounts 0-4
// [{ index: 0, address: '0x…', deviceId: '1a2b3c4d5e6f' }, …]
```

Store the account the user picks, all three fields. You pass it back to every signing call. See [Accounts](./accounts.md).

## 6. Sign a message

```ts
const account = accounts[0]

const signature = await pq1.signMessage({
  account,
  chainId: 84532,
  message: 'Hello from my wallet'
})
```

The PQ1 shows the message on its screen and the user confirms there. The result is a smart-account signature (ERC-1271, or ERC-6492 before the account's first transaction), not an ECDSA one. See [Message signing](./message-signing.md).

## 7. Send a transaction

Prepare first, so you can show the fee, then send:

```ts
import { formatEther } from 'viem'

const prepared = await pq1.prepareTransaction({
  account,
  chainId: 84532,
  calls: [{ to: '0x1234567890abcdef1234567890abcdef12345678', value: 10n ** 15n }]
})

// Show this to the user before asking the device.
console.log(`Network fee: at most ${formatEther(prepared.fee.maxCost)} ETH`)
if (prepared.isFirstDeploy) console.log('This first transaction also sets up the account.')

const { userOpHash } = await pq1.sendPrepared(prepared, account) // user confirms on the PQ1
const receipt = await pq1.waitForReceipt({ chainId: 84532, userOpHash })
console.log(receipt.success, receipt.transactionHash)
```

The account pays the fee in ETH from its own balance, so fund it first. On Base Sepolia, use a faucet. See [Transactions](./transactions.md).

## 8. Handle errors

Every method rejects with a `Pq1Error`. Show `userMessage`, log `message`:

```ts
import { getUserMessage, isPq1Error } from 'pq1-sdk'

try {
  await pq1.signMessage({ account, chainId: 84532, message: 'hi' })
} catch (e) {
  showToast(getUserMessage(e))
  if (isPq1Error(e) && e.code === 'rejected') return // the user said no on the device
  console.error(e)
}
```

See [Errors](./errors.md) for every code.

## Serving dapps

If your wallet injects an EIP-1193 provider, a few answers must differ for PQ1 accounts (`eth_getCode`, `wallet_getCapabilities`, `eth_sendTransaction` returning the real transaction hash). `pq1-sdk/provider` has the helpers, and `examples/mv3-wallet/src/background.ts` shows a complete router. See [dApp provider](./dapp-provider.md).

## Testing without hardware

`pq1-sdk/testing` has a fake PQ1 that speaks the real USB framing, plus a fake chain and bundler:

```ts
import { createPq1Wallet, Pq1Device } from 'pq1-sdk'
import { createFakeBundler, createFakeChain, FakePq1Device } from 'pq1-sdk/testing'

const fake = new FakePq1Device()
const chain = createFakeChain({ chainId: 84532, device: fake })
const wallet = createPq1Wallet({
  device: () => Pq1Device.connect({ hidDevice: fake.asHidDevice() }),
  rpc: { 84532: chain.request },
  bundler: createFakeBundler()
})
```

See [Testing](./testing.md).

Next: [Concepts](./concepts.md) · [Extension architecture](./extension-architecture.md) · [Accounts](./accounts.md) · [Transactions](./transactions.md)
