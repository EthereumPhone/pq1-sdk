// Builds the example into build/: bundles the scripts with esbuild, copies
// the static files and the PQ1 clear-signing catalogs.
//
//   PIMLICO_API_KEY=... node build.mjs [--watch]

import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'
import { catalogDir } from 'pq1-sdk-catalogs'

const root = dirname(fileURLToPath(import.meta.url))
const out = join(root, 'build')
const watch = process.argv.includes('--watch')

if (!process.env.PIMLICO_API_KEY) {
  console.warn(
    'PIMLICO_API_KEY is not set: the example can sign messages but not send transactions.'
  )
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(root, 'static'), out, { recursive: true })
// The catalogs only need to be in the extension's files: the service worker
// fetches them from its own origin. Chromium builds only (WebHID).
cpSync(catalogDir, join(out, 'pq1'), { recursive: true })

const common = {
  bundle: true,
  target: 'chrome117',
  sourcemap: true,
  logLevel: 'info',
  define: { PIMLICO_API_KEY: JSON.stringify(process.env.PIMLICO_API_KEY ?? '') }
}

const builds = [
  {
    entryPoints: [join(root, 'src/background.ts')],
    outfile: join(out, 'background.js'),
    format: 'esm'
  },
  {
    entryPoints: [join(root, 'src/contentscript.ts')],
    outfile: join(out, 'contentscript.js'),
    format: 'iife'
  },
  { entryPoints: [join(root, 'src/inpage.ts')], outfile: join(out, 'inpage.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/connect.ts')], outfile: join(out, 'connect.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/approve.ts')], outfile: join(out, 'approve.js'), format: 'iife' }
]

if (watch) {
  for (const b of builds) await (await esbuild.context({ ...common, ...b })).watch()
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })))
}
