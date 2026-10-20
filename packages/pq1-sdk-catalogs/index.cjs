// pq1-sdk-catalogs: the four clear-signing catalogs and their manifest.

const path = require('node:path')

const manifest = require('./manifest.json')

const catalogNames = Object.freeze(['erc20', 'names', 'selectors', 'erc7730'])

function catalogFilePath(name) {
  const entry = manifest.catalogs[name]
  if (!entry) throw new Error(`unknown catalog ${name}`)
  return path.join(__dirname, 'data', entry.file)
}

const catalogDir = path.join(__dirname, 'data')

module.exports = { manifest, catalogNames, catalogFilePath, catalogDir }
