// Runs in each page's isolated world: injects the provider (inpage.js) into
// the page and relays its requests to the service worker over a port.

import { CONTENT_TARGET, INPAGE_TARGET, PROVIDER_PORT } from './shared'

// A <script> tag from the extension's own files, not `world: "MAIN"`: it
// runs before the page's scripts and isn't blocked by the page's CSP.
const script = document.createElement('script')
script.src = chrome.runtime.getURL('inpage.js')
script.onload = () => script.remove()
;(document.head ?? document.documentElement).appendChild(script)

let port: chrome.runtime.Port | null = null

/** The service worker can be restarted at any time; reconnect on demand. */
function getPort(): chrome.runtime.Port {
  if (port) return port
  const next = chrome.runtime.connect({ name: PROVIDER_PORT })
  next.onMessage.addListener((message) => {
    window.postMessage({ target: INPAGE_TARGET, ...message }, window.location.origin)
  })
  next.onDisconnect.addListener(() => {
    if (port === next) port = null
  })
  port = next
  return next
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.target !== CONTENT_TARGET) return
  const { id, method, params } = event.data as { id: number; method: string; params?: unknown[] }
  getPort().postMessage({ id, method, params })
})

// Connect once so events (accountsChanged, chainChanged) reach the page.
getPort()
