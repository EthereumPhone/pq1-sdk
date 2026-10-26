# Message signing

`signMessage` (`personal_sign`) and `signTypedData` (`eth_signTypedData_v4`) produce signatures that are verified by the account's contract, not by `ecrecover`. The device shows the message, or the typed data in the most readable form it supports, before the user confirms. Every signature is bound to a chain, because what the verifier checks depends on whether the account is deployed there. This page covers both methods, what the device shows, the signature formats and how verifiers check them.

## `signMessage`

```ts
const signature = await pq1.signMessage({ account, chainId: 8453, message: 'Sign in to example.com' })
```

`message` is either:

| Value | Signed as |
| --- | --- |
| a string | its UTF-8 bytes |
| `{ raw: '0x…' }` or `{ raw: Uint8Array }` | exactly these bytes |

`personal_sign` from a dapp passes its data as hex, so forward it as `{ raw: data }`:

```ts
case 'personal_sign': {
  const [data] = params as [`0x${string}`, string]
  return pq1.signMessage({ account, chainId, message: { raw: data } })
}
```

The signature is the standard EIP-191 one (`"\x19Ethereum Signed Message:\n" + length + message`), so dapps verify it like any smart-account `personal_sign`.

### What the device shows

The device shows the message itself whenever it fits its screen:

| Message | Shown as |
| --- | --- |
| Printable ASCII and line breaks, up to 72 rows of 16 characters | text |
| Anything else, up to 512 bytes | hex, under a "NOT TEXT" warning |
| Over 700 bytes, over 72 rows, or non-text over 512 bytes | only its EIP-191 hash, under a blind-signing warning |

In the last case the SDK computes the EIP-191 hash and asks the device to sign that hash. The signature is identical to one over the full message; only the display differs. If your wallet shows its own preview, tell the user to compare carefully when the device can only show a hash.

## `signTypedData`

```ts
const signature = await pq1.signTypedData({ account, chainId: 1, typedData })
```

`typedData` is the parsed EIP-712 object (`domain`, `types`, `primaryType`, `message`), as viem's `TypedDataDefinition` or as dapps send it in `eth_signTypedData_v4` (after `JSON.parse`).

The SDK takes the **first route that fits**:

| # | Route | When | What the device shows |
| --- | --- | --- | --- |
| 1 | Native Safe / CoW / Permit2 screens | `primaryType` is a Safe `SafeTx`, a CoW Protocol `Order` or a Uniswap Permit2 permit without a witness (`PermitSingle`, `PermitBatch`, `PermitTransferFrom`, `PermitBatchTransferFrom`) with the exact canonical types, and the device reports the matching capability bit (`CAP_OFFCHAIN_SAFE_TX`, `CAP_OFFCHAIN_COW_ORDER`, `CAP_OFFCHAIN_PERMIT2`) | The Safe transaction, the order or the permit (spender, tokens, amounts, expiry), decoded, with token amounts and names |
| 2 | ERC-7730 descriptor | The ERC-7730 catalog has a descriptor for `(chainId, verifyingContract)` and the type's hash, and the message has only fixed-size fields (`address`, `uintN`, `intN`, `bytesN`, `bool`) | Each field labelled the way the descriptor names it |
| 3 | Blind hash | Anything else | The EIP-712 hash, behind a loud "BLIND" warning |

The route is decided before anything is sent. **A request refused on one route is never retried on a weaker one**: a refused Safe transaction must not come back as a blind hash the user might approve without understanding it. The firmware requires this of every host (see [`usb-protocol-v2.md`](https://github.com/EthereumPhone/PQ1/blob/0313a2ef/docs/companion/usb-protocol-v2.md)). If the device refuses, the call rejects with code `sign-refused`, and the device screen says why.

Routes 1 and 2 need the catalogs (see [Clear signing](./clear-signing.md)). Without them, a Safe transaction or a permit still gets the native screen but shows raw token addresses and amounts, and ERC-7730 typed data falls back to the blind hash.

The SDK refuses some typed data up front, in plain language, because the device or the verifier would refuse it anyway:

- A Safe, CoW or Permit2 request whose domain `chainId` isn't the `chainId` you passed ("This signature request is for a different network…").
- A Safe, CoW or Permit2 request from an account not yet deployed on that chain. None of them unwraps ERC-6492 signatures (Permit2 checks a signer without code with `ecrecover`), so the user must send one transaction from the account on that chain first.
- A permit the device would refuse: the same token named twice, more than six tokens, or a zero spender or token. It is refused with code `cannot-display` on every firmware, so a shape the device knows is never signed blind instead.

## Chain binding and signature formats

Pass the chain the signature will be **verified** on. The SDK reads the account's state on that chain first:

| Account on `chainId` | Returned signature |
| --- | --- |
| Deployed | ERC-1271: `abi.encode(uint256 ownerIndex, bytes sphincsSignature)`, 4,128 bytes |
| Not deployed yet | ERC-6492: the device wraps the ERC-1271 signature with the factory call that deploys the wallet and the `0x6492…6492` magic suffix, 8,608 bytes |

The `ownerIndex` is read fresh from the chain each time (see [Concepts](./concepts.md#owner-slots)). Signing for a chain outside the wallet's `chains` rejects with `unsupported-network`, because a signature there would point to contracts that don't exist.

## Verifying PQ1 signatures

A SPHINCS+ signature can't be recovered to an address: `ecrecover`, `recoverMessageAddress` and similar EOA-only checks always fail. Verify it the smart-account way:

- **Deployed account:** call `isValidSignature(bytes32 hash, bytes signature)` on the account; it returns `0x1626ba7e` for a valid signature (ERC-1271). `hash` is the EIP-191 hash for messages, the EIP-712 hash for typed data.
- **Undeployed account:** use an ERC-6492-aware verifier, which simulates the deployment and then calls `isValidSignature` in one `eth_call`.

viem's public-client actions do both:

```ts
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

const client = createPublicClient({ chain: base, transport: http() })
const valid = await client.verifyMessage({ address: account.address, message: 'Sign in to example.com', signature })
// client.verifyTypedData({ address, ...typedData, signature }) for typed data
```

Use the client action, not viem's standalone `verifyMessage` utility, which only handles EOAs.

### Safe owners

A PQ1 account can own a Safe. Its signatures for Safe transactions (route 1 above, or the raw hash) verify only on **Safe v1.5.0 and later**, whose `checkSignatures` calls the `bytes32` form of `isValidSignature`. Safe v1.3.0 and v1.4.1 call the legacy `isValidSignature(bytes, bytes)`, which the PQ1 wallet doesn't implement. Safes older than v1.3.0 use a different hash and can't be used at all.

## Not supported

- `eth_sign` (signing an arbitrary 32-byte hash on a dapp's behalf) is not offered. Reject it with EIP-1193 code `4200`, as the example wallet does.
- Typed data with `string`, `bytes`, array or nested-struct fields is not sent on the descriptor route; unless it is a Safe, CoW or Permit2 request, it is signed as its blind hash. UniswapX's witness permits (`PermitWitnessTransferFrom`) are among them.

Next: [Clear signing](./clear-signing.md) · [dApp provider](./dapp-provider.md) · [Errors](./errors.md) · [Security](./security.md)
