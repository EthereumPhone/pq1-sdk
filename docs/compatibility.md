# Compatibility

This page lists what this version of the SDK (0.1.0) works with: PQ1 firmware protocol versions, the catalog release, chains and contract addresses, browsers and tooling, and what isn't supported yet. The SDK gates features on the device's reported protocol version and capability bits, never on its firmware version string, which is a placeholder on current firmware.

## Firmware

The SDK was built and tested against firmware [`EthereumPhone/PQ1@0313a2ef`](https://github.com/EthereumPhone/PQ1/tree/0313a2ef), protocol **0x0203**.

| Protocol | What works | What doesn't |
| --- | --- | --- |
| below 0x0200 | Not supported (pre-production firmware) | — |
| 0x0200 – 0x0201 | Everything above, plus batches of up to 4 calls | `showAddress` (`outdated`) |
| 0x0202 | Everything above, plus `showAddress` | — |
| 0x0203 (current) | Everything the SDK does | Slot rotation (the SDK never rotates) |

| Capability bit | SDK behaviour |
| --- | --- |
| `CAP_OFFCHAIN_SAFE_TX` (bit 3) | Safe `SafeTx` typed data shown on the device; without it, signed as a blind hash |
| `CAP_OFFCHAIN_COW_ORDER` (bit 4) | CoW `Order` typed data shown on the device; without it, signed as a blind hash |
| `CAP_ERC7730_PROOF_SET` (bit 2) | Not used: the SDK sends single ERC-7730 bundles |
| `CAP_SIGN_USEROP_DATA_8K` (bit 5) | Calls of up to 8192 bytes of data (e.g. Uniswap Universal Router swaps); without it the SDK refuses a call over 4096 bytes with `outdated` before sending it |
| `CAP_OFFCHAIN_PERMIT2` (bit 6) | Uniswap Permit2 permits shown on the device; without it, signed as a blind hash |

## Catalogs

`pq1-sdk-catalogs` 0.1.0 matches firmware `0313a2ef` (production roots from [`secure/src/db_roots.rs`](https://github.com/EthereumPhone/PQ1/blob/0313a2ef/secure/src/db_roots.rs)):

| Catalog | Merkle root |
| --- | --- |
| `erc20` | `0xc435c576df0aa21956c5add530563780d2d878d115b4523ea84d9834e55bf203` |
| `names` | `0x52553ed9175b57c60f631b7c71890b5838af4781541b36f37a0c0c933e81f7aa` |
| `selectors` | `0x751caf5205a4ff5901ab6478af91ff36338f874b868378c610b693947456e46a` |
| `erc7730` | `0x8c3dc4b2b1789106a1043aed08114b7827d56052dd920eb0dd6671a84db643e6` |

A device on firmware with other roots rejects every proof from these files and shows raw data. Firmware built before `0313a2ef` has the previous names root, so it shows addresses without names until it is updated; the other three roots are unchanged. Release catalogs together with firmware support (see [clear-signing.md](clear-signing.md#keeping-the-catalogs-in-sync-with-the-firmware)).

## Chains and contracts

`PQ1_SUPPORTED_CHAIN_IDS = [1, 8453, 84532]`: Ethereum, Base and Base Sepolia. Every contract is deployed with CREATE2 through Arachnid's deterministic deployer, so it has the same address on each chain, and a PQ1 account has the same address on every chain.

| Contract | Address |
| --- | --- |
| EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` |
| PQSmartWalletFactory (`FACTORY`) | `0xE3dbA404dCeC30093DE26764965a51689C1607BD` |
| PQSmartWallet implementation | `0xEb64deaD5Ca0C433365EABC1AB6eBdeb28f53011` |
| SPHINCS+ C10 verifier | `0x7Ab9Abd09ef8A5D2ca06d9509BB295e637FA6aB4` |

These are the contracts frozen for the 2026-10 audit (firmware tag `tob-audit-freeze-2026-10`), deployed on all three chains on 2026-10-21 with identical code. The addresses come from the firmware's [`contracts/smart-wallet/deployments/base-mainnet.json`](https://github.com/EthereumPhone/PQ1/blob/0313a2ef/contracts/smart-wallet/deployments/base-mainnet.json); the firmware derives wallet addresses from the same factory address. Firmware built for the earlier factory (`0xe8CE78CD…d452`) derives other addresses, and the SDK refuses it with `firmware-mismatch`. Before every first deployment the SDK checks that the factory has code on the chain and that it predicts the account's address from the device's keys, and refuses with `unsupported-network` or `firmware-mismatch` otherwise.

Another chain works only once the same factory is deployed there. Narrow the list with the `chains` option of `createPq1Wallet`.

The bundler must serve EntryPoint v0.6 and accept a state override as the third parameter of `eth_estimateUserOperationGas`. Pimlico (`pimlicoBundler`) does both on all three chains. The CoW API runs on Ethereum and Base only; the Safe Transaction Service serves all three.

## Browsers

| Browser | Supported |
| --- | --- |
| Chrome, Edge, Brave, Opera (Chromium 117+) | Yes. 117 is the first version with WebHID in extension service workers |
| Firefox | No (no WebHID) |
| Safari | No (no WebHID) |

Use `getWebHidSupport()` to hide PQ1 options where they can't work, and leave the catalogs out of Firefox and Safari builds.

## Tooling

| | Version |
| --- | --- |
| `viem` (peer dependency) | ^2.21 |
| Node (build and tests) | 20 or later; `installFakeHid` needs a global `navigator`, so Node 21+ (or a DOM test environment) |
| TypeScript | 5.x; the package ships ESM, CommonJS and type declarations |
| Module format | ESM and CommonJS, with subpath exports `pq1-sdk/transport`, `/aa`, `/clear-signing`, `/provider`, `/extension`, `/testing` |

## Known limitations

- **No slot rotation.** Each owner slot allows 65,536 signatures (transactions plus off-chain signatures); rotating to the next slot (protocol 0x0203, `FLAG_REGISTER_SLOT`) isn't implemented.
- **No firmware updates.** The FW_* commands are blocked on production devices and not wrapped.
- **No paymasters.** A PQ1 account always pays its own fee in the native token.
- **No contract deployment** from a PQ1 account (the wallet has no CREATE path).
- **No Node HID transport** built in. `HidTransport` accepts any `HIDDevice`-shaped object, so a `node-hid` wrapper can be added.
- **Chromium only**, because of WebHID.

Next: [protocol.md](protocol.md) · [troubleshooting.md](troubleshooting.md) · [getting-started.md](getting-started.md)
