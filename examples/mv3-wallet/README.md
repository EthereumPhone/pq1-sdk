# PQ1 example wallet (Manifest V3)

A small but complete browser-extension wallet for the PQ1, built on `pq1-sdk`. Use it to try the SDK with a real device, and as a reference for your own integration. It is not a production wallet.

What it does:

- **Connect page** (`src/connect.ts`): grants the extension access to the PQ1, lists its accounts, checks an address on the device, and picks the account to use.
- **Service worker** (`src/background.ts`): owns the one connection to the PQ1 (`Pq1DeviceManager`) and answers dApps' EIP-1193 requests with `createPq1Wallet` and the `pq1-sdk/provider` helpers.
- **Approval window** (`src/approve.ts`): shows each dApp request and the fee before the device is asked.
- **Provider** (`src/inpage.ts`, `src/contentscript.ts`): an EIP-1193 provider announced through EIP-6963.

## Run it

```sh
# from the repository root
npm install
PIMLICO_API_KEY=your-key npm run build
```

Then in Chrome (117 or later): open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select `examples/mv3-wallet/build`.

1. Click the extension's toolbar icon. The connect page opens.
2. Plug in and unlock your PQ1, press **Connect PQ1**, and pick it in the browser's list.
3. Choose an account. **Check on PQ1** shows its address on the device so you can compare.
4. Open a dApp on Base Sepolia (the default network), connect "PQ1 Example Wallet", and sign or send. Get test ETH for the account from a Base Sepolia faucet first: the account pays its own fees.

Without `PIMLICO_API_KEY` the example still signs messages, but can't send transactions.

## Files

| File | Role |
| --- | --- |
| `static/manifest.json` | MV3 manifest: service worker, content script, `minimum_chrome_version` 117 |
| `src/background.ts` | Device manager, wallet, EIP-1193 router, approval windows |
| `src/connect.ts` | Permission and account selection |
| `src/approve.ts` | Request review |
| `src/inpage.ts` | The provider dApps use, EIP-6963 announcement |
| `src/contentscript.ts` | Injects the provider, relays requests to the service worker |
| `src/shared.ts` | Networks, settings and message types |
| `build.mjs` | Bundles with esbuild and copies the catalogs from `pq1-sdk-catalogs` |

## Smoke test

Loads the built extension into Chromium without a PQ1 and checks the provider:

```sh
npx playwright install chromium   # once
npm run test:smoke -w mv3-wallet-example
```

Branded Google Chrome can no longer load unpacked extensions from the command line, so the test uses Playwright's Chromium (or set `CHROMIUM_PATH`).

## Before you build on it

- Replace the EIP-6963 `rdns` in `src/inpage.ts` with a reverse-DNS name of a domain you control.
- Use your own RPC endpoints instead of the public ones in `src/shared.ts`.
- Keep the bundler API key out of public builds, or proxy bundler requests through your backend.
- Give the approval window real transaction decoding; it only lists targets, values and data sizes.
