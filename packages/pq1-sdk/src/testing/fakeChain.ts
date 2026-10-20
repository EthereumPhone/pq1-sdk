// A fake chain and a fake bundler for tests, to go with `FakePq1Device`.

import { decodeFunctionData, encodeAbiParameters, parseAbi, type Hex } from 'viem'

import type { Pq1Bundler, StateOverride, UserOperationReceipt, UserOpFees } from '../aa/bundler'
import { BundlerError } from '../aa/bundler'
import type { UserOpGasEstimate, UserOpJson } from '../aa/userop'
import { FACTORY } from '../config'
import type { Eip1193Request } from '../rpc'
import type { FakePq1Device } from './fakeDevice'

const READ_ABI = parseAbi([
  'function nextOwnerIndex() view returns (uint256)',
  'function offchainSigCount(uint256 ownerIndex) view returns (uint256)',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function c10Verifier() view returns (address)',
  'function getAddress(bytes32 masterPkSeed, bytes32 masterPkRoot) view returns (address)'
])

const word = (v: bigint) => encodeAbiParameters([{ type: 'uint256' }], [v])
const addressWord = (a: `0x${string}`) => encodeAbiParameters([{ type: 'address' }], [a])

/** The SPHINCS+ verifier address the fake factory reports. */
export const FAKE_VERIFIER = '0x00000000000000000000000000000000000c1010'

/** Options for `createFakeChain`. */
export type FakeChainOptions = {
  chainId?: number
  /** Answers the factory's `getAddress` the way the real factory would for
   *  this fake's keys. */
  device?: Pick<FakePq1Device, 'predictAddress'>
  /** Addresses that have code. */
  deployed?: string[]
  /** The EntryPoint nonce of every wallet. Default 0. */
  nonce?: bigint
  /** Every wallet's `offchainSigCount`. Default 0. */
  offchainSigCount?: bigint
  /** False for a chain the factory isn't deployed on. Default true. */
  factoryDeployed?: boolean
}

/** A fake chain: an EIP-1193 `request` answering the reads the SDK makes.
 *  Any other call throws, so a test notices an unexpected read. */
export function createFakeChain(options: FakeChainOptions = {}): {
  request: Eip1193Request
  /** Give `address` code (simulate its deployment). */
  deploy(address: string): void
  /** Every request received. */
  calls: { method: string; params: unknown[] }[]
} {
  const deployed = new Set((options.deployed ?? []).map((a) => a.toLowerCase()))
  const calls: { method: string; params: unknown[] }[] = []

  const answerCall = (data: Hex): Hex => {
    const { functionName, args } = decodeFunctionData({ abi: READ_ABI, data })
    switch (functionName) {
      case 'nextOwnerIndex':
        return word(2n) // owner 1 = slot 0
      case 'offchainSigCount':
        return word(options.offchainSigCount ?? 0n)
      case 'getNonce':
        return word(options.nonce ?? 0n)
      case 'c10Verifier':
        return addressWord(FAKE_VERIFIER)
      case 'getAddress': {
        const [seed, root] = args as [`0x${string}`, `0x${string}`]
        return addressWord(
          options.device?.predictAddress(seed, root) ?? '0x0000000000000000000000000000000000000000'
        )
      }
    }
  }

  const request: Eip1193Request = async ({ method, params = [] }) => {
    calls.push({ method, params })
    switch (method) {
      case 'eth_chainId':
        return `0x${(options.chainId ?? 84532).toString(16)}`
      case 'eth_getCode': {
        const address = String(params[0]).toLowerCase()
        if (address === FACTORY.toLowerCase()) {
          return options.factoryDeployed === false ? '0x' : '0x6080604052'
        }
        return deployed.has(address) ? '0x6080604052' : '0x'
      }
      case 'eth_call':
        return answerCall((params[0] as { data: Hex }).data)
      case 'eth_maxPriorityFeePerGas':
        return '0xf4240' // 1 gwei / 1000
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: '0x3b9aca00' } // 1 gwei
      default:
        throw new Error(`fake chain: unexpected ${method}`)
    }
  }

  return { request, deploy: (address) => deployed.add(address.toLowerCase()), calls }
}

/** Options for `createFakeBundler`. */
export type FakeBundlerOptions = {
  /** The gas estimate returned. */
  estimate?: UserOpGasEstimate
  /** Fees returned by `getGasPrice`; omit to make the SDK ask the chain. */
  gasPrice?: UserOpFees
  /** Fail `eth_estimateUserOperationGas` with this bundler message. */
  estimateError?: string
  /** Fail `eth_sendUserOperation` with this bundler message. */
  sendError?: string
  /** Include each sent UserOp right away (a receipt is available at once).
   *  Default true. */
  autoInclude?: boolean
}

/** A fake bundler that records what it receives. */
export function createFakeBundler(options: FakeBundlerOptions = {}): Pq1Bundler & {
  estimates: { chainId: number; op: UserOpJson; stateOverride?: StateOverride }[]
  sent: { chainId: number; op: UserOpJson; userOpHash: `0x${string}` }[]
  /** Make a receipt available for `userOpHash`. */
  include(userOpHash: `0x${string}`, success?: boolean): void
} {
  const estimates: { chainId: number; op: UserOpJson; stateOverride?: StateOverride }[] = []
  const sent: { chainId: number; op: UserOpJson; userOpHash: `0x${string}` }[] = []
  const receipts = new Map<string, UserOperationReceipt>()

  const include = (userOpHash: `0x${string}`, success = true) => {
    receipts.set(userOpHash, {
      userOpHash,
      success,
      actualGasCost: 1_000_000n,
      transactionHash: `0x${'ee'.repeat(32)}`,
      blockNumber: 1234n,
      raw: {
        userOpHash,
        success,
        actualGasCost: '0xf4240',
        actualGasUsed: '0x5208',
        logs: [],
        receipt: {
          transactionHash: `0x${'ee'.repeat(32)}`,
          blockHash: `0x${'bb'.repeat(32)}`,
          blockNumber: '0x4d2'
        }
      }
    })
  }

  return {
    estimates,
    sent,
    include,
    async estimateUserOperationGas(chainId, op, stateOverride) {
      estimates.push({ chainId, op, stateOverride })
      if (options.estimateError) throw new BundlerError(-32500, options.estimateError)
      return (
        options.estimate ?? {
          callGasLimit: '0x30d40', // 200k
          verificationGasLimit: '0x186a0', // replaced by the 800k pin
          preVerificationGas: '0xc350' // 50k
        }
      )
    },
    async sendUserOperation(chainId, op) {
      if (options.sendError) throw new BundlerError(-32500, options.sendError)
      const userOpHash = `0x${(sent.length + 1).toString(16).padStart(64, 'a')}` as `0x${string}`
      sent.push({ chainId, op, userOpHash })
      if (options.autoInclude !== false) include(userOpHash)
      return userOpHash
    },
    async getUserOperationReceipt(_chainId, userOpHash) {
      return receipts.get(userOpHash) ?? null
    },
    ...(options.gasPrice ? { getGasPrice: async () => options.gasPrice! } : {})
  }
}
