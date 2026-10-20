#!/usr/bin/env node
// Copy the clear-signing catalogs from a PQ1 firmware checkout into `data/`
// and regenerate `manifest.json` (sizes, sha256, the Merkle roots the
// firmware pins, and the firmware commit).
//
//   node scripts/sync-from-firmware.mjs ~/src/PQ1
//
// Run it for a firmware release that changes the catalogs, then run the
// SDK's tests: `db/catalogRoots.test.ts` proves every catalog entry to the
// roots in the manifest.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CATALOGS = {
  erc20: { file: 'erc20_db.bin', rootName: 'ERC20_DB_ROOT' },
  names: { file: 'names_db.bin', rootName: 'NAMES_DB_ROOT' },
  selectors: { file: 'selectors_db.bin', rootName: 'SELECTOR_DB_ROOT' },
  erc7730: { file: 'erc7730_db.bin', rootName: 'ERC7730_DESCRIPTORS_ROOT' }
}

const firmwareDir = process.argv[2]
if (!firmwareDir) {
  console.error('usage: node scripts/sync-from-firmware.mjs <path to the PQ1 firmware repo>')
  process.exit(1)
}

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stubDir = join(firmwareDir, 'tools', 'companion-stub')
const rootsSource = readFileSync(join(firmwareDir, 'secure', 'src', 'db_roots.rs'), 'utf8')

/** The production value of `pub static <name>: [u8; 32] = [ ... ];` in
 *  db_roots.rs: the definition right after `#[cfg(not(feature = "e2e-test"))]`
 *  (the e2e-test build pins different roots). */
function productionRoot(name) {
  const lines = rootsSource.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const isDefinition = lines[i].trim().startsWith(`pub static ${name}:`)
    const isProduction = lines[i - 1].trim() === '#[cfg(not(feature = "e2e-test"))]'
    if (!isDefinition || !isProduction) continue
    const bytes = []
    for (let j = i + 1; j < lines.length && !lines[j].trim().startsWith('];'); j++) {
      for (const token of lines[j].split(',')) {
        const t = token.trim()
        if (t.startsWith('0x')) bytes.push(t.slice(2).padStart(2, '0'))
      }
    }
    if (bytes.length !== 32) throw new Error(`${name}: expected 32 bytes, found ${bytes.length}`)
    return `0x${bytes.join('')}`
  }
  throw new Error(`${name}: no production definition in db_roots.rs`)
}

const commit = execFileSync('git', ['-C', firmwareDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8'
}).trim()

const catalogs = {}
for (const [name, { file, rootName }] of Object.entries(CATALOGS)) {
  const target = join(packageDir, 'data', file)
  copyFileSync(join(stubDir, file), target)
  catalogs[name] = {
    file,
    size: statSync(target).size,
    sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
    merkleRoot: productionRoot(rootName)
  }
}

const manifest = {
  firmwareRepo: 'https://github.com/EthereumPhone/PQ1',
  firmwareCommit: commit,
  catalogs
}
writeFileSync(join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`synced 4 catalogs from ${commit.slice(0, 8)}`)
