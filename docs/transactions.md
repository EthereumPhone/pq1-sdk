# Transactions

Sending from a PQ1 account means building one ERC-4337 UserOperation for up to four calls, having the device sign it, and handing it to a bundler. The SDK splits this in two so your wallet can show the fee before the device is involved: `prepareTransaction` builds the operation and its fee, `sendPrepared` has the device sign it and submits it. `waitForReceipt` then waits until it is on-chain. This page covers the steps, fees, limits, the first deployment, bundler requirements and the failure cases that need care.

## The steps

```ts
const prepared = await pq1.prepareTransaction({ account, chainId: 8453, calls })
// show prepared.fee.maxCost, prepared.isFirstDeploy …
const { userOpHash } = await pq1.sendPrepared(prepared, account)
const receipt = await pq1.waitForReceipt({ chainId: 8453, userOpHash })
```

| Method | What happens | Device involved |
| --- | --- | --- |
| `prepareTransaction({ account, chainId, calls, fee? })` | Checks the request, reads the wallet's state (deployed?, nonce, active slot, off-chain count), gets the init code on a first deployment, asks the bundler for a gas estimate, fits the fee to the device screen. Signs and sends nothing. | Only on a first deployment, for the init code (no prompt) |
| `sendPrepared(prepared, account)` | Syncs the device's off-chain count if needed, attaches the clear-signing data, has the device sign, submits to the bundler. Resolves with `{ userOpHash, chainId }` as soon as the bundler accepts it. | Yes: the user confirms on the PQ1 |
| `waitForReceipt({ chainId, userOpHash, timeoutMs?, pollIntervalMs?, signal? })` | Polls `eth_getUserOperationReceipt` (every 2 s, for up to 3 minutes by default). | No |
| `sendTransaction({ account, chainId, calls, fee? })` | `prepareTransaction` + `sendPrepared` in one call, when you don't need to show the fee first. Also returns `prepared`. | Yes |

A call is `{ to, value?, data? }`; `value` defaults to `0n` and `data` to `'0x'`.

## What `prepareTransaction` returns

| Field | Meaning |
| --- | --- |
| `fee.maxCost` | The most the transaction can cost, in wei: `gasLimit × maxFeePerGas`. This is what the device shows. The actual cost is usually lower. |
| `fee.gasLimit` | `callGasLimit + verificationGasLimit + preVerificationGas` |
| `fee.maxFeePerGas`, `fee.maxPriorityFeePerGas` | Fee per gas, after rounding (below) |
| `isFirstDeploy` | This transaction also deploys the wallet on this chain. The fee is higher this once, and the device shows an extra deploy page. |
| `wallet` | The state it was built on: `isDeployed`, `slotIndex`, `ownerIndex`, `nonce`, `onchainOffchainCount` |
| `userOp` | The unsigned UserOperation (JSON, hex fields) |
| `calls`, `chainId`, `accountIndex`, `sender` | What you asked for, normalised |

**Send it soon.** A prepared transaction is built on the wallet's current nonce. If another transaction from the account lands first, the bundler rejects this one (an `AA25` error, worded for the user as "Another transaction from this account is still being processed…"). Prepare again in that case.

## Fees

Where the fee per gas comes from, in order:

1. The `fee` you pass: `{ maxFeePerGas, maxPriorityFeePerGas }` in wei.
2. The bundler's own suggestion, if it has one. `pimlicoBundler` uses `pimlico_getUserOperationGasPrice`, tier `fast` by default (option `gasPriceTier`).
3. Otherwise the chain: `maxPriorityFeePerGas` from `eth_maxPriorityFeePerGas`, and `maxFeePerGas = 2 × latest base fee + maxPriorityFeePerGas`.

The verification gas is fixed at 800,000 (a SPHINCS+ check costs about 214k gas on a deployed wallet and about 760k on the first deployment, hard for a bundler to simulate). The call gas and pre-verification gas come from the bundler's estimate.

### Rounding for the device screen

The device refuses to sign a fee it can't show exactly on its 16-column screen; it never rounds a figure it signs. Fees with wei-level dust have no exact short form, so `prepareTransaction` runs `fitFeesForDeviceDisplay`. When the figures don't fit, it rounds the total gas up to a multiple of 10,000 (by adding to `callGasLimit`, which is a limit: unused gas is refunded) and `maxFeePerGas` up to a multiple of 10,000 wei (a cap: the wallet pays base fee plus tip, not the cap). The priority fee is only rounded if its own row doesn't fit. The values in `prepared.fee` are the rounded ones, so what you show is what the device shows. If even the rounded figures don't fit, the call rejects with code `cannot-display` ("The PQ1 can't show this network fee on its screen…").

## What the device shows

For each transaction, the PQ1 shows the decoded calls (as far as the clear-signing data allows; see [Clear signing](./clear-signing.md)), the signing account number and its full address, the target, the exact gas and fee, and a two-page fingerprint of the operation. A first deployment adds a deploy page. A batch shows each call ("Tx i of N") and asks once more at the end. Cancelling anywhere cancels the whole transaction, and `sendPrepared` rejects with code `rejected`.

When the device's off-chain signature count is behind the wallet's, it first asks **"Update signature count?"** (see [Concepts](./concepts.md#the-off-chain-signature-counter)).

## Limits

| Limit | Value | Error if exceeded |
| --- | --- | --- |
| Calls per transaction | 4 (`MAX_BATCH_TXS`) | `too-large`, "A PQ1 can approve up to 4 actions in one transaction…" |
| Call data per call | 4,096 bytes (`MAX_TX_LEN`) | `too-large` |
| Contract creation (a call without `to`) | not possible: the wallet has no CREATE path | `invalid-request` |
| Empty call list | not allowed | `invalid-request` |
| Fee payment | ETH, from the account itself; no paymasters | the bundler rejects with `AA21` if the balance is too low |
| Chains | the wallet's `chains` (default `PQ1_SUPPORTED_CHAIN_IDS`: 1, 8453, 84532) | `unsupported-network` |

All of these are checked before any device or network work. Batches of two or more calls need firmware protocol `0x0200` or later (code `outdated` otherwise).

Some calls need extra data the SDK fetches, and are refused without it, because the device would refuse them anyway: a Safe `approveHash` needs the Safe transaction it approves (pass `safeTxService`), and a CoW Protocol `setPreSignature` needs the order from the CoW API. See [Clear signing](./clear-signing.md).

## The first transaction on a chain

When the account has no code on the chain, `prepareTransaction`:

1. checks that the factory is deployed on this chain (before asking the device anything: `unsupported-network` otherwise);
2. gets the init code from the device, or from the cache (see [Concepts](./concepts.md#why-the-init-code-is-cached));
3. checks that the init code calls the expected factory and that the factory predicts the account's address. A mismatch means the firmware and the contracts disagree: `firmware-mismatch`, reported to your logger, nothing signed;
4. estimates the operation including the deployment.

The signed operation carries the init code, and the wallet exists on that chain once it is included.

## Bundler requirements

The SDK talks to the bundler through the `Pq1Bundler` interface. `pimlicoBundler({ apiKey })` is ready-made, and `erc4337Bundler({ url: (chainId) => string | undefined })` works with any bundler that:

- serves **EntryPoint v0.6** (`0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`), and
- accepts a **state override** as the third parameter of `eth_estimateUserOperationGas`.

The state override matters because estimation can't use a real signature: the operation isn't signed yet. The wallet only executes calls after a passing SPHINCS+ check, so with a placeholder signature the simulation would revert. The SDK therefore replaces the SPHINCS+ verifier contract, for the simulation only, with a stub that accepts any signature. Execution never calls the verifier, so the call-gas estimate stays exact.

## Failures that need care

| Code | When | What to do |
| --- | --- | --- |
| `bundler-unreachable` | No answer to the gas estimate | Nothing was sent. Retry is safe. |
| `bundler-rejected` (a `BundlerError`) | The bundler answered with an error: the estimate predicts a revert, the balance is too low (`AA21`), the nonce is stale (`AA25`)… | Nothing was sent. `message` has the bundler's own text for your logs; `userMessage` is plain language. |
| `send-unconfirmed` | No answer to `eth_sendUserOperation`, or `waitForReceipt` timed out | The transaction **may have gone through**. Never retry blindly: the user could pay twice. Tell them to check their balance or activity first. |
| `rejected` | The user cancelled on the device | Nothing was sent. Don't retry without the user asking. |
| `locked` | The device locked mid-operation | Handled for you: the SDK unlocks (PIN on the device) and replays the operation once. A `locked` error only comes from the device, before anything reaches the bundler, so the replay can't send twice. |

A receipt doesn't mean success: check `receipt.success`. An included operation can still have reverted, and still paid its fee.

## Answering `eth_sendTransaction`

Dapps expect a transaction hash they can look up on an explorer, not a UserOperation hash. Wait for the receipt and return `receipt.transactionHash`:

```ts
const { userOpHash } = await pq1.sendPrepared(prepared, account)
const receipt = await pq1.waitForReceipt({ chainId, userOpHash })
return receipt.transactionHash
```

For `wallet_sendCalls` (EIP-5792), return the `userOpHash` as the batch id and answer `wallet_getCallsStatus` from the bundler's receipt. See [dApp provider](./dapp-provider.md).

## Lower-level pipeline

`pq1-sdk/aa` exposes the steps `createPq1Wallet` uses, for wallets with their own device or account handling. They don't run the device-id and address checks of the facade (see [Accounts](./accounts.md#the-checks-before-every-signature)), and they don't wrap errors.

```ts
import { createChainReader, createPq1Context, pimlicoBundler, Pq1Device } from 'pq1-sdk'
import {
  prepareTransaction,
  signPreparedTransaction,
  submitUserOperation,
  waitForUserOperationReceipt
} from 'pq1-sdk/aa'

const ctx = createPq1Context({ catalogs, logger })
const chain = createChainReader(8453, 'https://mainnet.base.org')
const bundler = pimlicoBundler({ apiKey })
const device = await Pq1Device.connect({ requestPermission: false, cache })
await device.unlock()

const prepared = await prepareTransaction({
  chain,
  bundler,
  device: { getInitCode: (index, chainId) => device.getInitCode(index, Number(chainId)) },
  logger: ctx.logger,
  accountIndex: 0,
  sender: account.address,
  calls
})
const userOp = await signPreparedTransaction({ ctx, device: device.commands, prepared })
const userOpHash = await submitUserOperation(bundler, prepared.chainId, userOp)
const receipt = await waitForUserOperationReceipt(bundler, prepared.chainId, userOpHash)
```

Pass `device.getInitCode` (as above), not `device.commands.getInitCode`, so the persistent init-code cache is used. `suggestFees(chain, bundler)`, `readWalletState`, `fitFeesForDeviceDisplay` and the UserOp helpers (`buildUserOp`, `finalize`) are exported too.

## Chains

`PQ1_SUPPORTED_CHAIN_IDS` is `[1, 8453, 84532]`: the chains the factory is deployed on. Narrow it with the `chains` option of `createPq1Wallet`. Adding a chain only works once the factory, verifier and EntryPoint v0.6 are deployed there at the expected addresses; see [Compatibility](./compatibility.md).

Next: [Message signing](./message-signing.md) · [Clear signing](./clear-signing.md) · [dApp provider](./dapp-provider.md) · [Errors](./errors.md)
