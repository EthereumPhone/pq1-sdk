// Shared helpers for the SDK's own tests.

import fs from 'fs'
import path from 'path'

import {
  CATALOG_FILE_NAMES,
  createPq1Context,
  silentLogger,
  type CatalogName,
  type CatalogSource,
  type Pq1Context,
  type Pq1ContextOptions
} from '../src/context'

/** The catalogs as shipped in `pq1-sdk-catalogs`. */
export const CATALOG_DIR = path.resolve(__dirname, '../../pq1-sdk-catalogs/data')

/** One shipped catalog's bytes. */
export function readCatalog(name: CatalogName): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(CATALOG_DIR, CATALOG_FILE_NAMES[name])))
}

/** The shipped catalogs, read from disk on first use. */
export const diskCatalogs: CatalogSource = { load: async (name) => readCatalog(name) }

/** A context with the shipped catalogs and a silent logger. */
export function testContext(options: Pq1ContextOptions = {}): Pq1Context {
  return createPq1Context({ catalogs: diskCatalogs, logger: silentLogger, ...options })
}
