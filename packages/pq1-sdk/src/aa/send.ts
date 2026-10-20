// Sending a transaction from a PQ1 account: the calls become one ERC-4337
// UserOperation (EntryPoint v0.6), signed on the device and sent to the
// bundler. Split in steps so a wallet can show the fee between them:
//
//   prepareTransaction   chain reads, init code (first deploy), gas estimate,
//                        fee fitted to the device screen    → PreparedTransaction
//   signPreparedTransaction  off-chain count sync, clear-signing bundles,
//                        signature on the device             → signed UserOp
//   submitUserOperation  hand it to the bundler              → UserOp hash
//   waitForUserOperationReceipt  poll until it is included   → receipt
//
// `submitUserOperation` returns as soon as the bundler accepts the UserOp.
// Whether to wait for the receipt is the caller's choice: a UserOp that is
// slow but still included must not be reported as failed, or a user retrying
// it could pay twice.

import {
  ENTRY_POINT_V06,
  ESTIMATE_PLACEHOLDER_GAS,
  FACTORY,
  MAX_BATCH_TXS,
  MAX_TX_LEN,
  PQ1_SUPPORTED_CHAIN_IDS,
  VERIFICATION_GAS_LIMIT,
  VERIFIER_STUB_RETURN_TRUE_CODE
} from '../config'
import type { Pq1Context } from '../context'
import { Pq1Error, userFacingError } from '../errors'
import type { ChainReader } from '../rpc'
import { hexToBytes } from '../transport/bytes'
import type { DeviceCommands } from '../transport/commands'
import type { SignBundle } from '../transport/signResponse'
import { parseCallBigInt, resolvePq1AccountState, type Pq1AccountState } from './accountState'
import {
  BundlerError,
  describeBundlerError,
  type Pq1Bundler,
  type UserOperationReceipt,
  type UserOpFees
} from './bundler'
import { buildCallTrailers, type CallTrailerDeps } from './callTrailers'
import {
  decodeC10Verifier,
  decodeGetAddress,
  encodeC10Verifier,
  encodeExecute,
  encodeExecuteBatch,
  encodeGetAddress,
  encodeGetNonce,
  encodeOffchainSigCount
} from './contracts'
import { parseInitCode } from './factory'
import { fitFeesForDeviceDisplay } from './feeDisplay'
import { applyEstimate, buildUserOp, finalize, forEstimate, type UserOpJson } from './userop'

/** One call of a transaction. `value` defaults to 0 and `data` to `0x`. */
export type Pq1Call = { to: `0x${string}`; value?: bigint; data?: `0x${string}` }

/** A call with every field set. */
export type NormalizedCall = { to: `0x${string}`; value: bigint; data: `0x${string}` }

/** Fill in a call's defaults and refuse what a PQ1 can't do (a contract
 *  deployment, which has no `to`). */
export function normalizeCalls(calls: readonly Pq1Call[]): NormalizedCall[] {
  if (calls.length === 0)
    throw new Pq1Error('invalid-request', 'a transaction needs at least one call')
  return calls.map((c, i) => {
    if (!c.to) {
      throw userFacingError(
        'invalid-request',
        "PQ1 accounts can't deploy contracts directly. Nothing was signed or sent.",
        `call ${i} has no \`to\` (contract creation)`
      )
    }
    return { to: c.to, value: c.value ?? 0n, data: c.data ?? '0x' }
  })
}

/** Refuse a request with more calls than one PQ1 signature can cover, with a
 *  message the user understands (a dapp batch, for example), before any
 *  device or network work starts. */
export function assertPq1CallCount(calls: readonly unknown[]): void {
  if (calls.length <= MAX_BATCH_TXS) return
  throw userFacingError(
    'too-large',
    `A PQ1 can approve up to ${MAX_BATCH_TXS} actions in one transaction, and this request has ${calls.length}. Try again in smaller parts.`,
    `${calls.length} calls > MAX_BATCH_TXS (${MAX_BATCH_TXS})`
  )
}

/** Refuse a call whose data is longer than the device takes for one call,
 *  with a message the user understands, before any device or network work. */
function assertPq1CallDataFits(calls: readonly { data: `0x${string}` }[]): void {
  const longest = Math.max(0, ...calls.map((call) => (call.data.length - 2) / 2))
  if (longest <= MAX_TX_LEN) return
  throw new Pq1Error('too-large', `call data of ${longest} bytes > MAX_TX_LEN (${MAX_TX_LEN})`)
}

/** Refuse a chain the PQ1 contracts aren't deployed on. Without this guard
 *  the pipeline dies much later in gas estimation with a generic error that
 *  doesn't tell the user the chain is the problem. */
export function assertSupportedChain(
  chainId: number,
  supportedChainIds: readonly number[] = PQ1_SUPPORTED_CHAIN_IDS
): void {
  if (supportedChainIds.includes(chainId)) return
  throw new Pq1Error(
    'unsupported-network',
    `chain ${chainId} is not a PQ1 chain (${supportedChainIds.join(', ')})`
  )
}

/** The wallet's on-chain state a UserOp is built from. */
export type WalletState = Pq1AccountState & {
  /** The EntryPoint nonce. */
  nonce: bigint
  /** The SPHINCS+ verifier contract, or null when it couldn't be read. */
  verifier: string | null
  /** The wallet's count of off-chain signatures for the active owner. */
  onchainOffchainCount: bigint
}

/** The fee of a prepared transaction. */
export type PreparedFee = UserOpFees & {
  /** callGasLimit + verificationGasLimit + preVerificationGas. */
  gasLimit: bigint
  /** The most the transaction can cost, in wei: `gasLimit × maxFeePerGas`.
   *  This is what the device shows. The actual cost is usually lower. */
  maxCost: bigint
}

/** A transaction ready for the device: show `fee` to the user, then pass it
 *  to `signPreparedTransaction` (or `Pq1Wallet.sendPrepared`). Send it soon:
 *  it is built on the wallet's current nonce. */
export type PreparedTransaction = {
  chainId: number
  accountIndex: number
  sender: `0x${string}`
  calls: NormalizedCall[]
  /** The unsigned UserOp, its fee already fitted to the device's screen. */
  userOp: UserOpJson
  wallet: WalletState
  /** True when this transaction also deploys the wallet (its first one).
   *  The device then shows an extra "deploy" page. */
  isFirstDeploy: boolean
  fee: PreparedFee
}

/** Inputs of `prepareTransaction`. */
export type PrepareTransactionParams = {
  chain: Pick<ChainReader, 'chainId' | 'getCode' | 'call' | 'request'>
  bundler: Pq1Bundler
  /** Needed only on the wallet's first transaction, for its init code. */
  device: Pick<DeviceCommands, 'getInitCode'>
  logger: Pq1Context['logger']
  /** The account number on the device. */
  accountIndex: number
  /** The PQ1 wallet sending the calls. */
  sender: `0x${string}`
  calls: readonly Pq1Call[]
  /** Fee per gas. When omitted: the bundler's `getGasPrice`, else the
   *  chain's (see `suggestFees`). Only the cap may be rounded up, by less
   *  than 10^4 wei, so the device can show the fee exactly (see
   *  `fitFeesForDeviceDisplay`). */
  fee?: UserOpFees
  supportedChainIds?: readonly number[]
}

/**
 * Build the UserOp for `calls`, ready for the device:
 *   1. read the wallet's state;
 *   2. on its first transaction, get the wallet's init code from the device;
 *   3. estimate the gas, and fit the fee to the device's screen.
 * Nothing is signed and nothing is sent.
 */
export async function prepareTransaction(
  params: PrepareTransactionParams
): Promise<PreparedTransaction> {
  const { chain } = params
  const chainId = chain.chainId
  assertSupportedChain(chainId, params.supportedChainIds)
  const calls = normalizeCalls(params.calls)
  assertPq1CallCount(calls)
  assertPq1CallDataFits(calls)

  // 1.
  const [wallet, fee] = await Promise.all([
    readWalletState(chain, params.sender, params.logger),
    params.fee ?? suggestFees(chain, params.bundler)
  ])

  // 2.
  const initCode = wallet.isDeployed
    ? new Uint8Array(0)
    : await firstDeploymentInitCode(params, chainId)

  // 3. The estimate's callData carries the wallet's off-chain count, so the
  // wallet accepts it; the device's (at least as high) replaces it when it
  // signs.
  const userOp = fitFeesForDeviceDisplay(
    await estimateUserOp(params.bundler, chainId, params.logger, {
      sender: params.sender,
      wallet,
      initCode,
      callData: encodeWalletCall(wallet.ownerIndex, wallet.onchainOffchainCount, calls),
      fee
    })
  )

  const gasLimit =
    BigInt(userOp.callGasLimit) +
    BigInt(userOp.verificationGasLimit) +
    BigInt(userOp.preVerificationGas)
  const maxFeePerGas = BigInt(userOp.maxFeePerGas)
  return {
    chainId,
    accountIndex: params.accountIndex,
    sender: params.sender,
    calls,
    userOp,
    wallet,
    isFirstDeploy: !wallet.isDeployed,
    fee: {
      maxFeePerGas,
      maxPriorityFeePerGas: BigInt(userOp.maxPriorityFeePerGas),
      gasLimit,
      maxCost: gasLimit * maxFeePerGas
    }
  }
}

/** Fees for a UserOp: the bundler's (`getGasPrice`) when it has them, else
 *  the chain's priority fee plus twice the latest base fee. */
export async function suggestFees(
  chain: Pick<ChainReader, 'chainId' | 'request'>,
  bundler: Pick<Pq1Bundler, 'getGasPrice'>
): Promise<UserOpFees> {
  if (bundler.getGasPrice) return bundler.getGasPrice(chain.chainId)
  const [tipHex, block] = await Promise.all([
    chain.request<`0x${string}`>('eth_maxPriorityFeePerGas'),
    chain.request<{ baseFeePerGas?: `0x${string}` }>('eth_getBlockByNumber', ['latest', false])
  ])
  const maxPriorityFeePerGas = BigInt(tipHex)
  const baseFee = BigInt(block.baseFeePerGas ?? '0x0')
  return { maxFeePerGas: baseFee * 2n + maxPriorityFeePerGas, maxPriorityFeePerGas }
}

/** Inputs of `signPreparedTransaction`. */
export type SignPreparedParams = {
  ctx: CallTrailerDeps
  device: Pick<DeviceCommands, 'offchainSync' | 'signUserOp' | 'signUserOpBatch'>
  prepared: PreparedTransaction
}

/**
 * Have the device sign a prepared transaction and return the UserOp ready
 * for the bundler:
 *   1. raise the device's off-chain signature count to the wallet's;
 *   2. have the device sign it, with each call's clear-signing bundles;
 *   3. put the device's signature (and count) into the UserOp.
 */
export async function signPreparedTransaction(params: SignPreparedParams): Promise<UserOpJson> {
  const { prepared, device } = params
  const { wallet } = prepared

  // 1. The device writes its own off-chain count into the UserOp's
  // callData, and the wallet reverts a count below its own — after the
  // UserOp has paid its fee. Raising the device's count first keeps it at
  // least the wallet's, even after a firmware reflash wiped the device's
  // counters; the device asks the user to confirm a raise. A device error
  // here (locked, unplugged, declined) stops the send.
  if (wallet.onchainOffchainCount > 0n) {
    await device.offchainSync({
      accountIndex: prepared.accountIndex,
      chainId: prepared.chainId,
      slotIndex: wallet.slotIndex,
      targetCount: wallet.onchainOffchainCount
    })
  }

  // 2.
  const signed = await signOnDevice(params, prepared.isFirstDeploy)

  // 3.
  return finalize(
    {
      ...prepared.userOp,
      callData: encodeWalletCall(wallet.ownerIndex, signed.newOffchainCount, prepared.calls)
    },
    { initCode: signed.initCode, signature: signed.type2 }
  )
}

/** Hand a signed UserOp to the bundler; resolves with its hash once the
 *  bundler accepts it. A bundler that doesn't answer may still have taken
 *  it, so that is reported as `send-unconfirmed`, never as a failure. */
export async function submitUserOperation(
  bundler: Pq1Bundler,
  chainId: number,
  op: UserOpJson
): Promise<`0x${string}`> {
  try {
    return await bundler.sendUserOperation(chainId, op)
  } catch (e) {
    if (e instanceof BundlerError || e instanceof Pq1Error) throw e
    throw new Pq1Error('send-unconfirmed', `eth_sendUserOperation: ${String(e)}`, { cause: e })
  }
}

/** Options for `waitForUserOperationReceipt`. */
export type WaitForReceiptOptions = {
  /** Give up after this long. Default 3 minutes. */
  timeoutMs?: number
  /** Time between polls. Default 2 s. */
  pollIntervalMs?: number
  signal?: AbortSignal
}

/** Poll the bundler until the UserOp is included. Throws a `send-unconfirmed`
 *  `Pq1Error` on timeout: the UserOp may still be included later. Check
 *  `receipt.success`: an included UserOp can still have reverted. */
export async function waitForUserOperationReceipt(
  bundler: Pick<Pq1Bundler, 'getUserOperationReceipt'>,
  chainId: number,
  userOpHash: `0x${string}`,
  options: WaitForReceiptOptions = {}
): Promise<UserOperationReceipt> {
  const timeoutMs = options.timeoutMs ?? 180_000
  const interval = options.pollIntervalMs ?? 2_000
  const deadline = Date.now() + timeoutMs
  while (true) {
    options.signal?.throwIfAborted()
    const receipt = await bundler.getUserOperationReceipt(chainId, userOpHash)
    if (receipt) return receipt
    if (Date.now() + interval > deadline) {
      throw new Pq1Error(
        'send-unconfirmed',
        `UserOp ${userOpHash} not included after ${timeoutMs} ms`
      )
    }
    await sleep(interval, options.signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Deploy status, active owner, EntryPoint nonce, verifier and off-chain
 *  count of the wallet `sender`. The independent reads run in parallel. */
export async function readWalletState(
  chain: Pick<ChainReader, 'getCode' | 'call'>,
  sender: `0x${string}`,
  logger: Pq1Context['logger']
): Promise<WalletState> {
  const [accountState, nonceHex, verifier] = await Promise.all([
    resolvePq1AccountState(chain, sender),
    chain.call({ to: ENTRY_POINT_V06, data: encodeGetNonce(sender) }),
    readVerifier(chain, logger)
  ])
  const onchainOffchainCount = accountState.isDeployed
    ? await readOffchainSigCount(chain, sender, accountState.ownerIndex, logger)
    : 0n
  return {
    ...accountState,
    nonce: parseCallBigInt(nonceHex, 'EntryPoint getNonce'),
    verifier,
    onchainOffchainCount
  }
}

/** The SPHINCS+ verifier contract. It is read from the factory, which is
 *  deployed even when the wallet isn't yet. Null when the read fails: the
 *  estimate then fails and the send is refused, rather than sent with
 *  too little gas. */
async function readVerifier(
  chain: Pick<ChainReader, 'call'>,
  logger: Pq1Context['logger']
): Promise<string | null> {
  try {
    const result = await chain.call({ to: FACTORY, data: encodeC10Verifier() })
    return decodeC10Verifier(result)
  } catch (e) {
    logger.warn('could not read the SPHINCS+ verifier for gas estimation', e)
    return null
  }
}

/** The wallet's `offchainSigCount` for `ownerIndex`, or 0 when the read
 *  fails. 0 is right for a fresh wallet; for one that has signed off-chain
 *  messages the estimate then fails and the send is refused before signing. */
async function readOffchainSigCount(
  chain: Pick<ChainReader, 'call'>,
  sender: `0x${string}`,
  ownerIndex: bigint,
  logger: Pq1Context['logger']
): Promise<bigint> {
  try {
    const result = await chain.call({ to: sender, data: encodeOffchainSigCount(ownerIndex) })
    return BigInt(result || '0x0')
  } catch (e) {
    logger.warn('reading the off-chain signature count failed', e)
    return 0n
  }
}

/**
 * The init code that deploys the wallet, from the device.
 *
 * The estimate needs the real init code: a placeholder fails the factory
 * (two identical zero keys) or deploys to another address. The device
 * returns it without asking the user to confirm, and it is byte for byte
 * what SIGN_USEROP puts in the deploying UserOp.
 *
 * The firmware derives the wallet address from its own copy of the factory
 * address and the wallet's init-code hash. If either differs from what is
 * deployed on this chain, the EntryPoint would refuse the deployment with an
 * opaque error, so both are checked here: the init code must call our
 * factory, and the factory must agree the device's keys deploy to `sender`.
 */
async function firstDeploymentInitCode(
  params: PrepareTransactionParams,
  chainId: number
): Promise<Uint8Array> {
  // Each GET_INIT_CODE spends a signature of the wallet's few-time bootstrap
  // key, so none is asked for on a chain the factory isn't deployed on.
  if ((await params.chain.getCode(FACTORY)) === '0x') {
    throw new Pq1Error('unsupported-network', `factory ${FACTORY} has no code on chain ${chainId}`)
  }
  const initCode = await params.device.getInitCode(params.accountIndex, chainId)
  const fields = parseInitCode(initCode)
  if (!fields || fields.factory.toLowerCase() !== FACTORY.toLowerCase()) {
    const mismatch = new Pq1Error(
      'firmware-mismatch',
      `firmware initCode targets factory ${fields?.factory ?? '(unparseable initCode)'}, expected ${FACTORY}`
    )
    params.logger.error(mismatch)
    throw mismatch
  }
  const predictedHex = await params.chain.call({
    to: FACTORY,
    data: encodeGetAddress(fields.masterPkSeed, fields.masterPkRoot)
  })
  const predicted = decodeGetAddress(predictedHex)
  if (predicted.toLowerCase() !== params.sender.toLowerCase()) {
    const mismatch = new Pq1Error(
      'firmware-mismatch',
      `device reports sender ${params.sender}, factory on chain ${chainId} predicts ${predicted}`
    )
    params.logger.error(mismatch)
    throw mismatch
  }
  return initCode
}

/**
 * The UserOp with the bundler's gas estimate and the chosen fee.
 *
 * Estimation runs with a placeholder signature, which can't pass a real
 * SPHINCS+ check — and the wallet only lets its execute functions run after
 * a passing check, so the simulated execution would revert and the bundler
 * couldn't estimate the call gas. So the verifier contract is replaced, for
 * the simulation only, by a stub that accepts any signature. Execution never
 * calls the verifier, so the call gas stays exact; the verification gas is
 * the fixed `VERIFICATION_GAS_LIMIT` anyway.
 */
async function estimateUserOp(
  bundler: Pq1Bundler,
  chainId: number,
  logger: Pq1Context['logger'],
  args: {
    sender: `0x${string}`
    wallet: WalletState
    initCode: Uint8Array
    callData: `0x${string}`
    fee: UserOpFees
  }
): Promise<UserOpJson> {
  const { wallet } = args
  const opForEstimate = forEstimate(
    buildUserOp({
      sender: args.sender,
      nonce: wallet.nonce,
      initCode: args.initCode,
      callData: args.callData,
      callGasLimit: ESTIMATE_PLACEHOLDER_GAS.callGas,
      verificationGasLimit: VERIFICATION_GAS_LIMIT,
      preVerificationGas: wallet.isDeployed
        ? ESTIMATE_PLACEHOLDER_GAS.preVerificationGas
        : ESTIMATE_PLACEHOLDER_GAS.preVerificationGasFirstDeploy,
      maxFeePerGas: args.fee.maxFeePerGas,
      maxPriorityFeePerGas: args.fee.maxPriorityFeePerGas,
      // `forEstimate` puts in the placeholder signature.
      signature: new Uint8Array(0)
    }),
    wallet.ownerIndex
  )
  const verifierStub = wallet.verifier
    ? { [wallet.verifier.toLowerCase() as `0x${string}`]: { code: VERIFIER_STUB_RETURN_TRUE_CODE } }
    : undefined
  let estimate
  try {
    estimate = await bundler.estimateUserOperationGas(chainId, opForEstimate, verifierStub)
  } catch (e) {
    if (!(e instanceof BundlerError)) {
      throw new Pq1Error('bundler-unreachable', `eth_estimateUserOperationGas: ${String(e)}`, {
        cause: e
      })
    }
    // Even with the stub, the estimate failed: the UserOp would revert or
    // run out of gas on-chain. Sending it with guessed limits would most
    // likely fail and still cost a fee, so the send is refused instead.
    logger.warn('eth_estimateUserOperationGas failed', e)
    throw new Pq1Error('bundler-rejected', `eth_estimateUserOperationGas failed: ${e.message}`, {
      cause: e,
      userMessage:
        describeBundlerError(e.message) ??
        "This transaction can't be sent because it would most likely fail on the network, which would still cost you a fee. Nothing was sent."
    })
  }
  return {
    ...applyEstimate(opForEstimate, estimate),
    verificationGasLimit: `0x${VERIFICATION_GAS_LIMIT.toString(16)}`
  }
}

/** Attach each call's clear-signing bundles and have the device sign the
 *  UserOp: SIGN_USEROP for one call, SIGN_USEROP_BATCH for more. */
async function signOnDevice(
  params: SignPreparedParams,
  includeInitCode: boolean
): Promise<SignBundle> {
  const { prepared, device } = params
  const op = prepared.userOp
  const { perCallTrailers, nameBundles } = await buildCallTrailers(params.ctx, {
    chainId: prepared.chainId,
    sender: prepared.sender,
    calls: prepared.calls
  })
  const header = {
    chainId: prepared.chainId,
    accountIndex: prepared.accountIndex,
    slotIndex: prepared.wallet.slotIndex,
    includeInitCode,
    sender: prepared.sender,
    nonce: prepared.wallet.nonce,
    callGas: BigInt(op.callGasLimit),
    verGas: BigInt(op.verificationGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    maxFeePerGas: BigInt(op.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas)
  }
  const calls = prepared.calls.map((c, i) => ({
    to: c.to,
    value: c.value,
    data: hexToBytes(c.data),
    ...perCallTrailers[i]
  }))
  return calls.length === 1
    ? device.signUserOp({ ...header, ...calls[0]!, nameBundles })
    : device.signUserOpBatch({ ...header, calls, nameBundles })
}

/** The wallet call that runs `calls`: `executeWithOffchainCount` for one,
 *  `executeBatchWithOffchainCount` for several. */
export function encodeWalletCall(
  ownerIndex: bigint,
  offchainCount: bigint,
  calls: readonly NormalizedCall[]
): `0x${string}` {
  if (calls.length === 1) {
    const c = calls[0]!
    return encodeExecute(ownerIndex, offchainCount, c.to, c.value, c.data)
  }
  return encodeExecuteBatch(
    ownerIndex,
    offchainCount,
    calls.map((c) => c.to),
    calls.map((c) => c.value),
    calls.map((c) => c.data)
  )
}
