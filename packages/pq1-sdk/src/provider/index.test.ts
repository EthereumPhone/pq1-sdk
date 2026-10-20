// What dapps are told about a PQ1 account.

import type { UserOperationReceipt } from '../aa/bundler'
import {
  buildCallsStatus,
  buildPq1Capabilities,
  callsFromSendCalls,
  callsFromTransaction,
  isPq1AccountCodeQuery,
  PQ1_UNDEPLOYED_ACCOUNT_CODE,
  resolvePq1AccountCode
} from '.'

const PQ1_ACCOUNT = '0x00000000000000000000000000000000000ABC25'
const OTHER_ACCOUNT = '0x1111111111111111111111111111111111111111'
const DEPLOYED_CODE = '0x6080604052'

describe('isPq1AccountCodeQuery', () => {
  const base = { pq1Accounts: [PQ1_ACCOUNT], chainId: 8453 }

  it('answers for a PQ1 account the dapp is connected to, on a PQ1 chain', () => {
    expect(
      isPq1AccountCodeQuery({
        ...base,
        connectedAccounts: [PQ1_ACCOUNT],
        address: PQ1_ACCOUNT.toLowerCase()
      })
    ).toBe(true)
  })

  it("leaves accounts the dapp isn't connected to alone, so it learns nothing about them", () => {
    expect(isPq1AccountCodeQuery({ ...base, connectedAccounts: [], address: PQ1_ACCOUNT })).toBe(
      false
    )
    expect(
      isPq1AccountCodeQuery({ ...base, connectedAccounts: [OTHER_ACCOUNT], address: PQ1_ACCOUNT })
    ).toBe(false)
  })

  it('leaves chains PQ1 wallets are not deployed on, and other accounts, alone', () => {
    expect(
      isPq1AccountCodeQuery({
        ...base,
        chainId: 137,
        connectedAccounts: [PQ1_ACCOUNT],
        address: PQ1_ACCOUNT
      })
    ).toBe(false)
    expect(
      isPq1AccountCodeQuery({ ...base, connectedAccounts: [OTHER_ACCOUNT], address: OTHER_ACCOUNT })
    ).toBe(false)
  })
})

describe('resolvePq1AccountCode', () => {
  const requestAnswering = (code: string) =>
    vi.fn(async (_args: { method: string; params?: unknown[] }) => code as unknown)

  it("answers with a deployed wallet's real code", async () => {
    expect(
      await resolvePq1AccountCode(requestAnswering(DEPLOYED_CODE), [PQ1_ACCOUNT, 'latest'])
    ).toBe(DEPLOYED_CODE)
  })

  it('answers with a non-empty stub before the wallet is deployed', async () => {
    const request = requestAnswering('0x')
    expect(await resolvePq1AccountCode(request, [PQ1_ACCOUNT])).toBe(PQ1_UNDEPLOYED_ACCOUNT_CODE)
    expect(await resolvePq1AccountCode(request, [PQ1_ACCOUNT, 'pending'])).toBe(
      PQ1_UNDEPLOYED_ACCOUNT_CODE
    )
  })

  it('passes a query at a past block through unchanged', async () => {
    const request = requestAnswering('0x')
    expect(await resolvePq1AccountCode(request, [PQ1_ACCOUNT, '0x10'])).toBe('0x')
    expect(request).toHaveBeenCalledWith({ method: 'eth_getCode', params: [PQ1_ACCOUNT, '0x10'] })
  })

  it('answers with the stub when the network request fails', async () => {
    const request = vi.fn(async () => {
      throw new Error('network down')
    })
    expect(await resolvePq1AccountCode(request, [PQ1_ACCOUNT, 'latest'])).toBe(
      PQ1_UNDEPLOYED_ACCOUNT_CODE
    )
  })
})

describe('buildPq1Capabilities', () => {
  it('offers atomic batches only on the chains PQ1 wallets can be deployed on', () => {
    expect(buildPq1Capabilities([1, 137])).toEqual({
      '0x1': {
        atomic: { status: 'supported' },
        atomicBatch: { supported: true },
        paymasterService: { supported: false },
        auxiliaryFunds: { supported: false }
      },
      '0x89': {
        atomic: { status: 'unsupported' },
        atomicBatch: { supported: false },
        paymasterService: { supported: false },
        auxiliaryFunds: { supported: false }
      }
    })
  })
})

describe('callsFromSendCalls / callsFromTransaction', () => {
  it('maps EIP-5792 calls to PQ1 calls', () => {
    expect(
      callsFromSendCalls({
        chainId: '0x2105',
        calls: [{ to: OTHER_ACCOUNT, value: '0x10', data: '0xabcd' }, { to: OTHER_ACCOUNT }]
      })
    ).toEqual({
      chainId: 8453,
      calls: [
        { to: OTHER_ACCOUNT, value: 16n, data: '0xabcd' },
        { to: OTHER_ACCOUNT, value: 0n, data: '0x' }
      ]
    })
  })

  it('refuses more calls than one signature covers, in plain words', () => {
    const calls = Array.from({ length: 5 }, () => ({ to: OTHER_ACCOUNT }))
    expect(() => callsFromSendCalls({ chainId: '0x1', calls })).toThrow(
      expect.objectContaining({
        code: 'too-large',
        userMessage: expect.stringContaining('up to 4')
      })
    )
  })

  it('refuses contract creation and a foreign `from`', () => {
    expect(() => callsFromTransaction({ data: '0x6080' })).toThrow(
      expect.objectContaining({ code: 'invalid-request' })
    )
    expect(() =>
      callsFromTransaction({ from: OTHER_ACCOUNT, to: PQ1_ACCOUNT }, PQ1_ACCOUNT)
    ).toThrow(expect.objectContaining({ code: 'invalid-request' }))
  })
})

describe('buildCallsStatus', () => {
  it('is pending without a receipt, and confirmed or reverted with one', () => {
    expect(buildCallsStatus({ id: '0x01', chainId: 8453, receipt: null })).toMatchObject({
      status: 100,
      chainId: '0x2105',
      atomic: true
    })
    const receipt: UserOperationReceipt = {
      userOpHash: '0x01',
      success: false,
      actualGasCost: 1n,
      transactionHash: `0x${'ee'.repeat(32)}`,
      blockNumber: 16n,
      raw: {
        logs: [{ address: PQ1_ACCOUNT }],
        actualGasUsed: '0x5208',
        receipt: { blockHash: '0xbb' }
      }
    }
    expect(buildCallsStatus({ id: '0x01', chainId: 8453, receipt })).toMatchObject({
      status: 500,
      receipts: [
        {
          status: '0x0',
          blockNumber: '0x10',
          gasUsed: '0x5208',
          logs: [{ address: PQ1_ACCOUNT }],
          transactionHash: receipt.transactionHash
        }
      ]
    })
  })
})
