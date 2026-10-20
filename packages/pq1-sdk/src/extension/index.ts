// Helpers for Manifest V3 browser extensions.
//
// The architecture they support (see docs/extension-architecture.md):
//
//   extension page (tab)                    service worker
//   ───────────────────                     ──────────────
//   button click → requestPq1Permission()
//   notifyPermissionGranted()  ───────────► onPermissionGranted(...)
//                                           Pq1DeviceManager owns the one
//                                           connection: getDevices(), open,
//                                           unlock, sign, reconnect
//
// `navigator.hid.requestDevice()` needs a user gesture, which only a page
// has (Chrome closes the action popup while its picker is open, so use a
// tab). The service worker can then open the granted device with
// `getDevices()`, Chrome 117 and later, and an open device keeps the worker
// alive. Keeping the only connection in the worker means two contexts never
// talk to the PQ1 at once, which would mix up their replies.

import {
  CATALOG_FILE_NAMES,
  consoleLogger,
  httpCatalogs,
  type CatalogSource,
  type Pq1Logger
} from '../context'
import { Pq1Device } from '../device'
import { Pq1Error } from '../errors'
import type { KeyValueStore } from '../store'
import { findGrantedPq1, isWebHidSupported, PQ1_HID_FILTERS } from '../transport/hid'

export { CATALOG_FILE_NAMES }

/** The `chrome` (or `browser`) extension API, if there is one. */
function extensionApi(): typeof chrome | undefined {
  const g = globalThis as { chrome?: typeof chrome; browser?: typeof chrome }
  return g.chrome?.runtime?.id ? g.chrome : g.browser?.runtime?.id ? g.browser : undefined
}

function requireExtensionApi(): typeof chrome {
  const api = extensionApi()
  if (!api) throw new Error('not running in a browser extension')
  return api
}

/** Whether this browser can talk to a PQ1. Firefox and Safari have no
 *  WebHID; show `PQ1_ERROR_MESSAGES.unsupported` there instead of a
 *  connect button. */
export function getWebHidSupport():
  { supported: true } | { supported: false; reason: 'no-webhid' } {
  return isWebHidSupported() ? { supported: true } : { supported: false, reason: 'no-webhid' }
}

/**
 * Ask the user to allow this extension to use their PQ1 (the browser's
 * device picker). Call it from a click handler on an extension page — a tab,
 * not the action popup, which closes when the picker opens. Resolves with
 * the chosen device, still closed, or null if the user cancelled. Then call
 * `notifyPermissionGranted()` so the service worker connects.
 */
export async function requestPq1Permission(): Promise<HIDDevice | null> {
  if (!isWebHidSupported()) throw new Pq1Error('unsupported', 'WebHID is not available')
  const already = await findGrantedPq1()
  if (already) return already
  const picked = await navigator.hid.requestDevice({ filters: PQ1_HID_FILTERS })
  return picked[0] ?? null
}

/** Whether this extension may already use a PQ1 (needs no user gesture;
 *  works in the service worker). The PQ1 must also be plugged in. */
export async function hasPq1Permission(): Promise<boolean> {
  return (await findGrantedPq1()) !== null
}

/** The runtime message `notifyPermissionGranted` sends. */
export const PQ1_PERMISSION_GRANTED_MESSAGE = 'pq1:permission-granted'

/** Tell the service worker the user just granted a PQ1 (call from the page
 *  after `requestPq1Permission`). */
export async function notifyPermissionGranted(): Promise<void> {
  await requireExtensionApi().runtime.sendMessage({ type: PQ1_PERMISSION_GRANTED_MESSAGE })
}

/** Run `callback` in the service worker whenever a page reports a newly
 *  granted PQ1. Returns a function that removes the listener. */
export function onPermissionGranted(callback: () => void): () => void {
  const api = requireExtensionApi()
  const listener = (message: unknown) => {
    if ((message as { type?: unknown } | null)?.type === PQ1_PERMISSION_GRANTED_MESSAGE) callback()
  }
  api.runtime.onMessage.addListener(listener)
  return () => api.runtime.onMessage.removeListener(listener)
}

/** Options for `Pq1DeviceManager`. */
export interface Pq1DeviceManagerOptions {
  /** Where to keep the init-code cache. Default `chromeStorageCache()` in
   *  an extension, else in memory. */
  cache?: KeyValueStore
  logger?: Pq1Logger
  /** Called when the PQ1 is connected or goes away. */
  onChange?: (connected: boolean) => void
}

/**
 * Owns the one connection to the PQ1 in an extension service worker (or any
 * long-lived context). `getDevice()` returns the open device, reconnecting
 * after an unplug, a stale handle or a worker restart. It never shows the
 * device picker: if no PQ1 is granted yet, it throws `disconnected`, and
 * your UI should send the user to the page that calls
 * `requestPq1Permission()`.
 */
export class Pq1DeviceManager {
  private device: Pq1Device | null = null

  private connecting: Promise<Pq1Device> | null = null

  private readonly cache?: KeyValueStore

  private readonly logger: Pq1Logger

  constructor(private readonly options: Pq1DeviceManagerOptions = {}) {
    this.cache = options.cache ?? (extensionApi() ? chromeStorageCache() : undefined)
    this.logger = options.logger ?? consoleLogger
  }

  /** The connected PQ1 (not necessarily unlocked; `createPq1Wallet` unlocks
   *  it). Concurrent calls share one connection attempt. */
  async getDevice(): Promise<Pq1Device> {
    if (this.device && (await this.isHealthy(this.device))) return this.device
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  /** Whether a PQ1 is connected right now. */
  isConnected(): boolean {
    return this.device?.isConnected() ?? false
  }

  /** Close the connection (the next `getDevice()` reopens it). */
  async close(): Promise<void> {
    const device = this.device
    this.device = null
    if (device) {
      await device.close()
      this.options.onChange?.(false)
    }
  }

  /** Probe an existing handle with the ungated GET_STATUS: a stale handle
   *  after an unplug/replug or an OS drop fails it, and is replaced. */
  private async isHealthy(device: Pq1Device): Promise<boolean> {
    if (!device.isConnected()) return false
    try {
      await device.getStatus()
      return true
    } catch (e) {
      this.logger.warn('existing PQ1 handle is stale, reconnecting', e)
      await this.close()
      return false
    }
  }

  private async connect(): Promise<Pq1Device> {
    const device = await Pq1Device.connect({
      requestPermission: false,
      cache: this.cache,
      logger: this.logger
    })
    device.onDisconnect = () => {
      if (this.device === device) this.device = null
      this.options.onChange?.(false)
    }
    this.device = device
    this.options.onChange?.(true)
    return device
  }
}

/** Catalogs shipped inside the extension, under `basePath` (default
 *  `pq1/`, i.e. `<extension root>/pq1/erc20_db.bin` and so on). Copy the
 *  files from the `pq1-sdk-catalogs` package into your build. They don't
 *  need to be web-accessible: the service worker reads its own files. */
export function extensionCatalogs(basePath = 'pq1/'): CatalogSource {
  return {
    load(name) {
      return httpCatalogs(requireExtensionApi().runtime.getURL(basePath)).load(name)
    }
  }
}

/** A `KeyValueStore` on `chrome.storage.local`, keys prefixed with
 *  `prefix`. Survives service-worker restarts and browser restarts. */
export function chromeStorageCache(prefix = 'pq1-sdk:'): KeyValueStore {
  return {
    async get(key) {
      const k = prefix + key
      const items = await requireExtensionApi().storage.local.get(k)
      const value = items[k]
      return typeof value === 'string' ? value : undefined
    },
    async set(key, value) {
      await requireExtensionApi().storage.local.set({ [prefix + key]: value })
    }
  }
}
