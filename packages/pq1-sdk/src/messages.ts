// Message and typed-data signing (`personal_sign`, `eth_signTypedData_v4`).
//
// A PQ1 signature is SPHINCS+, not ECDSA, so it can't be recovered with
// `ecrecover`: verifiers check it on-chain through the wallet's ERC-1271
// `isValidSignature`, or through ERC-6492 for a wallet that isn't deployed
// on that chain yet. That is why every signature is bound to a chain.

import {
  encodeAbiParameters,
  hashMessage,
  hashTypedData,
  isAddress,
  type TypedDataDefinition
} from 'viem'

import { resolvePq1AccountState, type Pq1AccountState } from './aa/accountState'
import type { CallTrailerDeps } from './aa/callTrailers'
import { assertSupportedChain } from './aa/send'
import { buildErc7730Eip712Pieces } from './erc7730/eip712'
import { buildErc7730BundleForEip712 } from './erc7730/lookup'
import { Pq1Error, userFacingError } from './errors'
import { buildStructuredOffchainRequest, structuredCapability } from './offchain/structuredSign'
import { classifyStructuredTypedData } from './offchain/structuredTypedData'
import type { ChainReader } from './rpc'
import { bytesToHex0x, hexToBytes } from './transport/bytes'
import type { DeviceCommands } from './transport/commands'
import type { SignOffchainBundle, SignOffchainRequest } from './transport/offchain'
import { personalSignFitsDevice } from './transport/personalSignView'

/** A Safe / CoW typed-data request whose domain names a different chain
 *  than the one the request was made on. */
const STRUCTURED_WRONG_NETWORK_MESSAGE =
  "This signature request is for a different network than the one you're on. Switch to that network in the app and try again. Nothing was signed."

/** A Safe / CoW typed-data request from an account not yet deployed on
 *  this network: neither a Safe nor CoW Swap can check its signature. */
const STRUCTURED_UNDEPLOYED_MESSAGE =
  "Your PQ1 account isn't set up on this network yet, so a Safe or CoW Swap can't check this signature. Send one transaction from the account on this network first, then try again. Nothing was signed."

/** A message to sign: a string is signed as its UTF-8 bytes; `{ raw }` as
 *  the given bytes. `personal_sign` passes hex data: use `{ raw: data }`. */
export type Pq1SignableMessage = string | { raw: `0x${string}` | Uint8Array }

/** EIP-712 typed data, as `eth_signTypedData_v4` passes it (parsed). */
export type Pq1TypedData =
  | TypedDataDefinition
  | {
      domain?: Record<string, unknown>
      types: Record<string, readonly { name: string; type: string }[]>
      primaryType: string
      message: Record<string, unknown>
    }

/** What signing a message needs. */
export type SignOffchainContext = {
  ctx: CallTrailerDeps
  device: Pick<DeviceCommands, 'signOffchain' | 'getCapabilities'>
  /** The chain the signature will be verified on. */
  chain: Pick<ChainReader, 'chainId' | 'getCode' | 'call'>
  accountIndex: number
  /** The account's address. */
  sender: `0x${string}`
  supportedChainIds?: readonly number[]
}

const messageBytes = (message: Pq1SignableMessage): Uint8Array => {
  if (typeof message === 'string') return new TextEncoder().encode(message)
  return typeof message.raw === 'string' ? hexToBytes(message.raw) : message.raw
}

/**
 * Sign `message` (EIP-191 `personal_sign`). The device shows it as text, or
 * as hex when it isn't text. A message too long for the device's screen is
 * signed as its EIP-191 hash, and the device warns that it can only show
 * the hash.
 *
 * Returns the ERC-1271 signature (`abi.encode(ownerIndex, sig)`), or the
 * ERC-6492 signature for a wallet not deployed on this chain yet.
 */
export async function signPq1Message(
  c: SignOffchainContext,
  message: Pq1SignableMessage
): Promise<`0x${string}`> {
  assertSupportedChain(c.chain.chainId, c.supportedChainIds)
  // Live on-chain state → set the firmware's account_deployed flag and the
  // active slot. On the counterfactual path the device emits an ERC-6492
  // blob and the firmware requires slot_index=0 (the only owner the factory
  // seeds); on the deployed path the freshly-derived slot is used.
  const state = await readAccountState(c)
  const bytes = messageBytes(message)
  const request: SignOffchainRequest = personalSignFitsDevice(bytes)
    ? // Pass the raw message — firmware computes the EIP-191 prefix hash
      // and shows the message on its screen before signing: as text (line
      // breaks kept), or as hex when it isn't text.
      { kind: 'personal_sign', message: bytes }
    : // The message doesn't fit the device's pages (over 700 bytes, over
      // 512 bytes of non-text shown as hex, or too many lines). Fall back
      // to raw32 mode using the EIP-191 digest computed on this side. The
      // device will only show the digest, not the message.
      { kind: 'raw32', digest: hexToBytes(hashMessage({ raw: bytes })) }
  const bundle = await c.device.signOffchain({ ...request, ...commonFields(c, state) })
  return toSignature(bundle, state.ownerIndex)
}

/**
 * Sign EIP-712 typed data, on the first route that fits:
 *   1. the device's own Safe transaction or CoW order screens (firmware that
 *      reports the capability bit);
 *   2. an ERC-7730 descriptor, so the device names each field;
 *   3. the EIP-712 hash, signed blind behind a loud warning on the device.
 * A request sent on one route is never retried on a weaker one.
 *
 * Returns the ERC-1271 signature, or the ERC-6492 one for a wallet not
 * deployed on this chain yet.
 */
export async function signPq1TypedData(
  c: SignOffchainContext,
  typedData: Pq1TypedData
): Promise<`0x${string}`> {
  assertSupportedChain(c.chain.chainId, c.supportedChainIds)
  const state = await readAccountState(c)
  const td = typedData as TypedDataDefinition
  const request =
    (await structuredRequest(c, td, state.isDeployed)) ??
    (await descriptorRequest(c, td)) ??
    blindHashRequest(td)
  const bundle = await c.device.signOffchain({ ...request, ...commonFields(c, state) })
  return toSignature(bundle, state.ownerIndex)
}

function commonFields(c: SignOffchainContext, state: Pq1AccountState) {
  return {
    accountIndex: c.accountIndex,
    slotIndex: state.slotIndex,
    chainId: BigInt(c.chain.chainId),
    accountDeployed: state.isDeployed
  } as const
}

/** Fresh on-chain deploy status + active slot/ownerIndex. Values saved when
 *  the account was added go stale after an owner-slot rotation, and a stale
 *  ownerIndex makes every ERC-1271 verification fail (see
 *  `resolvePq1AccountState`). */
async function readAccountState(c: SignOffchainContext): Promise<Pq1AccountState> {
  try {
    return await resolvePq1AccountState(c.chain, c.sender)
  } catch (e) {
    throw new Pq1Error('rpc', `reading the wallet's on-chain state failed: ${String(e)}`, {
      cause: e,
      userMessage:
        "Couldn't check your PQ1 account on this network. Check your internet connection and try again."
    })
  }
}

/** A Safe transaction or CoW order the device can show natively (off-chain
 *  kinds 4 / 5), or null. The device re-derives the EIP-712 hash and signs
 *  what a blind sign of it would. The route is chosen by the device's
 *  capability bit only, so a refusal on this route is final. */
async function structuredRequest(
  c: SignOffchainContext,
  typedData: TypedDataDefinition,
  isDeployed: boolean
): Promise<SignOffchainRequest | null> {
  const structured = classifyStructuredTypedData(typedData)
  if (structured.kind === 'other') return null
  if (structured.chainId !== BigInt(c.chain.chainId)) {
    throw userFacingError(
      'invalid-request',
      STRUCTURED_WRONG_NETWORK_MESSAGE,
      `${structured.kind} domain chain ${structured.chainId} != request chain ${c.chain.chainId}`
    )
  }
  const capabilities = await c.device.getCapabilities()
  if (!(capabilities & structuredCapability(structured))) {
    c.ctx.logger.warn(
      `signTypedData: this PQ1's firmware can't show a ${structured.kind} — signing its hash blind`
    )
    return null
  }
  if (!isDeployed) {
    throw userFacingError(
      'invalid-request',
      STRUCTURED_UNDEPLOYED_MESSAGE,
      `${structured.kind} from an undeployed wallet`
    )
  }
  return buildStructuredOffchainRequest(c.ctx, structured)
}

/** Typed data an ERC-7730 descriptor covers (off-chain kind 2), or null:
 *  the device then shows its fields the way the descriptor names them.
 *  Needs a descriptor for `(chainId, verifyingContract)` and a message of
 *  static fields only (see `buildErc7730Eip712Pieces`). */
async function descriptorRequest(
  c: SignOffchainContext,
  typedData: TypedDataDefinition
): Promise<SignOffchainRequest | null> {
  const domain = (typedData.domain ?? {}) as Record<string, unknown>
  const { verifyingContract } = domain
  if (typeof verifyingContract !== 'string' || !isAddress(verifyingContract, { strict: false })) {
    return null
  }
  const pieces = buildErc7730Eip712Pieces({
    domain: { ...domain, verifyingContract },
    types: typedData.types as never,
    primaryType: typedData.primaryType as string,
    message: typedData.message as Record<string, unknown>
  })
  if (!pieces) return null
  const erc7730Bundle = await buildErc7730BundleForEip712(c.ctx, {
    chainId: c.chain.chainId,
    verifyingContract,
    primaryTypeHash: pieces.primaryTypeHash
  })
  if (!erc7730Bundle) return null
  return { kind: 'eip712_typed', ...pieces, erc7730Bundle }
}

/** The EIP-712 hash, signed blind (off-chain kind 0): the device shows a
 *  loud BLIND HASH page and the hash. Used, intentionally, for typed data
 *  the device has no other route for. */
function blindHashRequest(typedData: TypedDataDefinition): SignOffchainRequest {
  return { kind: 'raw32', digest: hexToBytes(hashTypedData(typedData)) }
}

/** Map a device sign bundle to the signature the verifier consumes: the
 *  firmware's ready-made ERC-6492 blob for counterfactual wallets, or the
 *  ERC-1271 ownerIndex wrapper for deployed ones. */
function toSignature(bundle: SignOffchainBundle, ownerIndex: bigint): `0x${string}` {
  if (bundle.kind === 'counterfactual') {
    // Firmware already produced the ERC-6492-wrapped blob (factory +
    // factoryCalldata + sigWrapper + 0x6492…6492 magic). Pass it straight
    // through to the dapp.
    return bytesToHex0x(bundle.erc6492Sig)
  }
  return wrapSignature(bundle.innerSig, ownerIndex)
}

/** Pack the device's raw SPHINCS+C10 signature into the wrapper the
 *  PQSmartWallet's `_validateSignature` expects:
 *  `abi.encode(uint256 ownerIndex, bytes innerSig)`. */
export function wrapSignature(innerSig: Uint8Array, ownerIndex: bigint): `0x${string}` {
  return encodeAbiParameters(
    [
      { name: 'ownerIndex', type: 'uint256' },
      { name: 'signature', type: 'bytes' }
    ],
    [ownerIndex, bytesToHex0x(innerSig)]
  )
}
