# pq1-sdk-catalogs

The clear-signing catalogs for the PQ1 hardware wallet, for use with [`pq1-sdk`](../pq1-sdk).

The PQ1 holds only the Merkle root of each catalog in its firmware. When the SDK asks the device to sign, it attaches the catalog entries the request needs, each with a Merkle proof, and the device checks every proof against its root. That is how the device can show "Send 25 USDC to Uniswap V3 Router" instead of raw bytes.

| File | Size | Contents |
| --- | ---: | --- |
| `data/erc20_db.bin` | 9.6 MB | Token name, symbol and decimals per (chain, contract) |
| `data/names_db.bin` | 112 KB | Names of well-known contracts and addresses |
| `data/selectors_db.bin` | 775 KB | Function signatures, shown for calls the device can't decode otherwise |
| `data/erc7730_db.bin` | 331 KB | ERC-7730 clear-signing descriptors (365) |

`manifest.json` lists each file's size, sha256 and Merkle root, and the firmware commit they come from.

## Use

Copy the files into your extension's build and point the SDK at them:

```ts
import { extensionCatalogs } from 'pq1-sdk/extension'

createPq1Wallet({ /* … */ catalogs: extensionCatalogs('pq1/') })
```

With esbuild or any Node build script:

```js
import { cpSync } from 'node:fs'
import { catalogDir } from 'pq1-sdk-catalogs'

cpSync(catalogDir, 'build/pq1', { recursive: true })
```

With Vite (`vite-plugin-static-copy`):

```js
viteStaticCopy({ targets: [{ src: 'node_modules/pq1-sdk-catalogs/data/*', dest: 'pq1' }] })
```

With webpack (`copy-webpack-plugin`):

```js
new CopyPlugin({ patterns: [{ from: 'node_modules/pq1-sdk-catalogs/data', to: 'pq1' }] })
```

The files don't need `web_accessible_resources`: the service worker reads its own files. Ship them in your Chromium builds only; Firefox and Safari have no WebHID.

### Serving them from a CDN instead

The device checks every entry, so the files can come from anywhere without any loss of security:

```ts
import { httpCatalogs } from 'pq1-sdk'

createPq1Wallet({ /* … */ catalogs: httpCatalogs('https://cdn.example.com/pq1/') })
```

## Don't edit the files

A catalog can't be trimmed or rebuilt on its own: its root is built into the firmware, and a catalog that doesn't match makes the device reject every proof built from it. Missing entries only make the device show less (or refuse a call it knows needs them); they never make it show something false.

## Updating

Catalogs change with firmware releases. From a checkout of [EthereumPhone/PQ1](https://github.com/EthereumPhone/PQ1):

```sh
npm run sync -w pq1-sdk-catalogs -- /path/to/PQ1
npm test
```

The sync script copies the four files from the firmware's `tools/companion-stub/`, reads the production roots from `secure/src/db_roots.rs`, and rewrites `manifest.json`. The SDK's tests then prove every catalog entry against those roots.

## License

MIT
