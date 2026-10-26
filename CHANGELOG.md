# Changelog

## 0.1.0 (unreleased)

First release.

- `pq1-sdk`:
  - `createPq1Wallet`: accounts, on-device address checks, transactions (prepare, send, wait), `personal_sign` and EIP-712 signing.
  - `Pq1Device`: the USB connection, unlocking, device id, and an init-code cache that can outlive the service worker.
  - `pq1-sdk/extension`: the permission page helper and `Pq1DeviceManager` for Manifest V3 service workers.
  - `pq1-sdk/provider`: `eth_getCode`, `wallet_getCapabilities`, `wallet_sendCalls` and `wallet_getCallsStatus` helpers.
  - `pq1-sdk/aa`, `pq1-sdk/clear-signing`, `pq1-sdk/transport`: the layers underneath.
  - `pq1-sdk/testing`: `FakePq1Device`, a fake chain and a fake bundler.
  - Clear signing on the device: ERC-20 transfers and approvals, ERC-7730 descriptors, Safe transactions, CoW orders, and Uniswap Permit2 permits.
  - Calls of up to 8192 bytes of data on firmware that reports `CAP_SIGN_USEROP_DATA_8K` (4096 on older firmware, which gets an `outdated` error instead).
  - The PQ1 wallet factory frozen for the 2026-10 audit, `0xE3dbA404dCeC30093DE26764965a51689C1607BD`.
  - `Pq1Error` with stable codes and plain-language messages.
  - Bundlers: `pimlicoBundler`, `erc4337Bundler`.
- `pq1-sdk-catalogs`: the catalogs of firmware commit `0313a2ef`, with a manifest and a sync script.
- `examples/mv3-wallet`: an example Manifest V3 wallet.

Matches PQ1 firmware protocol `0x0203` ([EthereumPhone/PQ1@0313a2ef](https://github.com/EthereumPhone/PQ1/tree/0313a2ef)).
