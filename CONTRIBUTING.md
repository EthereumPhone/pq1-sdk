# Contributing

Thanks for helping. This SDK talks to a hardware wallet that holds people's funds, so changes get careful review.

## Setup

```sh
nvm use        # Node 24 (see .nvmrc)
npm install
npm run build
npm test
```

## Before you open a pull request

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run check:package   # publint + are-the-types-wrong
```

If you changed the example: `npm run test:smoke -w mv3-wallet-example` (needs `npx playwright install chromium` once).

If your change affects what is sent to the device, also try it on a real PQ1; [docs/testing.md](docs/testing.md) has a checklist.

## Rules

- **The wire format is byte-exact.** Payload builders are tested against reference vectors from the firmware. Never change an expected byte in a test to make it pass; find out why it differs.
- **Never weaken what the device shows.** Don't add a fallback that sends a request on a weaker clear-signing route (for example, signing typed data as a blind hash after the device refused its structured form).
- **User-facing text is plain language.** Error messages go in `userMessage` (or `PQ1_ERROR_MESSAGES`) and must make sense to someone who knows nothing about blockchains. Technical detail goes in `message`.
- **No new runtime dependencies** without discussion. `viem` is the only peer dependency.
- **Document every export** with a doc comment, and update the guide in `docs/` that covers it.
- **Catalogs change only with firmware.** Use `npm run sync -w pq1-sdk-catalogs -- <firmware repo>`; never edit the `.bin` files.

## Layout

```
packages/pq1-sdk/src/
  wallet.ts, device.ts, messages.ts   high-level API
  transport/   WebHID transport, device commands, wire formats
  aa/          ERC-4337 send pipeline, bundler, fee fitting, clear-signing bundles per call
  db/, erc20/, names/, selectors/, erc7730/   catalog readers
  safe/, cowswap/, offchain/          Safe and CoW support
  provider/, extension/, testing/     subpath entry points
  config.ts    protocol constants and size caps (mirrors the firmware)
packages/pq1-sdk-catalogs/   catalog files, manifest, sync script
examples/mv3-wallet/         example extension
docs/                        guides
```
