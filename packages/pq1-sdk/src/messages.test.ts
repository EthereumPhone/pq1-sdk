// Message and typed-data signing against a fake device: Safe / CoW / Permit2
// typed data goes to the device's own screens (when its firmware has them)
// without ever being retried blind after a refusal, and requests the device
// can't verify for the user are refused first, in plain language.

import { testContext } from '../test/helpers'
import {
  C10_SIG_LEN,
  CAP_OFFCHAIN_COW_ORDER,
  CAP_OFFCHAIN_PERMIT2,
  CAP_OFFCHAIN_SAFE_TX
} from './config'
import { GPV2_SETTLEMENT_ADDRESS } from './cowswap/eip712'
import { Pq1Error } from './errors'
import { signPq1Message, signPq1TypedData, type SignOffchainContext } from './messages'
import { PERMIT2_ADDRESS } from './permit2/eip712'
import { DeviceError } from './transport/hid'
import { buildSignOffchainPayload, type SignOffchainParams } from './transport/offchain'

const mockAccountState = vi.hoisted(() => ({ isDeployed: true, slotIndex: 0, ownerIndex: 1n }))
vi.mock('./aa/accountState', () => ({
  resolvePq1AccountState: vi.fn(async () => mockAccountState)
}))

const WALLET = '0x00000000000000000000000000000000000abc25'
const ZERO = '0x0000000000000000000000000000000000000000'

const SAFE_TX = {
  domain: { chainId: 1, verifyingContract: '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' },
  types: {
    SafeTx: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'nonce', type: 'uint256' }
    ]
  },
  primaryType: 'SafeTx',
  message: {
    to: '0x1234567890AbcdEF1234567890aBcdef12345678',
    value: '1000',
    data: '0x',
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: '3'
  }
}

const COW_ORDER = {
  domain: {
    name: 'Gnosis Protocol',
    version: 'v2',
    chainId: 1,
    verifyingContract: GPV2_SETTLEMENT_ADDRESS
  },
  types: {
    Order: [
      { name: 'sellToken', type: 'address' },
      { name: 'buyToken', type: 'address' },
      { name: 'receiver', type: 'address' },
      { name: 'sellAmount', type: 'uint256' },
      { name: 'buyAmount', type: 'uint256' },
      { name: 'validTo', type: 'uint32' },
      { name: 'appData', type: 'bytes32' },
      { name: 'feeAmount', type: 'uint256' },
      { name: 'kind', type: 'string' },
      { name: 'partiallyFillable', type: 'bool' },
      { name: 'sellTokenBalance', type: 'string' },
      { name: 'buyTokenBalance', type: 'string' }
    ]
  },
  primaryType: 'Order',
  message: {
    sellToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    buyToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    receiver: WALLET,
    sellAmount: '1500000000',
    buyAmount: '500000000000000000',
    validTo: 1893456000,
    appData: `0x${'00'.repeat(32)}`,
    feeAmount: '0',
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20'
  }
}

const PERMIT_BATCH = {
  domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDRESS },
  types: {
    PermitBatch: [
      { name: 'details', type: 'PermitDetails[]' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' }
    ],
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' }
    ]
  },
  primaryType: 'PermitBatch',
  message: {
    details: [
      {
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        amount: '1000000000',
        expiration: '1798761600',
        nonce: '0'
      },
      {
        token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        amount: '500000000000000000',
        expiration: '1798761600',
        nonce: '0'
      }
    ],
    spender: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
    sigDeadline: '1767225600'
  }
}

/** `PERMIT_BATCH` naming its first token twice, which the device refuses. */
const PERMIT_BATCH_SAME_TOKEN_TWICE = {
  ...PERMIT_BATCH,
  message: {
    ...PERMIT_BATCH.message,
    details: [PERMIT_BATCH.message.details[0], PERMIT_BATCH.message.details[0]]
  }
}

function contextWith(caps: number, refuse = false, chainId = 1) {
  const sent: SignOffchainParams[] = []
  const device = {
    getCapabilities: vi.fn(async () => caps),
    signOffchain: vi.fn(async (p: SignOffchainParams) => {
      buildSignOffchainPayload(p)
      sent.push(p)
      if (refuse) {
        throw new DeviceError('SIGN_OFFCHAIN failed: SW=0x6f00', 0x6f00, 'sign-refused')
      }
      return {
        kind: 'deployed' as const,
        newOffchainCount: 1n,
        innerSig: new Uint8Array(C10_SIG_LEN)
      }
    })
  }
  const c: SignOffchainContext = {
    ctx: testContext(),
    device,
    chain: { chainId, getCode: vi.fn(), call: vi.fn() },
    accountIndex: 250,
    sender: WALLET
  }
  return { c, sent, kinds: () => sent.map((p) => p.kind) }
}

describe('signPq1TypedData — Safe / CoW / Permit2 routing', () => {
  beforeEach(() => {
    mockAccountState.isDeployed = true
  })

  it('sends a SafeTx as kind 4 when the device can show it', async () => {
    const { c, kinds } = contextWith(CAP_OFFCHAIN_SAFE_TX)
    await signPq1TypedData(c, SAFE_TX as never)
    expect(kinds()).toEqual(['safe_tx'])
  })

  it('sends a CoW order as kind 5 when the device can show it', async () => {
    const { c, kinds } = contextWith(CAP_OFFCHAIN_COW_ORDER)
    await signPq1TypedData(c, COW_ORDER as never)
    expect(kinds()).toEqual(['cow_order'])
  })

  it('signs the hash blind on firmware without the capability bit', async () => {
    const { c, kinds } = contextWith(CAP_OFFCHAIN_COW_ORDER) // no SafeTx bit
    await signPq1TypedData(c, SAFE_TX as never)
    expect(kinds()).toEqual(['raw32'])
  })

  it('never retries a refused structured sign blind', async () => {
    const { c, kinds } = contextWith(CAP_OFFCHAIN_SAFE_TX | CAP_OFFCHAIN_COW_ORDER, true)
    await expect(signPq1TypedData(c, SAFE_TX as never)).rejects.toMatchObject({
      code: 'sign-refused'
    })
    expect(kinds()).toEqual(['safe_tx'])
  })

  it('refuses a request whose domain names another chain', async () => {
    const { c, kinds } = contextWith(CAP_OFFCHAIN_SAFE_TX, false, 8453)
    await expect(signPq1TypedData(c, SAFE_TX as never)).rejects.toMatchObject({
      userMessage: expect.stringContaining('different network')
    })
    expect(kinds()).toEqual([])
  })

  it('refuses an account not yet deployed on the network', async () => {
    mockAccountState.isDeployed = false
    const { c, kinds } = contextWith(CAP_OFFCHAIN_COW_ORDER)
    await expect(signPq1TypedData(c, COW_ORDER as never)).rejects.toMatchObject({
      userMessage: expect.stringContaining("isn't set up")
    })
    expect(kinds()).toEqual([])
  })

  it('sends a Permit2 permit as kind 6 when the device can show it', async () => {
    const { c, kinds } = contextWith(CAP_OFFCHAIN_PERMIT2)
    await signPq1TypedData(c, PERMIT_BATCH as never)
    expect(kinds()).toEqual(['permit2'])
  })

  it('signs a Permit2 permit blind on firmware without the capability bit', async () => {
    const { c, kinds } = contextWith(CAP_OFFCHAIN_SAFE_TX | CAP_OFFCHAIN_COW_ORDER)
    await signPq1TypedData(c, PERMIT_BATCH as never)
    expect(kinds()).toEqual(['raw32'])
  })

  it('refuses a permit the device would refuse, even on firmware without the bit', async () => {
    for (const caps of [CAP_OFFCHAIN_PERMIT2, 0]) {
      const { c, kinds } = contextWith(caps)
      await expect(
        signPq1TypedData(c, PERMIT_BATCH_SAME_TOKEN_TWICE as never)
      ).rejects.toMatchObject({
        code: 'cannot-display',
        userMessage: expect.stringContaining('the same token more than once')
      })
      expect(kinds()).toEqual([])
    }
  })

  it("tells an undeployed account that Permit2 can't check its signature yet", async () => {
    mockAccountState.isDeployed = false
    const { c, kinds } = contextWith(CAP_OFFCHAIN_PERMIT2)
    await expect(signPq1TypedData(c, PERMIT_BATCH as never)).rejects.toMatchObject({
      userMessage: expect.stringContaining("so Permit2 can't check this signature")
    })
    expect(kinds()).toEqual([])
  })
})

describe('signPq1Message', () => {
  beforeEach(() => {
    mockAccountState.isDeployed = true
  })

  it('sends a short text message for the device to show', async () => {
    const { c, sent } = contextWith(0)
    const signature = await signPq1Message(c, 'hello')
    expect(sent[0]).toMatchObject({ kind: 'personal_sign', accountIndex: 250, chainId: 1n })
    // abi.encode(uint256 ownerIndex, bytes sig): two head words, length, sig.
    expect((signature.length - 2) / 2).toBe(32 * 3 + Math.ceil(C10_SIG_LEN / 32) * 32)
  })

  it('signs a message too long for the screen as its hash', async () => {
    const { c, kinds } = contextWith(0)
    await signPq1Message(c, { raw: new Uint8Array(701).fill(0x41) })
    expect(kinds()).toEqual(['raw32'])
  })

  it("returns the device's ERC-6492 signature unchanged for an undeployed wallet", async () => {
    mockAccountState.isDeployed = false
    const { c } = contextWith(0)
    const blob = new Uint8Array(8608).fill(7)
    c.device.signOffchain = vi.fn(async () => ({
      kind: 'counterfactual' as const,
      newOffchainCount: 0n,
      erc6492Sig: blob
    }))
    const signature = await signPq1Message(c, 'hi')
    expect(signature).toBe(`0x${'07'.repeat(8608)}`)
    expect(vi.mocked(c.device.signOffchain).mock.calls[0]![0]).toMatchObject({
      accountDeployed: false
    })
  })

  it('refuses a chain without the PQ1 contracts before asking the device', async () => {
    const { c, kinds } = contextWith(0, false, 10)
    await expect(signPq1Message(c, 'hi')).rejects.toBeInstanceOf(Pq1Error)
    await expect(signPq1Message(c, 'hi')).rejects.toMatchObject({ code: 'unsupported-network' })
    expect(kinds()).toEqual([])
  })
})
