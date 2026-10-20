# Accounts

A PQ1 holds 256 accounts, numbered 0 to 255. Each is a smart-contract wallet with the same address on every chain. Adding PQ1 accounts to your wallet means reading their addresses from the device, letting the user check one on the device screen, and storing three fields per account. This page covers listing, verifying, storing and the checks the SDK runs before every signature.

## List accounts

```ts
const accounts = await pq1.getAccounts()                        // accounts 0-4
const more = await pq1.getAccounts({ start: 5, count: 5 })      // accounts 5-9
```

- `start` defaults to 0 and `count` to 5. The whole range must lie within 0-255, otherwise the call rejects with code `invalid-request`.
- The device derives the addresses itself, with no network. The first address after unlocking can take up to a second; later ones are quick.
- If the PQ1 is locked, the user is asked for the PIN on the device first.

Each result is a `Pq1Account`:

```ts
type Pq1Account = {
  index: number           // 0-255, the account number on the device
  address: `0x${string}`  // the same on every chain
  deviceId: string        // which PQ1 it belongs to (12 hex characters)
}
```

There are no derivation paths to choose and nothing chain-specific to store.

## Store all three fields

Keep `index`, `address` and `deviceId` together, and pass the object back as `account` to every call (`signMessage`, `prepareTransaction`, …). The type the wallet methods take is `AccountRef`: `index` and `address` are required, `deviceId` is optional but recommended.

The `address` is what you show and what dapps see. The `index` tells the device which key to use. The `deviceId` lets the SDK notice when a different PQ1 is plugged in.

## Verify an address on the device

Before a user shares a receive address, let them compare it with the device screen:

```ts
try {
  await pq1.showAddress(account)
  // The user confirmed on the PQ1 that the address matches.
} catch (e) {
  if (isPq1Error(e) && e.code === 'rejected') {
    // The user pressed cancel on the device: it doesn't match, or they changed their mind.
  } else if (isPq1Error(e) && e.code === 'outdated') {
    // Firmware older than protocol 0x0202 can't show addresses. Ask the user to update.
  }
}
```

The device shows the full address and waits up to two minutes for the user to confirm; the call resolves with the address once they do. This is the only way to be sure the address on the computer screen hasn't been tampered with, so offer it wherever you show an address for receiving funds.

## The checks before every signature

`createPq1Wallet` checks the connected PQ1 against the account before it asks the device to sign anything:

1. If the account has a `deviceId`, it must equal the connected device's id.
2. The device's account `index` must derive to the stored `address`. The SDK reads it once per device and index and remembers it.

Either mismatch rejects with code `wrong-device` (user message: "This account belongs to a different PQ1. Connect the PQ1 you added this account with, and try again.") and nothing reaches the device's signing commands. Without these checks, another PQ1 would sign with its own keys for the same account number and produce a signature that fails verification, or a transaction that the network rejects.

## Adding accounts later

Call `getAccounts` again with another range at any time, for example from an "Add account" button. Existing accounts are unaffected. Two PQ1s set up with the same seed produce the same accounts and the same `deviceId`; the SDK treats them as the same device.

## Same address on every chain

An account's address comes from the factory (deployed at the same address on every PQ1 chain with CREATE2) and the account's key, so it is the same on Ethereum, Base and Base Sepolia. It has no code on a chain until its first transaction there (see [Concepts](./concepts.md#deployment-happens-with-the-first-transaction)). Funds sent to it before that are safe; the first transaction deploys the wallet and can spend them. `pq1.isDeployed({ address, chainId })` tells you which state it's in.

## Without the wallet facade

If you use `Pq1Device` directly (`getAccounts`, `getAddress`, `showAddress`, `getDeviceId`), the same data is available, but the device checks above are yours to do. See the `pq1-sdk/aa` functions in [Transactions](./transactions.md#lower-level-pipeline).

Next: [Transactions](./transactions.md) · [Message signing](./message-signing.md) · [Security](./security.md)
