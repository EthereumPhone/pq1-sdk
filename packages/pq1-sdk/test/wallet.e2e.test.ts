// The high-level API end to end, against the fakes in `pq1-sdk/testing`:
// a FakePq1Device behind the real WebHID transport (framing, chaining,
// GET_RESPONSE), a fake chain and a fake bundler.

import { decodeFunctionData, encodeFunctionData, erc20Abi, isHex, parseAbi, size } from 'viem'

import {
  BundlerError,
  createPq1Wallet,
  memoryStore,
  Pq1Device,
  Pq1Error,
  type KeyValueStore,
  type Pq1Account
} from '../src'
import { INS_GET_INIT_CODE, INS_SIGN_OFFCHAIN, INS_SIGN_USEROP } from '../src/config'
import { bytesToHex0x } from '../src/transport/bytes'
import {
  createFakeBundler,
  createFakeChain,
  FAKE_USEROP_SIGNATURE,
  FakePq1Device
} from '../src/testing'
import { diskCatalogs } from './helpers'

const CHAIN_ID = 84532
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const RECIPIENT = '0x1234567890abcdef1234567890abcdef12345678'
const FEE = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n }
const WALLET_ABI = parseAbi([
  'function executeWithOffchainCount(uint256 ownerIndex, uint256 newOffchainCount, address target, uint256 value, bytes data) returns (bytes)',
  'function executeBatchWithOffchainCount(uint256 ownerIndex, uint256 newOffchainCount, address[] targets, uint256[] values, bytes[] datas)'
])

function setup(
  options: {
    fake?: FakePq1Device
    deployed?: boolean
    bundler?: Parameters<typeof createFakeBundler>[0]
    cache?: KeyValueStore
  } = {}
) {
  const fake = options.fake ?? new FakePq1Device()
  const chain = createFakeChain({
    chainId: CHAIN_ID,
    device: fake,
    deployed: options.deployed ? [fake.addressOf(0), fake.addressOf(1)] : []
  })
  const bundler = createFakeBundler(options.bundler)
  const cache = options.cache ?? memoryStore()
  const logger = { warn: vi.fn(), error: vi.fn() }
  const wallet = createPq1Wallet({
    device: () => Pq1Device.connect({ hidDevice: fake.asHidDevice(), cache }),
    rpc: { [CHAIN_ID]: chain.request },
    bundler,
    catalogs: diskCatalogs,
    logger
  })
  return { fake, chain, bundler, wallet, logger, cache }
}

const accountOf = async (wallet: ReturnType<typeof setup>['wallet'], index = 0) =>
  (await wallet.getAccounts({ start: index, count: 1 }))[0]!

describe('createPq1Wallet', () => {
  it("lists the device's accounts with its device id", async () => {
    const { wallet, fake } = setup()
    const accounts = await wallet.getAccounts({ count: 3 })
    expect(accounts.map((a) => a.index)).toEqual([0, 1, 2])
    expect(accounts.map((a) => a.address)).toEqual([0, 1, 2].map((i) => fake.addressOf(i)))
    expect(accounts[0]!.deviceId).toBe(fake.addressOf(0).slice(2, 14))
  })

  it('unlocks a locked device on demand, and reports a cancelled PIN as rejected', async () => {
    const locked = new FakePq1Device({ locked: true })
    const { wallet } = setup({ fake: locked })
    await expect(wallet.getAccounts({ count: 1 })).resolves.toHaveLength(1)
    expect(locked.locked).toBe(false)

    locked.lock()
    locked.pinAccepted = false
    await expect(wallet.getAccounts()).rejects.toMatchObject({ code: 'rejected' })
  })

  it('deploys a fresh account with its first transaction, asking for the init code once', async () => {
    const cache = memoryStore()
    const { wallet, fake, bundler } = setup({ cache })
    const account = await accountOf(wallet)
    const calls = [{ to: RECIPIENT as `0x${string}`, value: 10n ** 15n }]

    const prepared = await wallet.prepareTransaction({
      account,
      chainId: CHAIN_ID,
      calls,
      fee: FEE
    })
    expect(prepared.isFirstDeploy).toBe(true)
    expect(prepared.fee.maxCost).toBe(prepared.fee.gasLimit * prepared.fee.maxFeePerGas)
    // Rounded so the device can show it exactly.
    expect(prepared.fee.maxFeePerGas % 10_000n).toBe(0n)

    // A second prepare (a retry) reuses the cached init code: each
    // GET_INIT_CODE spends a signature of the never-rotated bootstrap key.
    await wallet.prepareTransaction({ account, chainId: CHAIN_ID, calls, fee: FEE })
    expect(fake.initCodeRequests).toBe(1)
    expect(fake.commands.filter((c) => c.ins === INS_GET_INIT_CODE)).toHaveLength(1)

    const { userOpHash } = await wallet.sendPrepared(prepared, account)
    const sent = bundler.sent[0]!
    expect(sent.userOpHash).toBe(userOpHash)
    expect(sent.op.initCode).toBe(bytesToHex0x(fake.initCodeOf(0, CHAIN_ID)))
    expect(sent.op.signature).toBe(FAKE_USEROP_SIGNATURE)

    const receipt = await wallet.waitForReceipt({ chainId: CHAIN_ID, userOpHash })
    expect(receipt.success).toBe(true)
    expect(isHex(receipt.transactionHash, { strict: true })).toBe(true)
    expect(size(receipt.transactionHash)).toBe(32)
  })

  it('sends a batch from a deployed account as one UserOp with clear-signing data', async () => {
    const { wallet, fake, bundler } = setup({ deployed: true })
    const account = await accountOf(wallet)
    const transfer = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [RECIPIENT, 25_000_000n]
    })
    await wallet.sendTransaction({
      account,
      chainId: CHAIN_ID,
      calls: [
        { to: USDC, data: transfer },
        { to: RECIPIENT, value: 1n }
      ],
      fee: FEE
    })
    expect(fake.initCodeRequests).toBe(0)
    const { functionName, args } = decodeFunctionData({
      abi: WALLET_ABI,
      data: bundler.sent[0]!.op.callData
    })
    expect(functionName).toBe('executeBatchWithOffchainCount')
    // The device's own off-chain count goes into the call data.
    expect(args[1]).toBe(fake.offchainCount)
    expect(bundler.sent[0]!.op.initCode).toBe('0x')
  })

  // Call-data caps (firmware of 2026-10-22: 8192 per call, bit 5).
  const routerCall = (bytes: number): `0x${string}` => `0x3593564c${'ab'.repeat(bytes - 4)}` // Universal Router execute(...)
  const ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af'
  const PRE_8K_CAPABILITIES = 0b1 | (1 << 3) | (1 << 4)

  it('signs a 5,050-byte call on firmware that takes 8 KB calls', async () => {
    const { wallet, bundler } = setup({ deployed: true })
    const account = await accountOf(wallet)
    await wallet.sendTransaction({
      account,
      chainId: CHAIN_ID,
      calls: [{ to: ROUTER, data: routerCall(5050) }],
      fee: FEE
    })
    const { args } = decodeFunctionData({ abi: WALLET_ABI, data: bundler.sent[0]!.op.callData })
    expect(args[4]).toBe(routerCall(5050))
  })

  it('asks for a PQ1 update instead of sending a 5,050-byte call to older firmware', async () => {
    const fake = new FakePq1Device({ capabilities: PRE_8K_CAPABILITIES })
    const { wallet, bundler } = setup({ fake, deployed: true })
    const account = await accountOf(wallet)
    await expect(
      wallet.sendTransaction({
        account,
        chainId: CHAIN_ID,
        calls: [{ to: ROUTER, data: routerCall(5050) }],
        fee: FEE
      })
    ).rejects.toMatchObject({ code: 'outdated' })
    expect(fake.commands.some((c) => c.ins === INS_SIGN_USEROP)).toBe(false)
    expect(bundler.sent).toHaveLength(0)
    // 4096 bytes still signs there.
    await wallet.sendTransaction({
      account,
      chainId: CHAIN_ID,
      calls: [{ to: ROUTER, data: routerCall(4096) }],
      fee: FEE
    })
    expect(bundler.sent).toHaveLength(1)
  })

  it('refuses more than 8,192 bytes in one call before touching the PQ1', async () => {
    const { wallet, fake, bundler } = setup({ deployed: true })
    const account = await accountOf(wallet)
    const result = wallet.sendTransaction({
      account,
      chainId: CHAIN_ID,
      calls: [{ to: ROUTER, data: routerCall(8193) }],
      fee: FEE
    })
    await expect(result).rejects.toMatchObject({ code: 'too-large' })
    await expect(result).rejects.toHaveProperty('userMessage', expect.stringContaining('8,192'))
    expect(fake.commands.some((c) => c.ins === INS_SIGN_USEROP)).toBe(false)
    expect(bundler.sent).toHaveLength(0)
  })

  it('signs a batch up to 16,384 bytes of call data and refuses one byte more', async () => {
    const { wallet, bundler } = setup({ deployed: true })
    const account = await accountOf(wallet)
    await wallet.sendTransaction({
      account,
      chainId: CHAIN_ID,
      calls: [
        { to: ROUTER, data: routerCall(8192) },
        { to: ROUTER, data: routerCall(8192) }
      ],
      fee: FEE
    })
    expect(bundler.sent).toHaveLength(1)
    await expect(
      wallet.sendTransaction({
        account,
        chainId: CHAIN_ID,
        calls: [
          { to: ROUTER, data: routerCall(8192) },
          { to: ROUTER, data: routerCall(8192) },
          { to: RECIPIENT, data: '0x01' }
        ],
        fee: FEE
      })
    ).rejects.toMatchObject({ code: 'too-large' })
    expect(bundler.sent).toHaveLength(1)
  })

  it('refuses a Safe execTransaction over 4096 bytes, which the PQ1 would refuse', async () => {
    const { wallet, bundler } = setup({ deployed: true })
    const account = await accountOf(wallet)
    await expect(
      wallet.sendTransaction({
        account,
        chainId: CHAIN_ID,
        calls: [{ to: RECIPIENT, data: `0x6a761202${'00'.repeat(4096)}` }],
        fee: FEE
      })
    ).rejects.toMatchObject({ code: 'too-large' })
    expect(bundler.sent).toHaveLength(0)
  })

  it('refuses to use a different PQ1 for an account, before anything is signed', async () => {
    const { wallet: walletA } = setup()
    const account = await accountOf(walletA)
    const other = new FakePq1Device({ seed: 'another-pq1' })
    const { wallet: walletB, bundler } = setup({ fake: other })
    await expect(
      walletB.signMessage({ account, chainId: CHAIN_ID, message: 'hi' })
    ).rejects.toMatchObject({ code: 'wrong-device' })
    await expect(
      walletB.sendTransaction({ account, chainId: CHAIN_ID, calls: [{ to: RECIPIENT }], fee: FEE })
    ).rejects.toMatchObject({ code: 'wrong-device' })
    expect(
      other.commands.some((c) => c.ins === INS_SIGN_OFFCHAIN || c.ins === INS_SIGN_USEROP)
    ).toBe(false)
    expect(bundler.sent).toHaveLength(0)
  })

  it('refuses an account whose saved address is not the device account', async () => {
    const { wallet, fake } = setup()
    const account: Pq1Account = { ...(await accountOf(wallet)), address: fake.addressOf(1) }
    await expect(
      wallet.signMessage({ account, chainId: CHAIN_ID, message: 'hi' })
    ).rejects.toMatchObject({ code: 'wrong-device' })
  })

  it('sends nothing when the user rejects on the device', async () => {
    const { wallet, fake, bundler } = setup({ deployed: true })
    const account = await accountOf(wallet)
    fake.rejectNext = true
    const result = wallet.sendTransaction({
      account,
      chainId: CHAIN_ID,
      calls: [{ to: RECIPIENT, value: 1n }],
      fee: FEE
    })
    await expect(result).rejects.toBeInstanceOf(Pq1Error)
    await expect(result).rejects.toMatchObject({ code: 'rejected' })
    expect(bundler.sent).toHaveLength(0)
  })

  it('unlocks and replays once when the device idle-locks mid-operation', async () => {
    const { wallet, fake, bundler } = setup({ deployed: true })
    const account = await accountOf(wallet)
    fake.lockBeforeNext(INS_SIGN_USEROP)
    await wallet.sendTransaction({
      account,
      chainId: CHAIN_ID,
      calls: [{ to: RECIPIENT, value: 1n }],
      fee: FEE
    })
    expect(fake.commands.filter((c) => c.ins === INS_SIGN_USEROP)).toHaveLength(2)
    expect(bundler.sent).toHaveLength(1)
  })

  it('words a bundler rejection for the user and keeps its own message for logs', async () => {
    const { wallet } = setup({ deployed: true, bundler: { sendError: "AA21 didn't pay prefund" } })
    const account = await accountOf(wallet)
    const result = wallet.sendTransaction({
      account,
      chainId: CHAIN_ID,
      calls: [{ to: RECIPIENT, value: 1n }],
      fee: FEE
    })
    await expect(result).rejects.toBeInstanceOf(BundlerError)
    await expect(result).rejects.toMatchObject({
      code: 'bundler-rejected',
      message: "AA21 didn't pay prefund",
      userMessage: expect.stringContaining("doesn't have enough ETH")
    })
  })

  it("prepares a deployed account's transaction without touching the PQ1", async () => {
    const { wallet, fake } = setup({ deployed: true })
    const account = await accountOf(wallet)
    const before = fake.commands.length
    await wallet.prepareTransaction({
      account,
      chainId: CHAIN_ID,
      calls: [{ to: RECIPIENT }],
      fee: FEE
    })
    expect(fake.commands.length).toBe(before)
  })

  it('picks fees itself when none are given', async () => {
    const { wallet, bundler } = setup({ deployed: true })
    const account = await accountOf(wallet)
    const prepared = await wallet.prepareTransaction({
      account,
      chainId: CHAIN_ID,
      calls: [{ to: RECIPIENT, value: 1n }]
    })
    // The fake chain: 1 gwei base fee, 0.001 gwei tip → 2 × base + tip.
    expect(prepared.fee.maxPriorityFeePerGas).toBe(1_000_000n)
    expect(prepared.fee.maxFeePerGas).toBe(2_001_000_000n)
    expect(bundler.estimates).toHaveLength(1)
  })

  it('signs a message as ERC-1271 when deployed and ERC-6492 when not', async () => {
    const deployed = setup({ deployed: true })
    const a = await accountOf(deployed.wallet)
    const sig1271 = await deployed.wallet.signMessage({
      account: a,
      chainId: CHAIN_ID,
      message: 'hello'
    })
    expect(sig1271.slice(2 + 62, 2 + 64)).toBe('01') // ownerIndex 1

    const fresh = setup()
    const b = await accountOf(fresh.wallet)
    const sig6492 = await fresh.wallet.signMessage({
      account: b,
      chainId: CHAIN_ID,
      message: 'hello'
    })
    expect(sig6492.endsWith('6492'.repeat(16))).toBe(true)
  })

  it('shows an address on the device, and says when the firmware is too old for that', async () => {
    const { wallet, fake } = setup()
    const account = await accountOf(wallet)
    await expect(wallet.showAddress(account)).resolves.toBe(fake.addressOf(0))

    const old = setup({ fake: new FakePq1Device({ protocolVersion: 0x0201 }) })
    const oldAccount = await accountOf(old.wallet)
    await expect(old.wallet.showAddress(oldAccount)).rejects.toMatchObject({ code: 'outdated' })
  })

  it('refuses chains it was not configured for', async () => {
    const { wallet } = setup({ deployed: true })
    const account = await accountOf(wallet)
    await expect(wallet.signMessage({ account, chainId: 10, message: 'hi' })).rejects.toMatchObject(
      { code: 'unsupported-network' }
    )
  })
})
