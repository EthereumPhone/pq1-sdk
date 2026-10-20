// `pq1-sdk/aa`: the ERC-4337 (EntryPoint v0.6) send pipeline, step by step,
// for wallets that want more control than `createPq1Wallet` gives.

export {
  assertPq1CallCount,
  assertSupportedChain,
  encodeWalletCall,
  normalizeCalls,
  prepareTransaction,
  readWalletState,
  signPreparedTransaction,
  submitUserOperation,
  suggestFees,
  waitForUserOperationReceipt
} from './send'
export type {
  NormalizedCall,
  PreparedFee,
  PreparedTransaction,
  PrepareTransactionParams,
  Pq1Call,
  SignPreparedParams,
  WaitForReceiptOptions,
  WalletState
} from './send'
export { BundlerError, describeBundlerError, erc4337Bundler, pimlicoBundler } from './bundler'
export type {
  Erc4337BundlerOptions,
  PimlicoBundlerOptions,
  Pq1Bundler,
  StateOverride,
  UserOperationReceipt,
  UserOpFees
} from './bundler'
export { resolvePq1AccountState } from './accountState'
export type { Pq1AccountState } from './accountState'
export { applyEstimate, buildUserOp, finalize, forEstimate } from './userop'
export type { BuildArgs, UserOpGasEstimate, UserOpJson } from './userop'
export { fitFeesForDeviceDisplay, feeRowsAreExactlyRenderable } from './feeDisplay'
export { parseInitCode } from './factory'
export type { InitCodeFields } from './factory'
export {
  decodeGetAddress,
  encodeExecute,
  encodeExecuteBatch,
  encodeGetAddress,
  encodeGetNonce
} from './contracts'
export { signPq1Message, signPq1TypedData, wrapSignature } from '../messages'
export type { Pq1SignableMessage, Pq1TypedData, SignOffchainContext } from '../messages'
