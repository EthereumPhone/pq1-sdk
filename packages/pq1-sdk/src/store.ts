// A tiny async key-value store, for state the SDK wants to outlive a
// service-worker restart (the init-code cache).

/** Async string key-value storage. `chromeStorageCache()` (in
 *  `pq1-sdk/extension`) backs it with `chrome.storage.local`. */
export interface KeyValueStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

/** A `KeyValueStore` in memory: gone when the page or worker goes. */
export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value)
    }
  }
}
