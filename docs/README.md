# pq1-sdk documentation

Guides for adding the PQ1 hardware wallet to a browser-extension wallet. If you're new, read them in this order: getting started, concepts, extension architecture, then whichever feature you're building.

## Which page do I need?

| I want to… | Page |
| --- | --- |
| Get a first signature working | [Getting started](getting-started.md) |
| Understand PQ1 accounts, slots, counters and signatures | [Concepts](concepts.md) |
| Decide where the device connection lives in my extension | [Extension architecture](extension-architecture.md) |
| List, verify and store accounts | [Accounts](accounts.md) |
| Send transactions and show fees | [Transactions](transactions.md) |
| Sign messages and typed data | [Message signing](message-signing.md) |
| Make the device show readable details | [Clear signing](clear-signing.md) |
| Answer dApps (EIP-1193, EIP-6963, EIP-5792) | [dApp provider](dapp-provider.md) |
| Show errors in plain words | [Errors](errors.md) |
| Know the rules my integration must keep | [Security](security.md) |
| Test without a device, and with one | [Testing](testing.md) |
| Fix a problem | [Troubleshooting](troubleshooting.md) |
| Write my own transport | [Protocol](protocol.md) |
| Check firmware, chain and browser support | [Compatibility](compatibility.md) |

## The packages

- `pq1-sdk`: the library. The root entry point has the high-level API (`createPq1Wallet`, `Pq1Device`, errors). Subpaths have the layers under it:

  | Import | Contents |
  | --- | --- |
  | `pq1-sdk/extension` | Manifest V3 helpers: the permission page, the service-worker device manager, catalogs and cache in extension storage |
  | `pq1-sdk/provider` | dApp-facing answers: `eth_getCode`, `wallet_getCapabilities`, `wallet_sendCalls` and its status |
  | `pq1-sdk/aa` | The ERC-4337 send pipeline step by step, and the message-signing functions |
  | `pq1-sdk/clear-signing` | Catalog readers and clear-signing bundle builders |
  | `pq1-sdk/transport` | The WebHID transport, raw device commands and wire formats |
  | `pq1-sdk/testing` | A fake PQ1, chain and bundler for tests |

- `pq1-sdk-catalogs`: the four clear-signing catalogs and their manifest.
- `examples/mv3-wallet`: a working example wallet.

## API reference

Every exported function and type has a doc comment, so your editor shows it on hover. To browse them as HTML:

```sh
npm run docs:api   # writes docs/api/index.html
```
