// The MV3 helpers against a fake `navigator.hid` and a fake `chrome` API.

import { installFakeHid } from '../testing/installFakeHid'
import { FakePq1Device } from '../testing/fakeDevice'
import {
  chromeStorageCache,
  extensionCatalogs,
  getWebHidSupport,
  hasPq1Permission,
  notifyPermissionGranted,
  onPermissionGranted,
  Pq1DeviceManager,
  requestPq1Permission
} from '.'

/** Just enough of `chrome.*` for these helpers. */
function installFakeChrome() {
  const storage: Record<string, unknown> = {}
  const listeners = new Set<(message: unknown) => void>()
  const chromeApi = {
    runtime: {
      id: 'fake-extension-id',
      getURL: (path: string) => `chrome-extension://fake-extension-id/${path}`,
      sendMessage: vi.fn(async (message: unknown) => listeners.forEach((l) => l(message))),
      onMessage: {
        addListener: (l: (message: unknown) => void) => listeners.add(l),
        removeListener: (l: (message: unknown) => void) => listeners.delete(l)
      }
    },
    storage: {
      local: {
        get: async (key: string) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (items: Record<string, unknown>) => Object.assign(storage, items)
      }
    }
  }
  ;(globalThis as { chrome?: unknown }).chrome = chromeApi
  return { chromeApi, storage, uninstall: () => delete (globalThis as { chrome?: unknown }).chrome }
}

describe('permission helpers', () => {
  it('reports no WebHID where there is none', () => {
    const hid = installFakeHid(null)
    hid.uninstall()
    expect(getWebHidSupport()).toEqual({ supported: false, reason: 'no-webhid' })
  })

  it('asks for the device only when it is not granted yet', async () => {
    const fake = new FakePq1Device()
    const hid = installFakeHid(fake, { granted: false })
    try {
      expect(getWebHidSupport()).toEqual({ supported: true })
      expect(await hasPq1Permission()).toBe(false)
      expect(await requestPq1Permission()).toBe(fake)
      expect(await hasPq1Permission()).toBe(true)
      expect(fake.opened).toBe(false)
    } finally {
      hid.uninstall()
    }
  })

  it('tells the service worker about a new permission', async () => {
    const chrome = installFakeChrome()
    try {
      const callback = vi.fn()
      const remove = onPermissionGranted(callback)
      await notifyPermissionGranted()
      expect(callback).toHaveBeenCalledTimes(1)
      remove()
      await notifyPermissionGranted()
      expect(callback).toHaveBeenCalledTimes(1)
    } finally {
      chrome.uninstall()
    }
  })
})

describe('Pq1DeviceManager', () => {
  it('opens the granted device once and reuses it', async () => {
    const fake = new FakePq1Device()
    const hid = installFakeHid(fake)
    try {
      const onChange = vi.fn()
      const manager = new Pq1DeviceManager({ onChange })
      const [a, b] = await Promise.all([manager.getDevice(), manager.getDevice()])
      expect(a).toBe(b)
      expect(await manager.getDevice()).toBe(a)
      expect(onChange).toHaveBeenCalledWith(true)
      expect(manager.isConnected()).toBe(true)
    } finally {
      hid.uninstall()
    }
  })

  it('reconnects after an unplug', async () => {
    const fake = new FakePq1Device()
    const hid = installFakeHid(fake)
    try {
      const onChange = vi.fn()
      const manager = new Pq1DeviceManager({ onChange })
      const first = await manager.getDevice()
      hid.unplug()
      expect(onChange).toHaveBeenLastCalledWith(false)
      const second = await manager.getDevice()
      expect(second).not.toBe(first)
      expect(await second.getAddress(0)).toBe(fake.addressOf(0))
    } finally {
      hid.uninstall()
    }
  })

  it('never shows the picker: no granted device means disconnected', async () => {
    const hid = installFakeHid(new FakePq1Device(), { granted: false })
    try {
      await expect(new Pq1DeviceManager().getDevice()).rejects.toMatchObject({
        code: 'disconnected'
      })
    } finally {
      hid.uninstall()
    }
  })
})

describe('extension storage and catalogs', () => {
  it('keeps the cache in chrome.storage.local', async () => {
    const chrome = installFakeChrome()
    try {
      const cache = chromeStorageCache('test:')
      expect(await cache.get('k')).toBeUndefined()
      await cache.set('k', 'v')
      expect(await cache.get('k')).toBe('v')
      expect(chrome.storage['test:k']).toBe('v')
    } finally {
      chrome.uninstall()
    }
  })

  it("loads catalogs from the extension's own files", async () => {
    const chrome = installFakeChrome()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2])))
    try {
      const blob = await extensionCatalogs('pq1/').load('names')
      expect(Array.from(blob)).toEqual([1, 2])
      expect(fetchSpy).toHaveBeenCalledWith('chrome-extension://fake-extension-id/pq1/names_db.bin')
    } finally {
      fetchSpy.mockRestore()
      chrome.uninstall()
    }
  })
})
