# Extension architecture

In a Manifest V3 extension, the PQ1 should have exactly one owner: the service worker. A page is only needed once, to let the user grant the extension access to the device, because the browser's device picker needs a click. After that, the service worker opens the device by itself, keeps it open, signs, and reconnects when needed. `pq1-sdk/extension` provides the pieces for this layout. This page explains the layout, why it is shaped this way, and what to avoid.

## The layout

```
  Extension page (a tab)                         Service worker
  ──────────────────────                         ──────────────
  user clicks "Connect PQ1"
      │
      ▼
  requestPq1Permission()      browser picker
  (navigator.hid.requestDevice) ───────────► user picks the PQ1
      │
      ▼
  notifyPermissionGranted() ──── runtime ────► onPermissionGranted(cb)
                                  message           │
                                                    ▼
                                             Pq1DeviceManager.getDevice()
                                               navigator.hid.getDevices()
                                               open, keep open, reconnect
                                                    │
                                                    ▼
                                             createPq1Wallet(...)
  pages / popup / dapp requests ── messages ──►  getAccounts, signMessage,
  (never touch the device)                       prepareTransaction, …
                                                    │
                                                    ▼  WebHID
                                                 ┌──────┐
                                                 │ PQ1  │
                                                 └──────┘
```

Everything that talks to the device runs in the service worker. Your UI pages send it messages, as they would for any other wallet operation.

## Why this shape

**Only a page can show the picker.** `navigator.hid.requestDevice()` needs a user gesture, which a service worker never has. Call it from a click handler on an extension page. Permission is granted to the extension's origin, so the service worker can then find the device with `navigator.hid.getDevices()`, which needs no gesture.

**Use a tab, not the action popup.** Chrome closes the action popup as soon as the device picker opens, which kills the `requestDevice()` call. Open your connect page with `chrome.tabs.create({ url: chrome.runtime.getURL('connect.html') })`.

**The service worker can use WebHID.** Since Chrome 117, WebHID is available in extension service workers, and an open device connection keeps the service worker alive ([Chrome docs: Use WebHID](https://developer.chrome.com/docs/extensions/how-to/web-platform/webhid)). Set `"minimum_chrome_version": "117"`.

**One connection, one owner.** PQ1 reports carry no request id: a reply is matched to a request only by order. The SDK queues requests over one connection, so they never overlap. It cannot coordinate two connections opened by two different contexts. If a page and the service worker both open the device, their requests can interleave and one side reads the other's reply, which makes a signature fail at best. Keeping the only connection in the service worker avoids this entirely.

## The pieces

### `requestPq1Permission()` (page)

Shows the picker, filtered to PQ1 devices, unless a PQ1 is already granted. Resolves with the chosen `HIDDevice`, still closed, or `null` if the user cancelled. Throws a `Pq1Error` with code `unsupported` where there is no WebHID.

`hasPq1Permission()` tells you, without a gesture, whether a granted PQ1 is plugged in right now.

### `notifyPermissionGranted()` / `onPermissionGranted(callback)`

A one-line runtime message from the page to the service worker (type `PQ1_PERMISSION_GRANTED_MESSAGE`), so the worker can connect straight away instead of on the first request. `onPermissionGranted` returns a function that removes the listener. Using them is optional; `getDevice()` would find the device on the next request anyway.

### `Pq1DeviceManager` (service worker)

Owns the connection:

- `getDevice()` returns the open `Pq1Device`. If it already has one, it probes it with `GET_STATUS` (works even when the device is locked); a handle that went stale after an unplug, a replug or an OS-level drop fails the probe and is replaced.
- Concurrent `getDevice()` calls share one connection attempt.
- It **never shows the picker**. With no granted PQ1 plugged in, it throws a `Pq1Error` with code `disconnected`. Send the user to your connect page then.
- After an unplug, the next `getDevice()` reconnects.
- It doesn't unlock the device. `createPq1Wallet` does, when an operation needs it.
- Options: `cache` (default `chromeStorageCache()` inside an extension, otherwise in memory), `logger`, and `onChange(connected: boolean)` to update your UI when the PQ1 comes and goes.
- `isConnected()` and `close()` do what they say.

Pass it to the wallet as a function, so every operation gets the current device:

```ts
const manager = new Pq1DeviceManager({ onChange: (connected) => updateBadge(connected) })
const pq1 = createPq1Wallet({ device: () => manager.getDevice(), rpc, bundler, catalogs })
```

### The init-code cache

Each `GET_INIT_CODE` makes the device sign with the account's bootstrap key, which should be used as little as possible (see [Concepts](./concepts.md#why-the-init-code-is-cached)). The SDK caches the init code per device, account and chain. A service worker can be stopped at any time and its memory is lost with it, so in an extension the cache lives in `chrome.storage.local`: `Pq1DeviceManager` uses `chromeStorageCache()` by default. Pass your own `KeyValueStore` (`get`/`set` of strings) if you keep state elsewhere. Entries are a few kilobytes each and contain nothing secret.

### Catalogs as extension files

`extensionCatalogs('pq1/')` loads the clear-signing catalogs from `chrome.runtime.getURL('pq1/<file>')`. The service worker reads its own files, so they don't need to be listed in `web_accessible_resources`. Copy them from `pq1-sdk-catalogs` into Chromium builds only; Firefox and Safari builds can't use a PQ1 and don't need the 10.8 MB. They are loaded the first time a PQ1 request needs one, so users without a PQ1 never load them. Because the device checks every entry against roots in its firmware, you may also serve them from a CDN with `httpCatalogs(url)`. See [Clear signing](./clear-signing.md).

## Manifest

```json
{
  "manifest_version": 3,
  "minimum_chrome_version": "117",
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["storage"]
}
```

- No `"hid"` permission exists or is needed: WebHID access is granted per device through the picker.
- `storage` is for `chromeStorageCache()`.
- If you inject a dapp provider, add your content script and `web_accessible_resources` entry for the in-page script as usual (see `examples/mv3-wallet/static/manifest.json`).

## Browsers without WebHID

Firefox and Safari have no WebHID. Check before showing a PQ1 option:

```ts
import { PQ1_ERROR_MESSAGES } from 'pq1-sdk'
import { getWebHidSupport } from 'pq1-sdk/extension'

if (!getWebHidSupport().supported) {
  showNotice(PQ1_ERROR_MESSAGES.unsupported) // "Your browser doesn't support WebHID, …"
}
```

Accounts added in Chrome and synced to a Firefox profile can't sign there; operations reject with code `unsupported`.

## LavaMoat and other policy tools

The SDK reads every browser global as a plain member chain (`navigator.hid`, `chrome.runtime.getURL`, `chrome.storage.local.get`, ...), never through an alias such as `globalThis.chrome` or a `typeof navigator` check. A policy generator such as LavaMoat's then grants exactly what the SDK uses, and nothing it uses is cut off at runtime. A generated policy for a service worker that uses `pq1-sdk` and `pq1-sdk/extension` looks like this:

```json
"pq1-sdk": {
  "globals": {
    "AbortController": true,
    "TextEncoder": true,
    "chrome.runtime.getURL": true,
    "chrome.runtime.id": true,
    "chrome.runtime.onMessage.addListener": true,
    "chrome.runtime.onMessage.removeListener": true,
    "chrome.runtime.sendMessage": true,
    "chrome.storage.local.get": true,
    "chrome.storage.local.set": true,
    "clearTimeout": true,
    "console.error": true,
    "console.warn": true,
    "fetch": true,
    "navigator.hid": true,
    "setTimeout": true
  },
  "packages": { "viem": true }
}
```

`fetch` reaches the bundler, the CoW and Safe APIs, and the catalogs; `chrome.storage.local` holds the init-code cache. `pq1-sdk/testing` reads `globalThis.navigator` to install a fake device; don't bundle it.

## Don'ts

- **Don't open the device from a page as well as from the service worker.** Replies get mixed up between the two connections. Ask the service worker instead, even for a quick address lookup.
- **Don't call `requestPq1Permission()` from the popup.** The popup closes when the picker opens.
- **Don't call `Pq1Device.connect()` in the service worker without `requestPermission: false`.** It would try the picker, which fails there. `Pq1DeviceManager` does this for you.
- **Don't keep your own in-memory copy of a `Pq1Device` across operations.** Get it from the manager each time, so a replugged device is picked up.
- **Don't skip the cache.** Without a persistent `cache`, a service-worker restart before a first deployment means another bootstrap-key signature.

Next: [Getting started](./getting-started.md) · [Accounts](./accounts.md) · [Troubleshooting](./troubleshooting.md) · [Security](./security.md)
