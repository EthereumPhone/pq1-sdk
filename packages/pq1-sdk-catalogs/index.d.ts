/** One catalog's entry in the manifest. */
export interface CatalogManifestEntry {
  /** File name inside `data/`. */
  file: string
  /** Size in bytes. */
  size: number
  /** sha256 of the file, hex. */
  sha256: string
  /** The Merkle root the firmware pins for this catalog. The device checks
   *  every entry the SDK sends against it. */
  merkleRoot: `0x${string}`
}

/** What `manifest.json` holds. */
export interface CatalogManifest {
  firmwareRepo: string
  /** The firmware commit these catalogs (and roots) come from. */
  firmwareCommit: string
  catalogs: Record<CatalogName, CatalogManifestEntry>
}

/** The four catalog names, as `pq1-sdk`'s `CatalogName`. */
export type CatalogName = 'erc20' | 'names' | 'selectors' | 'erc7730'

/** File names, sizes, checksums, Merkle roots and the firmware commit. */
export declare const manifest: CatalogManifest

/** The four catalog names. */
export declare const catalogNames: readonly CatalogName[]

/** Absolute path of a catalog file inside this package (Node only), for
 *  build scripts that copy the files into an extension. */
export declare function catalogFilePath(name: CatalogName): string

/** Absolute path of the `data/` directory (Node only). */
export declare const catalogDir: string
