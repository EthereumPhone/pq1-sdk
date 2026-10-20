# pq1-sdk

Add the **PQ1** post-quantum hardware wallet to your browser-extension wallet.

The PQ1 signs with SPHINCS+, a hash-based signature scheme that stays secure against quantum computers, and talks to the browser over WebHID. Its accounts are ERC-4337 smart accounts. This SDK handles the hard parts for you:

- **The device**: the USB transport, unlocking, account discovery, and on-device address checks.
- **Transactions**: building the UserOperation, gas estimation, fees the device can show exactly, signing on the device, the bundler, and receipts.
- **Message signing**: `personal_sign` and EIP-712, as ERC-1271 signatures (or ERC-6492 before the account is deployed).
- **Clear signing**: the catalogs and proofs that let the device show "Send 25 USDC to Uniswap V3 Router" instead of raw bytes.
- **Your extension**: Manifest V3 helpers, dApp-provider answers (EIP-1193, EIP-5792, `eth_getCode`), and a fake PQ1 for tests.

```ts
import { createPq1Wallet, pimlicoBundler } from 'pq1-sdk'
import { extensionCatalogs, Pq1DeviceManager } from 'pq1-sdk/extension'

const manager = new Pq1DeviceManager()
const pq1 = createPq1Wallet({
  device: () => manager.getDevice(),
  rpc: { 8453: 'https://mainnet.base.org' },
  bundler: pimlicoBundler({ apiKey: PIMLICO_API_KEY }),
  catalogs: extensionCatalogs('pq1/')
})

const [account] = await pq1.getAccounts()
const prepared = await pq1.prepareTransaction({
  account,
  chainId: 8453,
  calls: [{ to: recipient, value: parseEther('0.01') }]
})
// Show prepared.fee.maxCost to the user, then:
const { userOpHash } = await pq1.sendPrepared(prepared, account) // confirmed on the PQ1
const { transactionHash } = await pq1.waitForReceipt({ chainId: 8453, userOpHash })
```

## Packages

| Package | What it is |
| --- | --- |
| [`pq1-sdk`](packages/pq1-sdk) | The library. One peer dependency: `viem`. |
| [`pq1-sdk-catalogs`](packages/pq1-sdk-catalogs) | The clear-signing catalogs (about 10.8 MB), matching the PQ1 firmware. A separate package so the library stays small. |
| [`examples/mv3-wallet`](examples/mv3-wallet) | A small working MV3 wallet built on the SDK: connect page, approval window, EIP-1193/6963 provider. |

## Documentation

Start with **[Getting started](docs/getting-started.md)**. The full list is in [docs/](docs/README.md):

| Page | Read it when |
| --- | --- |
| [Getting started](docs/getting-started.md) | You're adding PQ1 to a wallet |
| [Concepts](docs/concepts.md) | You want to know how PQ1 accounts and signatures work |
| [Extension architecture](docs/extension-architecture.md) | You're deciding where the device connection lives in your extension |
| [Accounts](docs/accounts.md) | Discovering, verifying and storing accounts |
| [Transactions](docs/transactions.md) | Sending, fees, first deployment, receipts |
| [Message signing](docs/message-signing.md) | `personal_sign`, EIP-712, ERC-1271/6492 |
| [Clear signing](docs/clear-signing.md) | What the device shows, and the catalogs |
| [dApp provider](docs/dapp-provider.md) | Answering dApps for a PQ1 account |
| [Errors](docs/errors.md) | Showing errors to users |
| [Security](docs/security.md) | The rules your integration must keep |
| [Testing](docs/testing.md) | Testing without hardware, and with it |
| [Troubleshooting](docs/troubleshooting.md) | Something doesn't work |
| [Protocol](docs/protocol.md) | You're writing your own transport |
| [Compatibility](docs/compatibility.md) | Firmware versions, chains, browsers |

API reference: `npm run docs:api` generates it into `docs/api/`.

## Requirements

- A Chromium-based browser, version 117 or later (Chrome, Edge, Brave, Opera). Firefox and Safari have no WebHID.
- A PQ1 with firmware protocol `0x0203` ([EthereumPhone/PQ1](https://github.com/EthereumPhone/PQ1)).
- An ERC-4337 bundler for EntryPoint v0.6 that accepts state overrides in `eth_estimateUserOperationGas`, such as [Pimlico](https://www.pimlico.io/).
- Networks: Ethereum, Base and Base Sepolia.

## Development

```sh
nvm use            # Node 24
npm install
npm run build      # the SDK, then the example
npm test           # unit + end-to-end tests against a fake PQ1
npm run typecheck
npm run lint
```

The PQ1 code here started as the PQ1 integration in the [Ambire wallet](https://github.com/AmbireTech/extension) and was made independent of it. The wire format is tested byte for byte against reference vectors from the firmware.

## License

[MIT](LICENSE)
