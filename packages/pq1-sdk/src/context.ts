// What the clear-signing and send code needs from its host: where the
// catalogs come from, how to reach the Safe and CoW APIs, and where to
// report problems. `createPq1Wallet` builds one `Pq1Context` per wallet;
// the lower-level functions take it as their first argument.

import { createDbLoader } from './db/common'
import { parseErc20Db, type Erc20Db } from './erc20/db'
import { parseCatalog, type Catalog } from './erc7730/catalog'
import { parseNamesDb, type NamesDb } from './names/db'
import { parseSelectorsDb, type SelectorsDb } from './selectors/db'

/** Where the SDK reports problems that it recovers from (a catalog that
 *  didn't load, an API that didn't answer) and unexpected errors. Hook it to
 *  your crash reporting: a catalog that stops loading quietly downgrades
 *  every PQ1 user to blind signing, which you want to hear about. */
export interface Pq1Logger {
  /** Something went wrong, the SDK recovered, and the device shows less. */
  warn(message: string, details?: unknown): void
  /** Something unexpected; worth a crash report. */
  error(error: unknown, context?: Record<string, unknown>): void
}

/** The default logger: `console.warn` / `console.error`, prefixed `[pq1]`. */
export const consoleLogger: Pq1Logger = {
  warn: (message, details) => console.warn(`[pq1] ${message}`, details ?? ''),
  error: (error, context) => console.error('[pq1]', error, context ?? '')
}

/** A logger that drops everything. */
export const silentLogger: Pq1Logger = { warn: () => {}, error: () => {} }

/** The four clear-signing catalogs (see the `pq1-sdk-catalogs` package). */
export type CatalogName = 'erc20' | 'names' | 'selectors' | 'erc7730'

/** File name of each catalog, as shipped in `pq1-sdk-catalogs`. */
export const CATALOG_FILE_NAMES: Readonly<Record<CatalogName, string>> = {
  erc20: 'erc20_db.bin',
  names: 'names_db.bin',
  selectors: 'selectors_db.bin',
  erc7730: 'erc7730_db.bin'
}

/** Where the SDK loads a catalog's raw bytes from. Called at most once per
 *  catalog per wallet (again only after a failure). See `httpCatalogs`,
 *  `memoryCatalogs` and, for extensions, `extensionCatalogs`. */
export interface CatalogSource {
  load(name: CatalogName): Promise<Uint8Array>
}

/** Catalogs fetched from `baseUrl` (a CDN, your server, or the extension's
 *  own files), e.g. `httpCatalogs('https://cdn.example.com/pq1/')`. The
 *  device checks every entry against roots in its firmware, so serving the
 *  files from anywhere is safe. */
export function httpCatalogs(
  baseUrl: string,
  options: { fetch?: typeof fetch } = {}
): CatalogSource {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return {
    async load(name) {
      const doFetch = options.fetch ?? fetch
      const url = `${base}${CATALOG_FILE_NAMES[name]}`
      const resp = await doFetch(url)
      if (!resp.ok) throw new Error(`failed to load ${url} (${resp.status})`)
      return new Uint8Array(await resp.arrayBuffer())
    }
  }
}

/** Catalogs you already hold in memory (tests, Node scripts). A missing
 *  catalog fails its lookups, and the device shows less. */
export function memoryCatalogs(blobs: Partial<Record<CatalogName, Uint8Array>>): CatalogSource {
  return {
    async load(name) {
      const blob = blobs[name]
      if (!blob) throw new Error(`catalog ${name} not provided`)
      return blob
    }
  }
}

/** The parsed catalogs, loaded on first use and cached. */
export interface CatalogStore {
  erc20(): Promise<Erc20Db>
  names(): Promise<NamesDb>
  selectors(): Promise<SelectorsDb>
  erc7730(): Promise<Catalog>
}

/** A `CatalogStore` reading from `source`. With no source, every lookup
 *  fails and the device shows less (raw addresses, amounts and selectors). */
export function createCatalogStore(
  source: CatalogSource | undefined,
  logger: Pq1Logger
): CatalogStore {
  const load = (name: CatalogName) => () => {
    if (!source) return Promise.reject(new Error('no catalog source configured'))
    return source.load(name)
  }
  return {
    erc20: createDbLoader(load('erc20'), parseErc20Db),
    names: createDbLoader(load('names'), parseNamesDb),
    selectors: createDbLoader(load('selectors'), parseSelectorsDb),
    erc7730: createDbLoader(load('erc7730'), (blob) => parseCatalog(blob, logger))
  }
}

/** The Safe Transaction Service lookup a Safe `approveHash` needs: the
 *  device refuses to sign one without the transaction it approves. Resolve
 *  with the service's JSON for the transaction (the SDK validates it), or
 *  reject when it isn't found. */
export interface SafeTxService {
  getTransaction(chainId: number, safeTxHash: `0x${string}`): Promise<unknown>
}

/** Everything the clear-signing and send code needs from its host. */
export interface Pq1Context {
  catalogs: CatalogStore
  logger: Pq1Logger
  fetch: typeof fetch
  /** Safe Transaction Service client. Without one, Safe `approveHash`
   *  calls are refused (the device needs the transaction they approve). */
  safeTxService?: SafeTxService
  /** CoW orderbook API base URL for a chain (ending in `/api/v1`), or
   *  undefined where CoW isn't available. */
  cowApiUrl: (chainId: number) => string | undefined
}

/** Options for `createPq1Context`. */
export interface Pq1ContextOptions {
  catalogs?: CatalogSource
  logger?: Pq1Logger
  fetch?: typeof fetch
  safeTxService?: SafeTxService
  cowApiUrl?: (chainId: number) => string | undefined
}

/** CoW orderbook API per chain. Base Sepolia has no CoW deployment. */
export const DEFAULT_COW_API_URLS: Readonly<Record<number, string>> = {
  1: 'https://api.cow.fi/mainnet/api/v1',
  8453: 'https://api.cow.fi/base/api/v1'
}

/** Build a `Pq1Context`. `createPq1Wallet` does this for you. */
export function createPq1Context(options: Pq1ContextOptions = {}): Pq1Context {
  const logger = options.logger ?? consoleLogger
  return {
    catalogs: createCatalogStore(options.catalogs, logger),
    logger,
    // Bound so a host's `fetch` keeps its `this` when called as a property.
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    safeTxService: options.safeTxService,
    cowApiUrl: options.cowApiUrl ?? ((chainId) => DEFAULT_COW_API_URLS[chainId])
  }
}
