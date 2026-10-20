// Install a fake device as `navigator.hid`, for code that discovers the PQ1
// itself (`Pq1Device.connect()`, `Pq1DeviceManager`, `requestPq1Permission`).

import type { FakePq1Device } from './fakeDevice'

type Listener = (event: { device: unknown }) => void

/**
 * Make `navigator.hid` return `device` (or no device, with `null`). The
 * device counts as already granted unless `granted` is false, in which case
 * `requestDevice` grants it. Returns helpers to simulate an unplug and to
 * restore the previous `navigator.hid`.
 */
export function installFakeHid(
  device: FakePq1Device | null,
  options: { granted?: boolean } = {}
): { unplug(): void; uninstall(): void } {
  const nav = globalThis.navigator as Navigator | undefined
  if (!nav)
    throw new Error(
      'installFakeHid needs a global `navigator` (Node 21+ or a DOM test environment)'
    )
  const previous = Object.getOwnPropertyDescriptor(nav, 'hid')
  let granted = options.granted ?? true
  const listeners: Record<string, Listener[]> = {}
  Object.defineProperty(nav, 'hid', {
    configurable: true,
    value: {
      getDevices: async () => (device && granted ? [device] : []),
      requestDevice: async () => {
        if (!device) return []
        granted = true
        return [device]
      },
      addEventListener: (type: string, listener: Listener) => {
        listeners[type] = [...(listeners[type] ?? []), listener]
      },
      removeEventListener: (type: string, listener: Listener) => {
        listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener)
      }
    }
  })
  return {
    unplug() {
      if (!device) return
      device.opened = false
      for (const listener of listeners.disconnect ?? []) listener({ device })
    },
    uninstall() {
      if (previous) Object.defineProperty(nav, 'hid', previous)
      else delete (nav as unknown as Record<string, unknown>).hid
    }
  }
}
