/**
 * Client SDK — point wallets / agents at the L2 Send Guard proxy.
 * See ./README.md for viem + ethers v6 + AgentKit usage.
 */
export {
  GUARD_CHAIN_HEADER,
  createGuardConnection,
  createGuardFetch,
  viemHttpArgs,
  ethersV6Connection,
  applyGuardHeaders,
  type GuardProviderOptions,
  type GuardConnection,
} from "./provider.js";

export {
  ERR_CHAIN_MISMATCH,
  ERR_DEFINITE_REVERT,
  ERR_POLICY_DENIED,
  ERR_STRICT_UNCERTAIN,
  ERR_UNSIGNED_SEND_REFUSED,
  guardErrorCode,
  guardErrorData,
  isChainMismatchError,
  isDefiniteRevertError,
  isPolicyDeniedError,
  isStrictUncertainError,
  isUnsignedSendRefusedError,
  isGuardAbortError,
  classifyGuardError,
  type GuardRpcErrorLike,
  type GuardErrorKind,
} from "./errors.js";
