# Concepts

A PQ1 is not an ECDSA hardware wallet with a different cable. It signs with SPHINCS+, a post-quantum signature scheme, and its accounts are ERC-4337 smart-contract wallets rather than EOAs. This page explains the model behind the SDK: what a PQ1 account is, how it gets deployed, what the device counts, and what a PQ1 signature looks like. Read it once before integrating; most surprises later trace back to one of these points.

## The device

- **Signatures.** The PQ1 signs with SPHINCS+ (parameter set "C10"), a hash-based scheme that stays secure against quantum computers. A signature is 4,008 bytes, about 60 times an ECDSA one. Keys never leave the device, and the PIN is typed on the device; it never crosses USB.
- **Transport.** The browser talks to it over WebHID: APDUs (the ISO 7816 command format Ledger also uses) split across 64-byte HID reports. USB IDs: vendor `0x1209`, product `0x7051`. The wire format is in [Protocol](./protocol.md); you rarely need it.
- **What the user sees.** The device shows every request on its own screen before signing, as readable as the data the SDK attaches allows. See [Clear signing](./clear-signing.md).
- **Locking.** The device locks itself after two minutes without use. The SDK asks it to unlock (the user types the PIN on the device) whenever it needs to.

## Accounts are smart-contract wallets

ECDSA verification is built into Ethereum; SPHINCS+ verification is not. So a PQ1 account is a smart-contract wallet, `PQSmartWallet`, that verifies SPHINCS+ signatures in Solidity:

| Property | Value |
| --- | --- |
| Account standard | ERC-4337, **EntryPoint v0.6** (`0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`) |
| Factory | `PQSmartWalletFactory` at `0xe8ce78cd976497447ff8b76c71b59ae42af0d452`, deployed with CREATE2 |
| Address | The same on every chain (CREATE2 from the factory and the account's key) |
| Chains | Ethereum (1), Base (8453), Base Sepolia (84532): `PQ1_SUPPORTED_CHAIN_IDS` |
| Fees | Paid in ETH by the account itself. No paymaster. |

Consequences for your wallet:

- A transaction is a **UserOperation** sent to a bundler, not a raw transaction. The SDK builds it, has the device sign it, and submits it. See [Transactions](./transactions.md).
- A message signature is verified by calling the wallet's `isValidSignature` (ERC-1271), never by `ecrecover`. See [Message signing](./message-signing.md).
- Dapps must be told the account is a smart account. See [dApp provider](./dapp-provider.md).

The contracts are in the firmware repo under [`contracts/smart-wallet/src`](https://github.com/EthereumPhone/PQ1/blob/8a3fb4b3/contracts/smart-wallet/src/PQSmartWallet.sol).

## 256 numbered accounts

There is no BIP-32 and no derivation path. One PQ1 seed holds 256 accounts, numbered 0 to 255 (`index` in the SDK). The device derives each account's address itself, without the network: from the account's key to the CREATE2 address its factory deployment would have. `getAccounts()` asks the device for the addresses of a range of indices (0-4 by default).

## Deployment happens with the first transaction

A fresh account has an address but no code on any chain. Its first transaction on a chain deploys it there, in the same UserOperation (the `initCode` field):

1. The SDK asks the device for the account's init code (`GET_INIT_CODE`). It contains the account's **bootstrap key** and a signature with that key that authorises the factory to create the wallet.
2. The SDK checks that the init code calls the expected factory and that the factory predicts the account's address, so a firmware/contract mismatch fails early with a clear error instead of an opaque bundler rejection.
3. The device signs the UserOperation, the bundler submits it, and the wallet now exists on that chain.

`PreparedTransaction.isFirstDeploy` tells you when this applies; the fee is higher that once.

### Why the init code is cached

The bootstrap key is a SPHINCS+ key, and SPHINCS+ signatures use "few-time" components that weaken slightly with every signature made by the same key. The bootstrap key can never be rotated, because the account's address depends on it. And the device signs `GET_INIT_CODE` requests without asking the user.

So the firmware leaves it to the host to ask as rarely as possible: cache the init code per account and chain until the wallet is deployed (see [`cmd_get_init_code.rs`](https://github.com/EthereumPhone/PQ1/blob/8a3fb4b3/secure/src/nsc/cmd_get_init_code.rs) and [the analysis](https://github.com/EthereumPhone/PQ1/blob/8a3fb4b3/docs/VULN-getinitcode-bootstrap-fewtime-oracle.md)). The SDK does this in `Pq1Device.getInitCode`, in memory and in the `cache` store you give it. In an extension that is `chrome.storage.local`, so the cache survives service-worker restarts. The risk is low in practice, but don't work around the cache.

## Owner slots

After deployment, transactions are not signed with the bootstrap key but with an **owner slot** key. The wallet stores its owners by `ownerIndex`:

| ownerIndex | Key | May do |
| --- | --- | --- |
| 0 | bootstrap key | only add owners (deployment) |
| 1, 2, … | slot keys: slot = ownerIndex − 1 | run calls (`executeWithOffchainCount`, `executeBatchWithOffchainCount`) |

A new wallet starts with slot 0 (ownerIndex 1). Each slot key can make up to 65,536 signatures before the user must rotate to the next slot. The SDK reads the active slot from the chain (`nextOwnerIndex() − 1`) before every signature, because a value saved earlier goes stale after a rotation, and a wrong ownerIndex makes every signature fail verification. This SDK version does not rotate slots itself (see [Compatibility](./compatibility.md)).

## The off-chain signature counter

Message signatures are verified on-chain, but signing them doesn't touch the chain. To bound how much each slot key is used, the wallet counts them: every transaction carries the device's current count of off-chain signatures (`newOffchainCount` in its call data), and the wallet rejects a count lower than the one it already has.

The device keeps its own count per slot. If it falls behind the wallet's (after a firmware reflash, or with the same seed on a second device), a transaction would revert after paying its fee. So before signing a transaction, the SDK reads the wallet's `offchainSigCount` and sends `OFFCHAIN_SYNC` to raise the device's count to it. When the count actually goes up, the device asks the user **"Update signature count?"**, showing both counts and the signatures left, with an extra "CAREFUL" page for large jumps (firmware: [`usb-protocol-v2.md` §0x64](https://github.com/EthereumPhone/PQ1/blob/8a3fb4b3/docs/companion/usb-protocol-v2.md)). This is expected; tell your users about it. The SDK only ever sends the value read from the chain.

## Signature formats

What `signMessage` and `signTypedData` return depends on whether the account is deployed on the chain the signature is for:

| Account on that chain | Returned signature | Size |
| --- | --- | --- |
| Deployed | ERC-1271: `abi.encode(uint256 ownerIndex, bytes sphincsSig)` | 4,128 bytes |
| Not deployed yet | ERC-6492: deploy data + the ERC-1271 signature + the `0x6492…6492` suffix, built by the device | 8,608 bytes |

That's why every signing call takes a `chainId`: the same message signed for Base and for Ethereum can give different signatures. Transaction signatures (inside UserOperations) use the same 4,128-byte wrapper.

## The device id

`deviceId` is a short id for one PQ1: the first 6 bytes of its account 0 address, in lowercase hex (`Pq1Device.getDeviceId()`). The device reports no serial number of its own, and account 0's address is derived from the device's seed, so it tells two PQ1s apart. Store it with each account. `createPq1Wallet` refuses to sign for an account with a different PQ1 plugged in (`wrong-device`), because the other device would sign with its own keys and produce a signature that fails verification.

## Glossary

| Term | Meaning |
| --- | --- |
| SPHINCS+ (C10) | The hash-based, post-quantum signature scheme the PQ1 signs with |
| APDU | One command or reply in the device protocol |
| UserOperation (UserOp) | An ERC-4337 transaction request, sent to a bundler instead of the mempool |
| Bundler | The service that puts UserOps on-chain (for example Pimlico) |
| EntryPoint v0.6 | The ERC-4337 contract PQ1 wallets use |
| PQSmartWallet | The PQ1 account contract |
| Init code | The factory call in a UserOp that deploys the wallet |
| Bootstrap key | ownerIndex 0; signs the deployment authorisation; few-time and never rotated |
| Slot / ownerIndex | The active signing key; ownerIndex = slot + 1 |
| Off-chain count | How many message signatures a slot has made; synced before transactions |
| ERC-1271 | How contracts verify signatures (`isValidSignature`) |
| ERC-6492 | A signature wrapper that lets a verifier check a not-yet-deployed wallet |
| Catalog | A Merkle-proved list (tokens, names, function names, ERC-7730 descriptors) the device uses to show requests |
| Device id | First 6 bytes of account 0's address; identifies one PQ1 |

Next: [Extension architecture](./extension-architecture.md) · [Accounts](./accounts.md) · [Transactions](./transactions.md) · [Message signing](./message-signing.md) · [Security](./security.md)
