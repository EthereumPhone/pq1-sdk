# Wire protocol reference

This page describes how the PQ1 talks over USB, for anyone writing their own transport (a Node `node-hid` bridge, a native app) or debugging at the byte level. Most integrations never need it: `HidTransport` and `DeviceCommands` in `pq1-sdk/transport` implement all of it, and `HidTransport.connect({ device })` accepts any `HIDDevice`-shaped object, so a custom transport often only has to provide `open`, `close`, `sendReport` and `inputreport` events. The normative source is the firmware's [`docs/companion/usb-protocol-v2.md`](https://github.com/EthereumPhone/PQ1/blob/8a3fb4b3/docs/companion/usb-protocol-v2.md) and [`proto/src/lib.rs`](https://github.com/EthereumPhone/PQ1/blob/8a3fb4b3/proto/src/lib.rs) at commit `8a3fb4b3` (protocol 0x0203); the last section lists where those documents and the code disagree.

## USB

| Property | Value |
| --- | --- |
| VID / PID | `0x1209` / `0x7051` (pid.codes) |
| Strings | manufacturer "PQSigner", product "PQSigner OS" |
| HID usage page / usage | `0xFFA0` / `0x01` (vendor-defined) |
| Reports | 64 bytes in and out, interrupt endpoints, 1 ms interval, **no report IDs** |
| Writing | `device.sendReport(0, frame)` |

## HID framing

Ledger-style APDU-over-HID. An APDU (request or reply) is split across 64-byte reports:

```
First report:         [channel u16 BE = 0x0101][tag 0x05][seq u16 BE = 0][total_len u16 BE][57 data bytes]
Continuation reports: [channel u16 BE = 0x0101][tag 0x05][seq u16 BE = 1, 2, …][59 data bytes]
```

The last report is zero-padded. On receive, skip reports whose tag isn't `0x05`; a sequence gap is an error. The device reassembles at most 4096 bytes per APDU and drops a partial APDU after 5 s without its next report. Reports carry no request id, so only one exchange may be in flight per connection: queue requests (the SDK's `HidTransport` does).

## APDUs

```
Request:  CLA INS P1 P2 [Lc Data]      CLA = 0xF0, P2 = 0, short Lc (1 byte, max 255)
Reply:    [Data] SW1 SW2
```

- **Command chaining.** Payloads over 255 bytes go as several APDUs with the same INS: `P1 = 0x80` (more follows) on every block but the last, `P1 = 0x00` on the last. Each intermediate block is answered with `9000`. The whole chain must finish within 30 s of its first block.
- **Response chaining.** A reply longer than 253 data bytes comes back as the first 253 bytes with `SW = 61xx` (SW2 = bytes remaining, capped at 0xFF). Send `INS 0xC0` (GET_RESPONSE, empty) until `SW = 9000`. Any other command in between scrubs the pending reply. A drain must not pause for 30 s, and must finish within 120 s.
- **One session.** While a chain or drain is live, APDUs on another HID channel get `6985`.

## Instructions

| INS | Name | Chained | SDK uses it | Purpose |
| --- | --- | --- | --- | --- |
| `0x01` | GET_DEVICE_INFO | no | yes | Version and capability header |
| `0x02` | GET_STATUS | no | yes | `[locked u8][pin_remaining u8]`; works while locked |
| `0x03` | GET_PIN_ATTEMPT_LOG | no | no | 36-byte RAM log of PIN-attempt reasons (dispatched, not in the protocol doc) |
| `0x10` | UNLOCK | no | yes | PIN entry on the device; blocks until done; SW only |
| `0x11` | LOCK | no | no | Lock and zeroize secrets |
| `0x30` | SIGN_USEROP | yes | yes | Sign a one-call UserOp |
| `0x32` | SIGN_USEROP_BATCH | yes | yes | Sign a UserOp of 1-4 calls (protocol ≥ 0x0200) |
| `0x60` | GET_WALLET_ADDRESS | no | yes | `[account u32 BE]` (+ `[show u8]` from 0x0202) → 20-byte address |
| `0x61` | GET_INIT_CODE | no (reply chained) | yes | `[account u32 BE][chain u64 BE]` → 4280-byte init code. **Spends a bootstrap-key signature; cache it** |
| `0x62` | SIGN_OFFCHAIN | yes | yes | EIP-1271 / ERC-6492 message signatures, kinds 0-5 |
| `0x63` | OFFCHAIN_STATUS | no | no | Per-slot `(local count, last UserOp count, registered)` readback |
| `0x64` | OFFCHAIN_SYNC | no | yes | Raise a slot's off-chain count floor; may ask the user |
| `0x70`-`0x74` | FW_BEGIN / CHUNK / COMMIT / STATUS / ABORT | BEGIN | no | Firmware update; pre-production, blocked in production |
| `0x80`-`0x8C` | PRODTEST_* | — | no | Factory test builds only |
| `0xC0` | GET_RESPONSE | — | yes | Drain a chained reply |

Retired values return `6D00`: `0x20`, `0x21`, `0x31`, `0x40`, `0x41`, `0x50`.

## Replies and layouts

### GET_DEVICE_INFO (40 bytes)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 2 | `protocol_version` u16 BE (0x0203) |
| 2 | 3 | `fw_version` — placeholder, don't gate on it |
| 5 | 16 | `device_uid` — zero placeholder (the SDK's `deviceId` comes from account 0's address instead) |
| 21 | 4 | capability bits u32 BE |
| 25 | 1 | `sig_param_set` = 2 (SPHINCS+C10) |
| 26 | 2 | `sig_size` = 4128 |
| 28 | 8 | zero |
| 36 | 2 | `ep_version` = 0x0006 (EntryPoint v0.6) |
| 38 | 2 | `wrapper_overhead` = 96 |

Capability bits: bit 0 `CAP_SIGN_USEROP`; bit 1 retired; bit 2 `CAP_ERC7730_PROOF_SET` (two-descriptor envelope, not built by the SDK); bit 3 `CAP_OFFCHAIN_SAFE_TX`; bit 4 `CAP_OFFCHAIN_COW_ORDER`; bit 5 `CAP_SIGN_USEROP_DATA_8K` (calls of up to 8192 bytes of data, see below). Current firmware reports `0x3D`.

### GET_STATUS

`[locked u8][pin_remaining u8]` from protocol 0x0201. Older firmware prefixed a meaningless byte (3 bytes); the SDK reads both. There is no "provisioned" flag: a device in its first-boot wizard reports `locked: false` and refuses gated commands with `6985`.

### SIGN_USEROP (0x30)

Header (276 bytes):

```
chain_id u64 BE ‖ flags u32 BE ‖ sender (20) ‖ entry_point (20)
‖ nonce, call_gas_limit, verification_gas_limit, pre_verification_gas,
  max_fee_per_gas, max_priority_fee_per_gas (6 × u256 BE)
‖ sha256(paymasterAndData) (32; SHA256_EMPTY when there is no paymaster)
```

Flags: bit 31 `FLAG_INCLUDE_INIT_CODE` (first deployment; slot must be 0), bit 30 `FLAG_REGISTER_SLOT` (slot rotation, protocol ≥ 0x0203; not used by the SDK), bits 29..22 account index, bits 21..0 slot index. `sender` must equal the device's derived address for the account.

Then the call: `to (20) ‖ value u256 BE ‖ data_len u16 BE ‖ data (≤ 8192 with capability bit 5, else ≤ 4096)`. Firmware without bit 5 refuses a longer call with a generic status (`0x6F00`), so gate on the bit, never on the error.

Then up to seven positional, u16-length-prefixed trailer slots, in this order: erc20, reserved (must be empty), CoW order, safe_v1, curated selector, self-attested selector, ERC-7730. Trailing empty slots may be left out. Name bundles follow as `[u8 count (1-4)]` and u16-length-prefixed bundles; if any are present, all seven slots must be written out first.

Reply (chained):

```
new_offchain_count u64 BE
init_code_len u32 BE ‖ init_code (4280 with FLAG_INCLUDE_INIT_CODE, else 0)
type1_len u32 BE ‖ type1 (4192 with FLAG_REGISTER_SLOT on 0x0203, else 0)
type2_len u32 BE ‖ type2 (always 4128: abi.encode(uint256 ownerIndex, bytes sig))
```

Put `new_offchain_count` into the callData (`executeWithOffchainCount(ownerIndex, newOffchainCount, to, value, data)`), the init code into the UserOp, and `type2` as its signature. The device signs a SHA-256 digest over the UserOp fields (not the keccak `userOpHash`).

### SIGN_USEROP_BATCH (0x32), wire version 2

```
header (276) ‖ [u8 wire_version = 2][u8 call_count 1..4]
‖ call_count × (to (20) ‖ value u256 BE ‖ data_len u16 BE ‖ data)
‖ [u8 trailer_count] ‖ trailer_count × { u8 kind, u8 tx_idx, u16 BE len, bytes }
```

| Kind | Bundle | Max bytes |
| --- | --- | ---: |
| 1 | ERC-20 metadata | 1120 |
| 2 | reserved | — |
| 3 | CoW order | 2448 |
| 4 | Safe v1 (SafeTx) | 4379 |
| 5 | curated selector | 1100 |
| 6 | self-attested selector (SDK doesn't send) | 68 |
| 7 | ERC-7730 (single bundle 5130; two-descriptor envelope 10268) | 10268 |
| 8 | name (`tx_idx = 0xFF`, applies to all calls; max 4) | 1093 |

At most 32 trailers and 24,576 trailer bytes. The reply has the SIGN_USEROP layout; callData is `executeBatchWithOffchainCount(ownerIndex, newOffchainCount, targets, values, datas)`.

### SIGN_OFFCHAIN (0x62)

Header (17 bytes): `account u8 ‖ chain_id u64 BE ‖ slot u32 BE ‖ kind u8 ‖ payload_len u16 BE ‖ flags u8` (bit 0: wallet deployed on this chain).

| Kind | Payload | Notes |
| --- | --- | --- |
| 0 RAW32 | 32-byte digest | Shown as `! BLIND RAW32`. Never send typed data this way when a stronger kind applies |
| 1 PERSONAL_SIGN | the message, ≤ 700 bytes | Device adds the EIP-191 prefix; text ≤ 72 rows × 16 columns, else hex ≤ 512 bytes |
| 2 EIP712_TYPED | `u16 1 ‖ domain_separator (32) ‖ primary_type_hash (32) ‖ u16 len ‖ encoded_data (≤ 512) ‖ u16 len ‖ ERC-7730 bundle` | Descriptor required |
| 3 EIP712_TYPED_V3 | nested typed data with display witnesses | Not sent by the SDK |
| 4 SAFE_TX | `u16 len ‖ safe_v1 ‖ u16 len ‖ erc20 ‖ u16 len ‖ cow ‖ u8 n ‖ n × (u16 len ‖ name)` (290..12,334) | Needs `CAP_OFFCHAIN_SAFE_TX` and a deployed wallet |
| 5 COW_ORDER | the CoW order bundle (208..2448) | Needs `CAP_OFFCHAIN_COW_ORDER` and a deployed wallet |

Reply: `new_count u64 BE ‖ sig (4008)` (4016 bytes) for a deployed wallet — wrap it as `abi.encode(uint256 ownerIndex, bytes sig)` — or `new_count u64 BE ‖ ERC-6492 signature (8608)` (8616 bytes) for an undeployed one (slot 0 only), passed through unchanged. Kinds 4 and 5 sign the same value a RAW32 sign of the recomputed hash would. Never fall back to RAW32 after a kind 4/5 refusal.

### OFFCHAIN_SYNC (0x64)

Body (21 bytes): `account u8 ‖ chain_id u64 BE ‖ slot u32 BE ‖ target u64 BE`; reply is SW only. "Set if greater". A higher target or a new slot shows *Update signature count?* on the device (with a `! CAREFUL` page for jumps over 1,000 or fewer than 1,000 left). A target that would leave 0 signatures is refused with `6985`. Send only the true on-chain `offchainSigCount`.

## Status words

| SW | Meaning |
| --- | --- |
| `9000` | OK |
| `61xx` | More reply data; send GET_RESPONSE |
| `6700` | Wrong length |
| `6982` | Wrong PIN, or the user rejected/cancelled |
| `6984` | Idle wipe during the command |
| `6985` | Locked, PIN locked, not set up, off-chain counter refusal, stale drain, or another session holds the device |
| `6A80` | Wrong data (show flag > 1, firmware-update errors) |
| `6D00` | INS not supported |
| `6E00` | CLA not supported |
| `6F00` | Internal error — also most secure-world parse and policy refusals |
| `6501` | Defined, unused |

How the SDK maps these to error codes is in [errors.md](errors.md#device-status-words).

## Timeouts

| Where | Value |
| --- | --- |
| Device: chain lifetime | 30 s from the first block |
| Device: GET_RESPONSE idle / absolute | 30 s / 120 s |
| Device: HID reassembly | 5 s |
| Device: auto-lock | 120 s idle (USB traffic doesn't extend it) |
| SDK (`timeoutForIns`): UNLOCK | 60 s |
| SDK: SIGN_USEROP, SIGN_USEROP_BATCH, SIGN_OFFCHAIN, OFFCHAIN_SYNC | 120 s (the user may be reading) |
| SDK: GET_WALLET_ADDRESS, GET_INIT_CODE | 30 s (120 s with the `show` flag) |
| SDK: everything else | 5 s |

## Size limits

| Limit | Value |
| --- | --- |
| Data per APDU / per reply chunk | 255 / 253 bytes |
| Reassembled APDU | 4096 bytes |
| Calls per UserOp | 4 |
| Calldata per call | 8192 bytes with `CAP_SIGN_USEROP_DATA_8K`, else 4096 |
| Calldata per batch, summed | 16,384 bytes |
| Safe inner data (`safe_v1`, off-chain SafeTx, `execTransaction` call) | 4096 bytes |
| Name bundles per request | 4 |
| Trailers per batch / total bytes | 32 / 24,576 |
| Sign reply | 12,620 bytes (0x0203) |
| personal_sign message | 700 bytes |
| EIP-712 encoded data (kind 2) | 512 bytes |
| Safe MultiSendCallOnly records | 6 |
| Off-chain signature gap | 100 |
| Signatures per owner slot / bootstrap uses (on-chain caps) | 65,536 each |
| Accounts per seed | 256 (index 0-255) |

## Protocol versions

| Version | Change |
| --- | --- |
| 0x0200 | Batch wire version 2 (SIGN_USEROP_BATCH). Ambiguous vintage: the GET_STATUS change below first shipped without a bump |
| 0x0201 | GET_STATUS shrank to 2 bytes |
| 0x0202 | GET_WALLET_ADDRESS `show` flag |
| 0x0203 | Slot rotation reply: Type 1 section is 4192 bytes (`new_owner_bytes ‖ wrapper`); sign reply up to 12,620 bytes |

## Corrections to the firmware docs

At `8a3fb4b3`, the code differs from some firmware documentation. Trust the code:

1. **Init code ABI offset.** The legacy integration guide's table says the `factorySig` offset word is `0x140`; it is `0xC0` (`proto/src/lib.rs`).
2. **`createAccount` chain id type.** Documented as `uint256`; the contract and selector (`0xf6182a73`) use `uint64`.
3. **No plain execute.** The legacy guide lists `execute`, `executeBatch(Call[])` and selector `0xb61d27f6` for slot signatures. Slot keys can only call `executeWithOffchainCount`, `executeBatchWithOffchainCount` and `removeOwnerAtIndex`.
4. **`6F00`, not `6A80`.** The protocol table says malformed data returns `6A80`; most secure-world refusals (bad trailers, a batch wire-version mismatch, an ERC-6492 request with slot ≠ 0) actually return `6F00`. Treat `6F00` on a sign command as "the device refused", not as a hardware fault.
5. **GET_INIT_CODE is not byte-identical.** Comments in `nonsecure/src/usb/commands.rs` and `proto/src/lib.rs` say repeated calls return identical bytes. The bootstrap signature inside is randomized per call, so they differ; every copy deploys the same wallet. Caching is required anyway (see [security.md](security.md#cache-the-init-code)).
6. **INS `0x03` GET_PIN_ATTEMPT_LOG** is dispatched but missing from the protocol document's instruction table, and that table also omits `0x64` OFFCHAIN_SYNC (which has its own section).

Next: [compatibility.md](compatibility.md) · [errors.md](errors.md) · [concepts.md](concepts.md)
