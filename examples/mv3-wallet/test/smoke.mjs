// Loads the built extension into Chromium (no PQ1 needed) and checks that a
// dapp sees the provider: EIP-6963 announcement, eth_chainId,
// wallet_getCapabilities, and no accounts before connecting.
//
//   npm run build && npm run test:smoke
//
// Needs Playwright's Chromium (`npx playwright install chromium`), or set
// CHROMIUM_PATH to a Chromium build. Branded Google Chrome no longer loads
// unpacked extensions from the command line.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const build = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const profile = mkdtempSync(join(tmpdir(), 'pq1-example-'))

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>dapp</title><h1>dapp</h1>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const dappUrl = `http://127.0.0.1:${server.address().port}/`

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`]
})

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const extensionId = new URL(worker.url()).host
  console.log(`extension ${extensionId} loaded`)

  const page = await context.newPage()
  await page.goto(dappUrl)
  const result = await page.evaluate(async () => {
    const announced = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no EIP-6963 announcement')), 5000)
      window.addEventListener('eip6963:announceProvider', (event) => {
        clearTimeout(timer)
        resolve(event.detail)
      })
      window.dispatchEvent(new Event('eip6963:requestProvider'))
    })
    const { info, provider } = announced
    return {
      info: { name: info.name, rdns: info.rdns, icon: info.icon.slice(0, 10) },
      chainId: await provider.request({ method: 'eth_chainId' }),
      accounts: await provider.request({ method: 'eth_accounts' }),
      capabilities: await provider.request({ method: 'wallet_getCapabilities', params: [] })
    }
  })
  assert.equal(result.info.name, 'PQ1 Example Wallet')
  assert.equal(result.info.icon, 'data:image')
  assert.equal(result.chainId, '0x14a34')
  assert.deepEqual(result.accounts, [])
  assert.equal(result.capabilities['0x14a34'].atomic.status, 'supported')
  console.log('dapp provider ok:', JSON.stringify(result.info))

  const connect = await context.newPage()
  await connect.goto(`chrome-extension://${extensionId}/connect.html`)
  assert.equal(await connect.isVisible('#connect'), true)
  assert.equal(
    await connect.isDisabled('#connect'),
    false,
    'WebHID should be available in Chromium'
  )
  console.log('connect page ok')
} finally {
  await context.close()
  server.close()
  rmSync(profile, { recursive: true, force: true })
}
console.log('smoke test passed')
