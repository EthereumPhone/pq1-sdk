# Clear signing

The PQ1 shows every request on its own screen before it signs, in as much detail as your wallet gives it data for. That data comes from four catalogs (tokens, address names, function names, ERC-7730 descriptors) and, for Safe and CoW requests, from their public APIs. The device holds only a Merkle root per catalog and checks every entry the SDK sends against it, so the data can come from anywhere: a missing entry makes the device show less, and a forged one fails its proof. `createPq1Wallet` does all of this for you once you give it a `catalogs` source; this page explains what happens and what you need to configure.

## What the device shows

| Request | What the user sees on the PQ1 |
| --- | --- |
| Transaction (1 to 4 calls, one UserOp) | Per call: the decoded action ("Send 25 USDC", an ERC-7730 summary, a Safe transaction, a CoW order), or the function name, or the raw selector. Then the signer account and its full address, the target, the gas and fee pages, and a 2-page ERC-8213 fingerprint. A first deployment adds a factory page. A batch shows "Tx i of N" pages and a final "Sign N txs?" page. |
| `personal_sign` | The message as text (printable ASCII and line feeds, up to 72 rows of 16 columns), or as hex under `! NOT TEXT` (up to 512 bytes). Longer messages are signed as their EIP-191 hash behind a blind-signing warning. See [message-signing.md](message-signing.md). |
| Typed data | A Safe `SafeTx` or CoW `Order` on the device's own screens (firmware with the capability bit), else the fields an ERC-7730 descriptor names, else the EIP-712 hash behind a loud `BLIND` warning. |

Whatever the route, the device never shows something false. When data is missing it shows less (a raw address, a raw amount, a selector), or refuses a call it knows must be clear-signed.

## The four catalogs

They ship in the [`pq1-sdk-catalogs`](../packages/pq1-sdk-catalogs) package, unchanged from the firmware release whose roots they match.

| `CatalogName` | File | Size | Magic | Contents | Used for |
| --- | --- | ---: | --- | --- | --- |
| `erc20` | `erc20_db.bin` | 9.6 MB | `ERC2` | name, symbol, decimals per (chain, token) | "Send 25 USDC" instead of a raw amount |
| `names` | `names_db.bin` | 105 KB | `NAMS` | names of well-known contracts and addresses | "Uniswap V3 Router" instead of hex |
| `selectors` | `selectors_db.bin` | 775 KB | `SEL4` | function signatures | the function name on a call the device has no decoder for |
| `erc7730` | `erc7730_db.bin` | 331 KB | `P730` | 365 compiled ERC-7730 descriptors | contract calls and EIP-712 typed data |

Every file starts with a 32-byte little-endian header (magic, version 1, entry count, pool offset, proof depth, proofs offset), then a sorted entry table, a string or IR pool, and one Merkle proof per entry. The tree is the same for all four: leaf `sha256(0x00 ‖ entry)`, node `sha256(0x01 ‖ left ‖ right)`.

### Why they can't be trimmed or rebuilt

The device knows only the root of each catalog, built into its firmware. The SDK sends one entry plus its proof per lookup. A catalog you rebuilt or trimmed has a different root, so every proof from it fails. Ship the files unchanged.

### Where they come from: `CatalogSource`

```ts
import { createPq1Wallet, httpCatalogs, memoryCatalogs } from 'pq1-sdk'
import { extensionCatalogs } from 'pq1-sdk/extension'

// Copied into your extension build (recommended for extensions):
createPq1Wallet({ ...options, catalogs: extensionCatalogs('pq1/') })

// From a CDN or your own server:
createPq1Wallet({ ...options, catalogs: httpCatalogs('https://cdn.example.com/pq1/') })

// Already in memory (tests, Node scripts):
createPq1Wallet({ ...options, catalogs: memoryCatalogs({ erc20: bytes, names: bytes2 }) })
```

| Source | Notes |
| --- | --- |
| `extensionCatalogs(basePath = 'pq1/')` | Fetches `chrome.runtime.getURL(basePath + file)`. The files don't need to be web-accessible: the service worker reads its own origin. Leave them out of Firefox and Safari builds (no WebHID). |
| `httpCatalogs(baseUrl, { fetch? })` | Any URL. Safe because the device verifies every entry. Keeps 10 MB out of your extension package. |
| `memoryCatalogs(blobs)` | A missing catalog fails its lookups. |
| none (`catalogs` omitted) | Every lookup fails; the device shows raw values and refuses known calls that need a descriptor. Works, but users get a much worse experience. |

Each catalog is loaded on first use and cached for the wallet's lifetime; a failed load is retried on the next lookup. Users without a PQ1 account never load them.

Copying the files in a build script:

```js
import { cpSync } from 'node:fs'
import { catalogDir } from 'pq1-sdk-catalogs'

cpSync(catalogDir, 'build/pq1', { recursive: true })
```

## How a call gets its data

`buildCallTrailers` (in `pq1-sdk/clear-signing`, called by `signPreparedTransaction`) picks, per call, the first route that matches:

1. **CoW pre-signature**: `setPreSignature(uid, true)` on GPv2Settlement. The order is read from the CoW API and attached. Required by the device.
2. **Safe `approveHash`**: the Safe transaction it approves is read from the Safe Transaction Service, re-hashed, and attached. Required by the device.
3. **Safe `execTransaction`**: no bundle needed (the fields are in the calldata), but the SDK applies the device's rules first. A Safe transaction that pre-signs a CoW order gets the order bundle, with the Safe as owner.
4. **ERC-7730**: a descriptor for `(chain, contract)` that has a format for the call's selector. A descriptor without that format counts as none.

Then, for every call:

- the **ERC-20 bundle** for the token called directly, inside the Safe transaction, behind the `approveHash`, or named by the descriptor's amount fields;
- a **function-name bundle** only when nothing above decodes the call (no ERC-20, Safe, CoW or descriptor);
- **name bundles** for the addresses the device will show, de-duplicated across the whole request and capped at 4.

### Safe and CoW need their APIs

| Call | Needs | Configure with | Without it |
| --- | --- | --- | --- |
| Safe `approveHash` | the Safe transaction behind the hash | `safeTxService: safeTransactionService({ apiKey })` | refused with `cannot-display` |
| CoW `setPreSignature` (direct or inside a Safe transaction) | the order behind the uid | `cowApiUrl` (default: api.cow.fi on Ethereum and Base) | refused with `cannot-display` |

```ts
import { createPq1Wallet, safeTransactionService } from 'pq1-sdk'

const pq1 = createPq1Wallet({
  ...options,
  // api.safe.global refuses requests without a key: get one at https://developer.safe.global
  safeTxService: safeTransactionService({ apiKey: SAFE_API_KEY })
})
```

`safeTransactionService` reads `https://api.safe.global/tx-service/<eth|base|basesep>/api/v2/multisig-transactions/<hash>/`; pass `baseUrl` to use your own deployment. CoW has no deployment on Base Sepolia, so CoW pre-signatures are refused there. The SDK refuses these calls itself because the device would refuse them anyway, and a clear message beats a refusal on the device.

Nothing read from these APIs is trusted: the SDK re-derives the Safe transaction hash or the order uid and requires it to equal the one in the calldata, and the device does the same again.

### Safe batches: MultiSendCallOnly only

A Safe transaction with `operation = 1` (DelegateCall) is signable only when its target is one of the canonical `MultiSendCallOnly` deployments (`MULTISEND_CALL_ONLY_ADDRESSES_LC`: v1.3.0 canonical and eip155, v1.4.1, v1.5.0), every record in the batch is a plain call, and the batch has at most 6 records. Plain `MultiSend` and every other DelegateCall target are refused, before the device sees them, with `cannot-display`.

## Noticing catalog problems

A catalog that stops loading quietly turns every PQ1 user into a blind signer. The SDK reports each fallback through your logger:

```ts
createPq1Wallet({
  ...options,
  logger: {
    warn: (message, details) => reportToMonitoring('pq1-fallback', { message, details }),
    error: (error, context) => Sentry.captureException(error, { extra: context })
  }
})
```

Messages look like `ERC-20 bundle lookup failed; rendering unknown-token` or `erc7730 catalog unavailable — falling back to blind-sign`. Alert on them in production.

## Keeping the catalogs in sync with the firmware

Catalogs change only with a firmware release that changes their roots. `pq1-sdk-catalogs/manifest.json` records where the current files came from:

```json
{
  "firmwareRepo": "https://github.com/EthereumPhone/PQ1",
  "firmwareCommit": "8a3fb4b3db9eb3de97c65e4399cbf3d157e3c103",
  "catalogs": {
    "erc20": { "file": "erc20_db.bin", "size": 9609114, "sha256": "2567e2be…", "merkleRoot": "0xc435c576…" }
  }
}
```

To refresh for a new firmware release:

1. Check out the firmware at the release commit.
2. `npm run sync -w pq1-sdk-catalogs -- /path/to/PQ1` copies the four files from `tools/companion-stub/` and rewrites the manifest, reading each production root from `secure/src/db_roots.rs`.
3. Rebuild `packages/pq1-sdk/src/erc7730/catalog.review.json` (the per-descriptor summary) from the firmware's [`secure/data/erc7730.review.txt`](https://github.com/EthereumPhone/PQ1/blob/8a3fb4b3/secure/data/erc7730.review.txt). This step is manual for now.
4. `npm test`. `db/catalogRoots.test.ts` proves an entry of every catalog to the manifest roots, `erc7730/ir.test.ts` walks every descriptor against the review file, and the catalogs package checks sizes and checksums.

Ship catalogs and firmware support together: an old catalog against new firmware (or the reverse) fails every proof, and the device shows raw data.

Next: [dapp-provider.md](dapp-provider.md) · [message-signing.md](message-signing.md) · [security.md](security.md)
