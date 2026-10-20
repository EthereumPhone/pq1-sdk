// pq1-sdk-catalogs: the four clear-signing catalogs and their manifest.

import { fileURLToPath } from 'node:url'

import manifest from './manifest.json' with { type: 'json' }

export { manifest }

/** The four catalog names. */
export const catalogNames = Object.freeze(['erc20', 'names', 'selectors', 'erc7730'])

/** Absolute path of a catalog file inside this package (Node only), for
 *  build scripts that copy the files into an extension. */
export function catalogFilePath(name) {
  const entry = manifest.catalogs[name]
  if (!entry) throw new Error(`unknown catalog ${name}`)
  return fileURLToPath(new URL(`./data/${entry.file}`, import.meta.url))
}

/** Absolute path of the `data/` directory (Node only). */
export const catalogDir = fileURLToPath(new URL('./data/', import.meta.url))
