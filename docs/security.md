# Security

The PQ1 is built so that your wallet does not have to be trusted with funds: keys and the PIN never leave the device, and the device shows the user what it signs and signs only what it showed. Your wallet is still trusted with the user's privacy and with getting the user to look at the right screen. This page lists the invariants an integration must keep, why each exists, and what the SDK already enforces for you.

## Threat model in one paragraph

Treat the host (your extension, the browser, the computer) as untrusted for custody and trusted for privacy. A compromised host can refuse to sign, show the user lies in its own UI, and learn everything the user does, but it cannot sign a transaction the user didn't see on the device, extract a key, or learn the PIN. Everything the host sends the device as "metadata" (token names, descriptors, Safe transactions, CoW orders) is checked on the device against roots in its firmware or re-hashed into the signed value, so a lying host makes the device show less or refuse, never show something false.

## Invariants for integrators

### The device screen is the source of truth

Tell users to check the device, not your popup. Your approval window is a convenience; it can be wrong (a bug, a compromised extension). The device shows the signer account and its full address, the action, the fee and a fingerprint for every transaction. Copy such as "Check the details on your PQ1's screen and confirm there" belongs in your UI next to every approve button.

### The PIN never crosses USB

`Pq1Device.unlock()` sends an UNLOCK command with no data; the user types the PIN on the device's buttons and the secure world checks it. Never build a PIN field in your UI. Ten wrong PINs wipe the device.

### Verify receive addresses on the device

An address your UI shows can be replaced by malware. Before a user shares a receive address, offer `pq1.showAddress(account)` (protocol 0x0202 and later): the device derives the address itself, shows it in full, and waits for the user to confirm it matches. Cancelling throws `rejected`.

### Sign only with the PQ1 the account came from

Store `deviceId` with each account (`getAccounts` returns it). Before every operation, `createPq1Wallet` checks that the connected device's id matches and that the device's account `index` derives the stored `address`. Another PQ1 would sign with its own keys for the same account number. If you use the lower-level functions directly, do the same check yourself.

### Never downgrade a signing route

Typed data takes the strongest route the device supports: its own Safe/CoW screens, then an ERC-7730 descriptor, then the EIP-712 hash behind a loud blind-signing warning. The SDK picks the route once, from the device's capability bits and the catalogs, and never retries a refused request on a weaker route. Don't add such a retry: it would turn every "I can't show you this" refusal into a blind signature, which is exactly what a hostile dapp wants. The same goes for transactions: never re-send a refused call stripped of its clear-signing data.

### Cache the init code

To estimate gas for a wallet's first transaction, the SDK asks the device for the wallet's init code (GET_INIT_CODE). Each call makes the device sign with the wallet's **bootstrap key**, without asking the user. That key is a few-time hash-based signature key: its security margin shrinks with every signature it makes, and it can never be rotated, because the wallet's address depends on it. The firmware deliberately puts no counter or cap on this command (a cap could leave a device that refuses to deploy) and relies on the host to cache the result per account and chain until the wallet is deployed. The firmware's analysis rates this LOW: it is not a theft path, and the forgery work stays above 128 bits until about 99,000 bootstrap signatures under one key ([`docs/VULN-getinitcode-bootstrap-fewtime-oracle.md`](https://github.com/EthereumPhone/PQ1/blob/0313a2ef/docs/VULN-getinitcode-bootstrap-fewtime-oracle.md)).

What the SDK does: `Pq1Device.getInitCode` caches in memory and in the `cache` store (`chromeStorageCache()` by default in `Pq1DeviceManager`, so the cache survives service-worker restarts), and it never asks for the init code on a chain without the factory. What you should do: keep that default, and don't call `device.commands.getInitCode` in a loop.

### Catalogs and API answers are untrusted data

The catalogs are verified on the device entry by entry, so serving them from a CDN or your own server loses no security; a tampered file only makes proofs fail. Safe Transaction Service and CoW API answers are re-hashed by the SDK and must equal the hash or uid in the calldata; the device re-derives them again from the bytes it shows. A mismatch is refused and reported to your logger.

### Don't leak which addresses are PQ1 accounts

Answer `eth_getCode` with the undeployed-wallet stub only for the user's own PQ1 account, on a PQ1 chain, to a site connected to it (`isPq1AccountCodeQuery`). See [dapp-provider.md](dapp-provider.md).

### Keep test fakes out of production

`pq1-sdk/testing` (`FakePq1Device`, fake chain, fake bundler) runs no cryptography and returns filler signatures. Import it only from tests. A build that ships it can't sign anything valid, but it can confuse users and reviewers.

## What your wallet can see

From the firmware's disclosure ([`docs/companion/companion-privacy-disclosure.md`](https://github.com/EthereumPhone/PQ1/blob/0313a2ef/docs/companion/companion-privacy-disclosure.md)): the device never lets the host see a secret, and the host necessarily sees almost everything else.

| The wallet can see | The wallet can never see |
| --- | --- |
| Every address the user uses, and that they belong to one device | The seed or any part of it |
| The full contents of every transaction it builds | The PIN |
| When and how often the user signs, and in what order | Any signing key |
| Which chains are used, and balances if it queries them | Anything about a request the user rejected, beyond the rejection |

So your wallet is a privacy dependency even though it is not a custody dependency. Practical consequences:

- Don't send transaction contents, addresses or device ids to your servers unless the user agreed.
- The same seed gives the same address on every chain, so on-chain observers can link activity across chains. Users who want separation can use different account numbers (0-255); offer more than account 0.
- RPC providers, the bundler, the Safe service and the CoW API see the requests your wallet sends them, with the user's IP.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md) for how to report a vulnerability in the SDK. Vulnerabilities in the device firmware go to the firmware repository, [EthereumPhone/PQ1](https://github.com/EthereumPhone/PQ1).

Next: [testing.md](testing.md) · [clear-signing.md](clear-signing.md) · [protocol.md](protocol.md)
