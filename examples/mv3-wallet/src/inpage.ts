// The EIP-1193 provider dapps talk to, announced through EIP-6963. Runs in
// the page's own JavaScript world.

import { CONTENT_TARGET, INPAGE_TARGET } from './shared'

type Listener = (...args: unknown[]) => void

class ExampleProvider {
  private nextId = 1

  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >()

  private listeners = new Map<string, Set<Listener>>()

  constructor() {
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.target !== INPAGE_TARGET) return
      const { id, result, error, event: name, data } = event.data
      if (name) {
        this.emit(name, data)
        return
      }
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      if (error) request.reject(Object.assign(new Error(error.message), { code: error.code }))
      else request.resolve(result)
    })
  }

  request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      window.postMessage({ target: CONTENT_TARGET, id, method, params }, window.location.origin)
    })
  }

  on(event: string, listener: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
    return this
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  private emit(event: string, data: unknown): void {
    this.listeners.get(event)?.forEach((listener) => listener(data))
  }
}

const provider = new ExampleProvider()

// EIP-6963: announce the provider, and again whenever a dapp asks.
// Replace the rdns with a reverse-DNS name of a domain you control.
const info = Object.freeze({
  uuid: crypto.randomUUID(),
  name: 'PQ1 Example Wallet',
  rdns: 'com.example.pq1-wallet',
  icon:
    'data:image/svg+xml;base64,' +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#111"/><text x="12" y="16" font-size="9" font-family="sans-serif" text-anchor="middle" fill="#fff">PQ1</text></svg>'
    )
})
const announce = () =>
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) })
  )
window.addEventListener('eip6963:requestProvider', announce)
announce()
