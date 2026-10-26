# Testing

You can test a whole PQ1 integration without hardware. `pq1-sdk/testing` provides a fake PQ1 that speaks the real USB framing (so your code runs through the real transport), a fake chain and a fake bundler. They let you test account discovery, first deployment, batches, rejections, idle locks and error handling in plain unit tests. They do no cryptography, so finish with the hardware checklist at the end of this page before you ship.

## The fakes

```ts
import {
  createFakeBundler,
  createFakeChain,
  FAKE_USEROP_SIGNATURE,
  FAKE_VERIFIER,
  FakePq1Device,
  installFakeHid
} from 'pq1-sdk/testing'
```

### `FakePq1Device`

A `HIDDevice`-shaped object. Pass it to `Pq1Device.connect({ hidDevice: fake.asHidDevice() })`, or install it as `navigator.hid` with `installFakeHid`.

| Option | Default | Meaning |
| --- | --- | --- |
| `seed` | `'pq1-fake'` | Two fakes with different seeds act like two different PQ1s (different addresses and device ids). |
| `locked` | `false` | Start locked. |
| `protocolVersion` | `0x0203` | What GET_DEVICE_INFO reports. Use `0x0201` to test `outdated` on `showAddress`. |
| `capabilities` | sign + Safe + CoW off-chain bits | Capability word. Drop `CAP_OFFCHAIN_SAFE_TX` to test the blind-hash fallback. |

Steer it between steps:

| Member | Effect |
| --- | --- |
| `locked` / `lock()` | Lock the device (as the 2-minute idle timer would). |
| `pinAccepted` | Whether the next UNLOCK succeeds (`false` → `rejected`). |
| `rejectNext` | The next sign or show-address command is rejected on the "device" (SW 0x6982), then resets. |
| `offchainCount` | The device's off-chain signature count (raised by OFFCHAIN_SYNC, bumped by each signature). |
| `lockBeforeNext(ins)` | Lock right before the next command with that INS arrives (for example `0x30`, SIGN_USEROP), to test recovery from an idle lock mid-operation. |

And inspect it:

| Member | What it gives |
| --- | --- |
| `commands` | Every command received, after reassembly: `{ ins, payload }`. Assert on payload bytes. |
| `initCodeRequests` | How many GET_INIT_CODE commands it answered (check your init-code caching). |
| `addressOf(index)` | The address of account `index`. |
| `initCodeOf(index, chainId)` | The 4280-byte init code it returns. |
| `predictAddress(seed, root)` | What the fake factory's `getAddress` returns for its keys. |
| `masterKeyOf(index)` | The bootstrap key fields in its init code. |
| `asHidDevice()` | The fake typed as `HIDDevice`. |

`FAKE_USEROP_SIGNATURE` is the hex of the filler signature wrapper it returns for UserOps.

### `installFakeHid(device, { granted? })`

Makes `navigator.hid` return `device` (or no device, with `null`), for code that discovers the PQ1 itself: `Pq1Device.connect()`, `Pq1DeviceManager`, `requestPq1Permission`. With `granted: false` the device isn't permitted until `requestDevice` is called. Returns `{ unplug(), uninstall() }`; `unplug()` fires the `disconnect` event. It needs a global `navigator`: Node 21 or later, or a DOM test environment.

### `createFakeChain(options)`

An EIP-1193 `request` that answers the reads the SDK makes (`eth_getCode`, `eth_call` for nonce / owner index / off-chain count / verifier / factory `getAddress`, `eth_maxPriorityFeePerGas`, `eth_getBlockByNumber`, `eth_chainId`). Any other method throws, so you notice unexpected reads.

| Option | Default | Meaning |
| --- | --- | --- |
| `chainId` | `84532` | |
| `device` | — | Answers the factory's `getAddress` for this fake's keys (needed for first-deploy tests). |
| `deployed` | `[]` | Addresses that have code. |
| `nonce` | `0n` | Every wallet's EntryPoint nonce. |
| `offchainSigCount` | `0n` | Every wallet's on-chain off-chain signature count (non-zero triggers OFFCHAIN_SYNC). |
| `factoryDeployed` | `true` | `false` simulates a chain without the PQ1 factory. |

It returns `{ request, deploy(address), calls }`. Fees it reports: base fee 1 gwei, tip 0.001 gwei. The verifier address is `FAKE_VERIFIER`.

### `createFakeBundler(options)`

A `Pq1Bundler` that records what it receives.

| Option | Meaning |
| --- | --- |
| `estimate` | The gas estimate returned (default 200k call gas, 50k pre-verification gas). |
| `gasPrice` | Fees for `getGasPrice`; omit to make the SDK ask the chain. |
| `estimateError`, `sendError` | Fail with a `BundlerError` carrying this message (for example `"AA21 didn't pay prefund"`). |
| `autoInclude` | Default `true`: a receipt is available right after a send. |

It exposes `estimates`, `sent` (`{ chainId, op, userOpHash }`) and `include(userOpHash, success?)`.

## An end-to-end test

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createPq1Wallet, memoryCatalogs, memoryStore, Pq1Device } from 'pq1-sdk'
import { createFakeBundler, createFakeChain, FakePq1Device } from 'pq1-sdk/testing'
import { catalogFilePath } from 'pq1-sdk-catalogs'

const CHAIN_ID = 84532
const catalogs = memoryCatalogs({
  erc20: readFileSync(catalogFilePath('erc20')),
  names: readFileSync(catalogFilePath('names')),
  selectors: readFileSync(catalogFilePath('selectors')),
  erc7730: readFileSync(catalogFilePath('erc7730'))
})

function setup() {
  const fake = new FakePq1Device()
  const chain = createFakeChain({ chainId: CHAIN_ID, device: fake })
  const bundler = createFakeBundler()
  const cache = memoryStore()
  const wallet = createPq1Wallet({
    device: () => Pq1Device.connect({ hidDevice: fake.asHidDevice(), cache }),
    rpc: { [CHAIN_ID]: chain.request },
    bundler,
    catalogs,
    logger: { warn: () => {}, error: () => {} }
  })
  return { fake, chain, bundler, wallet }
}

describe('my PQ1 integration', () => {
  it('deploys a fresh account with its first transaction', async () => {
    const { wallet, fake, bundler } = setup()
    const [account] = await wallet.getAccounts({ count: 1 })
    const prepared = await wallet.prepareTransaction({
      account: account!,
      chainId: CHAIN_ID,
      calls: [{ to: '0x1234567890abcdef1234567890abcdef12345678', value: 10n ** 15n }]
    })
    expect(prepared.isFirstDeploy).toBe(true)

    const { userOpHash } = await wallet.sendPrepared(prepared, account!)
    expect(fake.initCodeRequests).toBe(1)
    expect(bundler.sent[0]!.op.initCode).not.toBe('0x')

    const receipt = await wallet.waitForReceipt({ chainId: CHAIN_ID, userOpHash })
    expect(receipt.success).toBe(true)
  })

  it('sends nothing when the user rejects on the device', async () => {
    const { wallet, fake, bundler } = setup()
    const [account] = await wallet.getAccounts({ count: 1 })
    fake.rejectNext = true
    await expect(
      wallet.sendTransaction({
        account: account!,
        chainId: CHAIN_ID,
        calls: [{ to: '0x1234567890abcdef1234567890abcdef12345678', value: 1n }]
      })
    ).rejects.toMatchObject({ code: 'rejected' })
    expect(bundler.sent).toHaveLength(0)
  })
})
```

The SDK's own suite has many more cases to copy from: [`packages/pq1-sdk/test/wallet.e2e.test.ts`](../packages/pq1-sdk/test/wallet.e2e.test.ts) (wrong device, idle-lock replay, AA21 wording, ERC-1271 vs ERC-6492, `showAddress` on old firmware) and [`src/extension/index.test.ts`](../packages/pq1-sdk/src/extension/index.test.ts) (`Pq1DeviceManager` reconnects, a fake `chrome.*`).

## What the fakes don't do

- **No cryptography.** Addresses are hashes of the seed; signatures are filler bytes of the right length. Nothing they sign verifies on-chain or through ERC-1271.
- **No screen.** The fake approves everything unless told to reject, so it can't tell you whether the device would show a request in full. Payload rules (sizes, trailer slots, refusals the SDK makes before the device) are still enforced, because the real payload builders run.
- **Simplified chain.** Every wallet has owner slot 0 and the same nonce; there is no gas, no EntryPoint simulation, no reverts.

## On a real PQ1

Run through this on a real device before a release (Base Sepolia is the cheapest network):

1. **Connect**: grant permission from your connect page; the service worker connects without the page.
2. **Unlock**: start locked; the PIN prompt appears on the device when needed.
3. **Accounts**: list accounts 0-4; `showAddress` shows the same address on the device.
4. **personal_sign**: a short text message (shown as text), a long one (hash with warning), a hex one.
5. **Typed data**: a Uniswap Permit2 permit (spender, tokens and amounts shown), an ERC-7730-covered message (fields shown), an unknown one (blind hash warning).
6. **First deploy**: a fresh account index sends its first transaction; the device shows the factory page; the account is deployed afterwards.
7. **Batch**: 2-4 calls in one `wallet_sendCalls`; the device shows each call and a final confirmation.
8. **Token transfer**: an ERC-20 transfer shows the token and amount, not raw data.
9. **Reject on the device**: nothing is sent; your UI shows "rejected".
10. **Unplug mid-request**: the request fails with `disconnected`; replugging works without reloading.
11. **Idle lock**: wait over 2 minutes, then sign; the device asks for the PIN and the request completes.
12. **Service-worker restart**: stop the worker in `chrome://serviceworker-internals`; the next request reconnects, and a pending first deploy doesn't ask for the init code again.

## The example's smoke test

`examples/mv3-wallet` has a Playwright test that loads the built extension into Chromium (no PQ1 needed) and checks the EIP-6963 announcement, `eth_chainId`, `wallet_getCapabilities` and the connect page:

```sh
npx playwright install chromium   # once
npm run build && npm run test:smoke -w mv3-wallet-example
```

It needs Playwright's Chromium (or set `CHROMIUM_PATH` to another Chromium build). Branded Google Chrome no longer loads unpacked extensions from the command line, so it can't run this test.

Next: [troubleshooting.md](troubleshooting.md) · [security.md](security.md) · [getting-started.md](getting-started.md)
