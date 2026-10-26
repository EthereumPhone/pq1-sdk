# Troubleshooting

Most PQ1 integration problems come from four places: the operating system not letting the browser open the device (Linux), the browser not having permission or WebHID at all, the device being locked or refusing, and network services (bundler, RPC, catalogs). Find your symptom below; each entry gives the cause and the fix. Error codes refer to `Pq1Error.code` (see [errors.md](errors.md)).

## Quick reference

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Linux: the picker lists nothing, or opening fails | No udev rule, so the browser can't open the hidraw node | Install the udev rule (below), then replug |
| The device picker shows nothing on any OS | Not plugged in, a charge-only cable, or the device is still booting | Try another cable/port; wait for the home screen; the picker filters on VID 0x1209 / PID 0x7051 |
| `disconnected` in the service worker, though the PQ1 is plugged in | This browser profile was never granted the device, or the permission was removed, or the accounts came from another browser via sync | Open your connect page and call `requestPq1Permission()` again; permissions don't sync between browsers or profiles |
| `requestDevice` throws or returns nothing in the popup | Chrome closes the action popup when the picker opens; in the service worker there is no user gesture | Call `requestPq1Permission()` from a click handler on a full extension tab |
| `navigator.hid` is undefined in the service worker | Chrome older than 117 | Require Chrome 117+ (`"minimum_chrome_version": "117"`) |
| `unsupported` | Firefox or Safari (no WebHID) | Check `getWebHidSupport()` and hide PQ1 options there |
| `locked` keeps coming back | The device locks itself after 2 minutes without use (USB traffic doesn't extend it) | Expected; the SDK asks for the PIN again. Keep the time between prepare and send short |
| `rejected` right after an unlock | The PIN was cancelled or wrong | Let the user retry. Ten wrong PINs wipe the device |
| The device asks "Update signature count?" before signing | The wallet's on-chain off-chain signature count is above the device's (restore, second device with the same seed, reflash) | Expected; the user confirms on the device. A `! CAREFUL` page appears for large jumps. If it would leave 0 signatures the device refuses (`refused`) |
| `sign-refused` | The device couldn't show the request in full (descriptor binding, rendering or page budget) and named the reason on its screen | Don't retry it; read the screen. Make sure catalogs load (see below) |
| `outdated` | Firmware too old: batch signing needs protocol 0x0200, `showAddress` 0x0202 | Update the PQ1 |
| `unsupported-network` | Chain not in `chains`, no `rpc` for it, or the factory has no code there | Use a PQ1 chain (see [compatibility.md](compatibility.md)) and configure its RPC |
| `firmware-mismatch` | The device's init code targets another factory, or the factory predicts another address | Update firmware and SDK together; report it if both are current |
| `bundler-unreachable` | No answer to the gas estimate (network, wrong key, bundler down) | Check the bundler URL and API key; nothing was sent, so retrying is safe |
| `bundler-rejected` with "doesn't have enough ETH" (AA21) | The account can't pay the fee (the first transaction also pays for deployment) | Fund the account address on that chain |
| `bundler-rejected` with "still being processed" (AA25) | Nonce conflict: another UserOp from the account is pending, or the prepared transaction is stale | Wait for the pending one, then prepare again |
| `bundler-rejected`: "would most likely fail" | Even with the verifier stubbed, the estimate failed: the calls would revert | Check the calls (balance, allowance, target) |
| `send-unconfirmed` | The bundler didn't answer the send, or the receipt didn't arrive in time | Don't resend. Poll `getUserOperationReceipt` or check the explorer |
| Raw addresses and amounts on the device, logger warns "catalog unavailable" | Catalogs not copied into the build, wrong `basePath`, or a CDN error | Check that `<extension>/pq1/erc20_db.bin` exists and matches `extensionCatalogs('pq1/')`; check the logger output |
| Every catalog lookup fails proof on the device | Catalogs from a different firmware release than the device | Use the `pq1-sdk-catalogs` version that matches the firmware; don't rebuild or trim the files |
| A dapp says the signature is invalid | The dapp uses `ecrecover`, or doesn't support ERC-6492 for an undeployed account | The dapp must verify through ERC-1271 / ERC-6492 (viem's `verifyMessage` does). Workaround: send one transaction to deploy the account on that chain |
| Safe rejects the PQ1 owner's signature | Safe v1.3.0 and v1.4.1 call the legacy `isValidSignature(bytes,bytes)`, which the PQ1 wallet doesn't implement | Use Safe v1.5.0 or later |
| Safe `approveHash` refused with `cannot-display` | No `safeTxService`, no API key, or the Safe service doesn't know the transaction yet | Pass `safeTransactionService({ apiKey })`; make sure the transaction was proposed to the service |
| CoW pre-signature refused with `cannot-display` | The order isn't in the CoW orderbook yet, or the chain has no CoW API (Base Sepolia) | Post the order first; use Ethereum or Base |
| A signature fails randomly while connecting from a page | Two contexts (a page and the service worker) talk to the device at once and read each other's replies | Keep the only connection in the service worker (`Pq1DeviceManager`); pages only grant permission |

## Linux: udev rule

On Linux the browser can only open the PQ1 if your user has access to its hidraw device. Install this rule (from the firmware's [`tools/99-pqsigner.rules`](https://github.com/EthereumPhone/PQ1/blob/0313a2ef/tools/99-pqsigner.rules)):

```
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="7051", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="usb", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="7051", MODE="0666", TAG+="uaccess"
```

```sh
sudo tee /etc/udev/rules.d/99-pqsigner.rules > /dev/null <<'EOF'
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="7051", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="usb", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="7051", MODE="0666", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules
```

Then unplug and replug the PQ1. If your wallet has Linux users, link this section from your connect page.

## Checking what the device reports

```ts
const device = await pq1.getDevice()
console.log(await device.getInfo())   // { protocolVersion, capabilities, firmwareVersion }
console.log(await device.getStatus()) // { locked, pinRemaining }
```

`firmwareVersion` is a placeholder on current firmware; gate features on `protocolVersion` and `capabilities` only.

## Debugging the service worker

- `chrome://extensions` → your extension → "service worker" opens its DevTools; the SDK's default logger writes `[pq1]` lines there.
- `chrome://device-log` shows HID open/close errors from the browser.
- An open device connection keeps the service worker alive. If it does stop, `Pq1DeviceManager` reconnects on the next request.

Next: [errors.md](errors.md) · [extension-architecture.md](extension-architecture.md) · [compatibility.md](compatibility.md)
