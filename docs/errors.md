# Errors

Every error the SDK throws on purpose is a `Pq1Error` with three parts: a stable `code` to branch on, a plain-language `userMessage` that is safe to show as is, and a technical `message` for your logs. The high-level `Pq1Wallet` methods throw nothing else: anything unexpected is reported to your logger and wrapped as `code: 'unknown'`. This page lists every code, what your wallet should do about it, and how device status words map to codes.

## The model

```ts
import { getUserMessage, isPq1Error, Pq1Error, PQ1_ERROR_MESSAGES, toPq1Error } from 'pq1-sdk'

try {
  await pq1.signMessage({ account, chainId, message: 'hello' })
} catch (e) {
  showToUser(getUserMessage(e)) // a Pq1Error's userMessage, or a generic text for anything else
  log(e)                        // e.message is technical; e.cause holds the underlying error
  if (isPq1Error(e) && e.code === 'disconnected') openConnectPage()
}
```

| Member | Meaning |
| --- | --- |
| `code: Pq1ErrorCode` | Stable string. Branch on it; key your own translations by it. |
| `userMessage: string` | Plain language, no jargon. Defaults to `PQ1_ERROR_MESSAGES[code]`; some refusals carry a more specific text. |
| `message: string` | Technical detail (status words, addresses, bundler messages). Never show it to users. |
| `cause` | The underlying error, when there was one. |

Helpers:

- `isPq1Error(e)`: true for a `Pq1Error`, including one from another copy of the SDK (it checks the shape, not only `instanceof`).
- `getUserMessage(e, fallback?)`: `userMessage` for a `Pq1Error`, else `fallback` (default `PQ1_ERROR_MESSAGES.unknown`). Use it so a raw `TypeError` text never reaches the UI.
- `toPq1Error(e, code = 'unknown')`: wraps anything as a `Pq1Error`, keeping it as `cause`.

Two subclasses add fields:

- `DeviceError` (`code` is a `DeviceErrorCode` or `device-protocol`) has `sw`, the device's status word when there was one.
- `BundlerError` (`code: 'bundler-rejected'`) has `rpcCode` and `data` from the bundler's JSON-RPC error. Its `message` is the bundler's own text (for example `AA21 didn't pay prefund`); its `userMessage` explains the common ones: `AA21` (not enough ETH for the fee) and `AA25` (another transaction from this account is still being processed).

## Every code

| Code | Meaning | Default `userMessage` | What to do |
| --- | --- | --- | --- |
| `disconnected` | Not plugged in, or this browser isn't allowed to use it yet. | The PQ1 isn't connected. Plug it in with the USB cable and try again. If it's already plugged in, connect it once more from the wallet's PQ1 setup screen, so this browser is allowed to use it. | Offer a button to your connect page (which calls `requestPq1Permission()`). Retry after the user acts. |
| `locked` | The device is locked. | The PQ1 is locked. Unlock it with your PIN and try again. | Retry: the wallet facade unlocks on demand and already replays once after an idle lock mid-operation. |
| `rejected` | The user rejected on the device, or the PIN entry was cancelled or wrong. | The request was rejected on the PQ1. | Never retry automatically. |
| `timeout` | No reply in time (user didn't respond, or the device went away). | The PQ1 didn't respond in time. Check the device screen, then try again. | Let the user retry. |
| `refused` | The unlocked device refused the command (first-boot setup running, off-chain counter policy, a firmware rule). | The PQ1 refused this request. If it's showing its first-time setup, finish that first. Otherwise, check the device screen for the reason. | Point the user to the device screen. |
| `outdated` | The firmware is too old for this command (batch signing, showing an address). | This needs a newer version of the PQ1 software. Update your PQ1 and try again. | Ask the user to update the firmware. |
| `sign-refused` | The device refused to sign because it couldn't show the request in full. | The PQ1 refused to sign this because it couldn't show you every detail of it. Its screen says why. Nothing was signed or sent. | Don't retry, and never retry on a weaker route (see [security.md](security.md)). |
| `unsupported` | The browser has no WebHID (Firefox, Safari). | Your browser doesn't support WebHID, which the PQ1 needs. Please use a Chromium-based browser such as Chrome, Brave or Edge. | Hide PQ1 features or explain; use `getWebHidSupport()` up front. |
| `device-protocol` | A malformed reply or an unexpected status word. A bug or firmware mismatch. | Something went wrong while talking to the PQ1. Unplug it, plug it back in, and try again. | Reported to your logger. Let the user retry once; report persistent cases. |
| `wrong-device` | The connected PQ1 isn't the one the account belongs to (device id or address differs). | This account belongs to a different PQ1. Connect the PQ1 you added this account with, and try again. | Ask the user to plug in the right PQ1. |
| `unsupported-network` | The chain isn't enabled, has no RPC configured, or has no PQ1 factory. | PQ1 accounts aren't available on this network. Switch to a network that supports PQ1 and try again. | Ask the user to switch network. |
| `too-large` | More calls (over 4) or more data (over 4096 bytes per call) than one signature covers. | This request is too large for the PQ1 to show on its screen, so it can't sign it. Nothing was signed or sent. | Split the request; some refusals carry a specific text such as "up to 4 actions". |
| `cannot-display` | The SDK refused before the device saw it: Safe or CoW data unavailable, a Safe DelegateCall outside MultiSendCallOnly, a fee the screen can't show. | The PQ1 can't show you all the details of this request, so it won't be signed. Nothing was signed or sent. | Show `userMessage` (often more specific). Configure `safeTxService` / `cowApiUrl` if that's the cause (see [clear-signing.md](clear-signing.md)). |
| `firmware-mismatch` | The device would deploy the account somewhere the factory doesn't predict. | This PQ1's software doesn't match this version of the wallet. Update the wallet and the PQ1, then try again. Nothing was sent. | Reported to your logger. Ask the user to update both. |
| `invalid-request` | The caller asked for something the PQ1 can't do: contract creation, no calls, a typed-data domain on another chain, Safe/CoW typed data from an undeployed account. | The PQ1 can't sign this kind of request. Nothing was signed or sent. | Show `userMessage` (often specific); fix the request. |
| `bundler-unreachable` | The bundler didn't answer the gas estimate. | The wallet couldn't reach the service that sends PQ1 transactions. Check your internet connection and try again. Nothing was sent. | Safe to retry. |
| `send-unconfirmed` | The bundler didn't answer the send, or `waitForReceipt` timed out. | We couldn't confirm whether your transaction was sent. Wait a minute and check your balance before trying again, so it isn't sent twice. | Never retry blindly: the transaction may be included later. Poll the receipt instead. |
| `bundler-rejected` | The bundler answered with an error, or the estimate says the UserOp would fail. | The network rejected this transaction, so nothing was sent. Check your balance and try again. | Show `userMessage` (AA21 and AA25 get specific text; a failed estimate says the transaction would most likely fail). Re-prepare before retrying. |
| `rpc` | A chain read failed. | The wallet couldn't read the network. Check your internet connection and try again. | Retry; check your RPC. |
| `unknown` | Anything unexpected (wrapped by `toPq1Error`). | Something went wrong while using your PQ1. Unplug it, plug it back in, and try again. | Reported to your logger. |

## Translating

`PQ1_ERROR_MESSAGES` holds the English defaults. To translate, key your own strings by `code`, and fall back to `userMessage` for codes whose refusals carry a specific text (`too-large`, `cannot-display`, `invalid-request`, `bundler-rejected`):

```ts
const text = translations[locale][e.code] ?? e.userMessage
```

## The logger

Pass a `logger` to `createPq1Wallet` (default: `console`). `warn(message, details)` receives recoverable problems (a catalog that didn't load, a failed chain read the SDK worked around); `error(error, context)` receives unexpected errors and anything worth a crash report (`device-protocol`, `firmware-mismatch`, a Safe or CoW API answer that doesn't match what is being signed). Hook `error` to Sentry or similar.

## Device status words

The device answers every command with an ISO 7816 status word. `DeviceCommands` turns them into codes:

| SW | Firmware meaning | SDK code |
| --- | --- | --- |
| `9000` | OK | — |
| `61xx` | More data; send GET_RESPONSE | handled by the transport |
| `6700` | Wrong length | `device-protocol` |
| `6982` | Wrong PIN, or the user rejected / cancelled (also a cancelled address check) | `rejected` |
| `6984` | Idle wipe mid-operation (the 2-minute auto-lock hit) | `locked` |
| `6985` | Overloaded: locked, PIN locked, not set up yet, off-chain counter refusals, a stale or foreign session | the SDK sends the ungated GET_STATUS: `locked` if the device reports locked, else `refused` |
| `6A80` | Wrong data (rare in practice, see below) | `device-protocol` |
| `6D00` | INS not supported | `outdated` for GET_INIT_CODE, else `device-protocol` |
| `6E00` | CLA not supported | `device-protocol` |
| `6F00` | Internal error. On a sign command this is almost always the device refusing what it can't show in full, after naming the reason on screen. | `sign-refused` on SIGN_USEROP, SIGN_USEROP_BATCH and SIGN_OFFCHAIN; else `device-protocol` |

Most secure-world parse and policy refusals come back as `6F00`, not the `6A80` the firmware's protocol table suggests. See [protocol.md](protocol.md).

Next: [troubleshooting.md](troubleshooting.md) · [dapp-provider.md](dapp-provider.md) · [security.md](security.md)
