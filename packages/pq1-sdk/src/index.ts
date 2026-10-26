// pq1-sdk: add the PQ1 post-quantum hardware wallet to a browser-extension
// wallet. This entry point has the high-level API; the subpaths have the
// layers under it:
//
//   pq1-sdk/extension      MV3 helpers: permission page, service-worker device manager
//   pq1-sdk/provider       dapp-facing answers (eth_getCode, EIP-5792)
//   pq1-sdk/aa             the ERC-4337 send pipeline, step by step
//   pq1-sdk/clear-signing  catalogs and clear-signing bundles
//   pq1-sdk/transport      WebHID transport and raw device commands
//   pq1-sdk/testing        a fake PQ1, chain and bundler for tests

export { createPq1Wallet } from './wallet'
export type { AccountRef, Pq1Wallet, Pq1WalletOptions } from './wallet'

export { Pq1Device } from './device'
export type { Pq1Account, Pq1DeviceConnectOptions, Pq1DeviceInfo } from './device'

export { Pq1Error, PQ1_ERROR_MESSAGES, getUserMessage, isPq1Error, toPq1Error } from './errors'
export type { DeviceErrorCode, Pq1ErrorCode, Pq1ErrorOptions } from './errors'
export { DeviceError } from './transport/hid'
export { BundlerError, erc4337Bundler, pimlicoBundler } from './aa/bundler'
export type {
  Erc4337BundlerOptions,
  PimlicoBundlerOptions,
  Pq1Bundler,
  StateOverride,
  UserOperationReceipt,
  UserOpFees
} from './aa/bundler'
export type { PreparedFee, PreparedTransaction, Pq1Call, WalletState } from './aa/send'
export type { UserOpJson } from './aa/userop'
export type { Pq1SignableMessage, Pq1TypedData } from './messages'

export {
  CATALOG_FILE_NAMES,
  consoleLogger,
  createPq1Context,
  httpCatalogs,
  memoryCatalogs,
  silentLogger
} from './context'
export type {
  CatalogName,
  CatalogSource,
  Pq1Context,
  Pq1ContextOptions,
  Pq1Logger,
  SafeTxService
} from './context'
export { safeTransactionService } from './safe/api'
export type { SafeTransactionServiceOptions } from './safe/api'
export { createChainReader, httpRpc } from './rpc'
export type { ChainReader, Eip1193Request, RpcTransport } from './rpc'
export { memoryStore } from './store'
export type { KeyValueStore } from './store'

export {
  CAP_OFFCHAIN_COW_ORDER,
  CAP_OFFCHAIN_PERMIT2,
  CAP_OFFCHAIN_SAFE_TX,
  ENTRY_POINT_V06,
  FACTORY,
  MAX_ACCOUNT_INDEX,
  MAX_BATCH_TXS,
  MAX_TX_LEN,
  MAX_TX_LEN_LEGACY,
  MAX_BATCH_CALL_DATA_TOTAL_LEN,
  SAFE_INNER_DATA_MAX_LEN,
  EXEC_TRANSACTION_MAX_CALLDATA_LEN,
  CAP_SIGN_USEROP_DATA_8K,
  maxCallDataLen,
  PQ1_PID,
  PQ1_SUPPORTED_CHAIN_IDS,
  PQ1_VID
} from './config'
