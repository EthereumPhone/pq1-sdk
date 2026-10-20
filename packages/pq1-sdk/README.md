# pq1-sdk

Add the PQ1 post-quantum hardware wallet (SPHINCS+, WebHID, ERC-4337 smart accounts) to your browser-extension wallet.

```sh
npm install pq1-sdk pq1-sdk-catalogs viem
```

```ts
import { createPq1Wallet, pimlicoBundler } from 'pq1-sdk'
import { extensionCatalogs, Pq1DeviceManager } from 'pq1-sdk/extension'

// In your extension's service worker:
const manager = new Pq1DeviceManager()
const pq1 = createPq1Wallet({
  device: () => manager.getDevice(),
  rpc: { 8453: 'https://mainnet.base.org' },
  bundler: pimlicoBundler({ apiKey: PIMLICO_API_KEY }),
  catalogs: extensionCatalogs('pq1/')
})

const [account] = await pq1.getAccounts()
const signature = await pq1.signMessage({ account, chainId: 8453, message: 'hello' })
```

Granting the extension access to the PQ1 needs a click on an extension page:

```ts
import { notifyPermissionGranted, requestPq1Permission } from 'pq1-sdk/extension'

button.onclick = async () => {
  if (await requestPq1Permission()) await notifyPermissionGranted()
}
```

## Entry points

| Import | Contents |
| --- | --- |
| `pq1-sdk` | `createPq1Wallet`, `Pq1Device`, `Pq1Error`, bundlers, catalog sources, constants |
| `pq1-sdk/extension` | `requestPq1Permission`, `Pq1DeviceManager`, `extensionCatalogs`, `chromeStorageCache` |
| `pq1-sdk/provider` | `eth_getCode`, `wallet_getCapabilities`, `wallet_sendCalls` helpers for dApps |
| `pq1-sdk/aa` | The send pipeline step by step; message signing |
| `pq1-sdk/clear-signing` | Catalog readers, clear-signing bundles |
| `pq1-sdk/transport` | WebHID transport, raw device commands, wire formats |
| `pq1-sdk/testing` | `FakePq1Device`, fake chain and bundler |

## Documentation

The guides are in the [repository's docs folder](https://github.com/EthereumPhone/pq1-sdk/tree/main/docs): getting started, concepts, extension architecture, accounts, transactions, message signing, clear signing, dApp provider, errors, security, testing, troubleshooting, protocol and compatibility.

## License

MIT
