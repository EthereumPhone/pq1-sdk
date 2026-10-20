// Errors for the whole PQ1 stack. Every error the SDK throws on purpose is
// a `Pq1Error`: `message` stays technical so logs are useful, `userMessage`
// is plain language a non-technical user can act on, and `code` is stable so
// a wallet can branch on it or show its own (translated) copy.
//
// This module has no imports, so every other module can depend on it.

/** Device and USB-link outcomes (see `DeviceError`):
 *  - `disconnected`: the PQ1 isn't plugged in, or this browser hasn't been
 *    allowed to use it yet.
 *  - `locked`: the PQ1 is locked; unlock it with the PIN on the device.
 *  - `rejected`: the user rejected the request on the device (or the PIN
 *    entry failed). Never retry without the user asking.
 *  - `timeout`: no reply in time; the device may be gone, or the user
 *    ignored an on-device prompt.
 *  - `refused`: the unlocked device refused the command (first-time setup
 *    still running, or a firmware policy check); its screen says why.
 *  - `outdated`: the firmware is too old for the requested command.
 *  - `sign-refused`: the device refused to sign because it couldn't show
 *    the request in full; its screen names the reason. Never retried.
 *  - `unsupported`: the browser has no WebHID (Firefox, Safari). */
export type DeviceErrorCode =
  | 'disconnected'
  | 'locked'
  | 'rejected'
  | 'timeout'
  | 'refused'
  | 'outdated'
  | 'sign-refused'
  | 'unsupported'

/** Every `Pq1Error.code`. The device codes are documented on
 *  `DeviceErrorCode`; the others:
 *  - `device-protocol`: the device sent something the SDK didn't expect
 *    (a malformed reply, an unknown status word). A bug or a firmware
 *    mismatch, never the user's fault.
 *  - `wrong-device`: the connected PQ1 isn't the one the account belongs to.
 *  - `unsupported-network`: the PQ1 contracts aren't available on the chain.
 *  - `too-large`: the request carries more data than the device can show.
 *  - `cannot-display`: the SDK refused the request before the device saw it,
 *    because the device would need data the SDK couldn't get (a CoW order,
 *    a Safe transaction) or would refuse it anyway.
 *  - `firmware-mismatch`: the device's software doesn't match the contracts
 *    this SDK version expects.
 *  - `invalid-request`: the caller passed something the PQ1 can't do (a
 *    contract deployment, an empty call list, a bad account index).
 *  - `bundler-unreachable`: the bundler didn't answer a gas estimate.
 *    Nothing was sent.
 *  - `send-unconfirmed`: the bundler didn't answer a send. The transaction
 *    may still have gone through: don't retry blindly.
 *  - `bundler-rejected`: the bundler answered with an error (see
 *    `BundlerError`).
 *  - `rpc`: a chain read failed.
 *  - `unknown`: anything else (see `toPq1Error`). */
export type Pq1ErrorCode =
  | DeviceErrorCode
  | 'device-protocol'
  | 'wrong-device'
  | 'unsupported-network'
  | 'too-large'
  | 'cannot-display'
  | 'firmware-mismatch'
  | 'invalid-request'
  | 'bundler-unreachable'
  | 'send-unconfirmed'
  | 'bundler-rejected'
  | 'rpc'
  | 'unknown'

/** Plain-language default text for every error code. Wallets that translate
 *  their UI can key their own strings by `Pq1Error.code` instead. */
export const PQ1_ERROR_MESSAGES: Readonly<Record<Pq1ErrorCode, string>> = {
  disconnected:
    "The PQ1 isn't connected. Plug it in with the USB cable and try again. If it's already plugged in, connect it once more from the wallet's PQ1 setup screen, so this browser is allowed to use it.",
  locked: 'The PQ1 is locked. Unlock it with your PIN and try again.',
  rejected: 'The request was rejected on the PQ1.',
  timeout: "The PQ1 didn't respond in time. Check the device screen, then try again.",
  refused:
    "The PQ1 refused this request. If it's showing its first-time setup, finish that first. Otherwise, check the device screen for the reason.",
  outdated: 'This needs a newer version of the PQ1 software. Update your PQ1 and try again.',
  'sign-refused':
    "The PQ1 refused to sign this because it couldn't show you every detail of it. Its screen says why. Nothing was signed or sent.",
  unsupported:
    "Your browser doesn't support WebHID, which the PQ1 needs. Please use a Chromium-based browser such as Chrome, Brave or Edge.",
  'device-protocol':
    'Something went wrong while talking to the PQ1. Unplug it, plug it back in, and try again.',
  'wrong-device':
    'This account belongs to a different PQ1. Connect the PQ1 you added this account with, and try again.',
  'unsupported-network':
    "PQ1 accounts aren't available on this network. Switch to a network that supports PQ1 and try again.",
  'too-large':
    "This request is too large for the PQ1 to show on its screen, so it can't sign it. Nothing was signed or sent.",
  'cannot-display':
    "The PQ1 can't show you all the details of this request, so it won't be signed. Nothing was signed or sent.",
  'firmware-mismatch':
    "This PQ1's software doesn't match this version of the wallet. Update the wallet and the PQ1, then try again. Nothing was sent.",
  'invalid-request': "The PQ1 can't sign this kind of request. Nothing was signed or sent.",
  'bundler-unreachable':
    "The wallet couldn't reach the service that sends PQ1 transactions. Check your internet connection and try again. Nothing was sent.",
  'send-unconfirmed':
    "We couldn't confirm whether your transaction was sent. Wait a minute and check your balance before trying again, so it isn't sent twice.",
  'bundler-rejected':
    'The network rejected this transaction, so nothing was sent. Check your balance and try again.',
  rpc: "The wallet couldn't read the network. Check your internet connection and try again.",
  unknown: 'Something went wrong while using your PQ1. Unplug it, plug it back in, and try again.'
}

/** Options for a `Pq1Error`. */
export interface Pq1ErrorOptions {
  /** Text for the user. Defaults to `PQ1_ERROR_MESSAGES[code]`. */
  userMessage?: string
  /** The underlying error, if any. */
  cause?: unknown
}

/**
 * The one error type the SDK throws on purpose.
 *
 * - `code`: stable, for branching and for your own translated copy.
 * - `userMessage`: plain language, safe to show as is.
 * - `message`: technical, for logs and bug reports. Don't show it to users.
 */
export class Pq1Error extends Error {
  readonly code: Pq1ErrorCode

  readonly userMessage: string

  constructor(code: Pq1ErrorCode, message?: string, options: Pq1ErrorOptions = {}) {
    const userMessage = options.userMessage ?? PQ1_ERROR_MESSAGES[code]
    super(message ?? userMessage, { cause: options.cause })
    this.name = 'Pq1Error'
    this.code = code
    this.userMessage = userMessage
  }
}

/** True for any error the SDK threw on purpose. Also recognises a
 *  `Pq1Error` from another copy of the SDK, where `instanceof` fails. */
export function isPq1Error(e: unknown): e is Pq1Error {
  if (e instanceof Pq1Error) return true
  if (typeof e !== 'object' || e === null) return false
  const candidate = e as Partial<Pq1Error>
  return (
    typeof candidate.code === 'string' &&
    candidate.code in PQ1_ERROR_MESSAGES &&
    typeof candidate.userMessage === 'string'
  )
}

/** Text to show the user for any error: a `Pq1Error`'s `userMessage`, or
 *  `fallback` for anything else (whose technical message must not reach
 *  the UI). */
export function getUserMessage(e: unknown, fallback: string = PQ1_ERROR_MESSAGES.unknown): string {
  return isPq1Error(e) ? e.userMessage : fallback
}

/** Wraps any error as a `Pq1Error` with `code`, keeping it as `cause`. A
 *  `Pq1Error` is returned unchanged. */
export function toPq1Error(e: unknown, code: Pq1ErrorCode = 'unknown'): Pq1Error {
  if (isPq1Error(e)) return e
  return new Pq1Error(code, e instanceof Error ? e.message : String(e), { cause: e })
}

/** @internal A refusal with its own user text (`userMessage`) and the
 *  technical `detail` for the logs. */
export function userFacingError(
  code: Pq1ErrorCode,
  userMessage: string,
  detail?: string
): Pq1Error {
  return new Pq1Error(code, detail ?? userMessage, { userMessage })
}
