// The shipped files match the manifest.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'

import { catalogFilePath, catalogNames, manifest } from '../index.js'

for (const name of catalogNames) {
  test(`${name}: size and sha256 match the manifest`, () => {
    const path = catalogFilePath(name)
    const entry = manifest.catalogs[name]
    assert.equal(statSync(path).size, entry.size)
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), entry.sha256)
    assert.match(entry.merkleRoot, /^0x[0-9a-f]{64}$/)
  })
}
