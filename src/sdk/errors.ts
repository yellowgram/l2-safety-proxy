/**
 * Typed helpers for L2 Send Guard JSON-RPC error codes.
 * Integrators (viem / ethers / AgentKit) can branch without scraping message text.
 *
 * Codes:
 *   -32080  definite revert abort (Layer 1)
 *   -32081  eth_sendTransaction refused (no custody)
 *   -32082  strict-mode uncertain abort (Layer 1)
 *   -32083  policy_denied (Layer 2 — never fail-open)
 *   -32084  chain_mismatch (signed chainId ≠ selected chain)
 */

import {
  ERR_CHAIN_MISMATCH,
  ERR_DEFINITE_REVERT,
  ERR_POLICY_DENIED,
  ERR_STRICT_UNCERTAIN,
  ERR_UNSIGNED_SEND_REFUSED,
} from "../types/index.js";

export {
  ERR_CHAIN_MISMATCH,
  ERR_DEFINITE_REVERT,
  ERR_POLICY_DENIED,
  ERR_STRICT_UNCERTAIN,
  ERR_UNSIGNED_SEND_REFUSED,
};

/** Minimal JSON-RPC error shape (viem / ethers / raw). */
export interface GuardRpcErrorLike {
  code?: number;
  message?: string;
  data?: unknown;
}

export type GuardErrorKind =
  | "definite_revert"
  | "policy_denied"
  | "strict_uncertain"
  | "unsigned_refused"
  | "chain_mismatch"
  | "other";

function asError(err: unknown): GuardRpcErrorLike | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  // viem often nests under .cause or puts code on the error itself
  if (typeof e.code === "number") return e as GuardRpcErrorLike;
  if (e.cause && typeof e.cause === "object" && typeof (e.cause as GuardRpcErrorLike).code === "number") {
    return e.cause as GuardRpcErrorLike;
  }
  // ethers v6: error.info?.error or error.error
  const nested =
    (e.info as { error?: GuardRpcErrorLike } | undefined)?.error ??
    (e.error as GuardRpcErrorLike | undefined);
  if (nested && typeof nested.code === "number") return nested;
  return e as GuardRpcErrorLike;
}

export function guardErrorCode(err: unknown): number | undefined {
  return asError(err)?.code;
}

export function isDefiniteRevertError(err: unknown): boolean {
  return guardErrorCode(err) === ERR_DEFINITE_REVERT;
}

export function isPolicyDeniedError(err: unknown): boolean {
  return guardErrorCode(err) === ERR_POLICY_DENIED;
}

export function isStrictUncertainError(err: unknown): boolean {
  return guardErrorCode(err) === ERR_STRICT_UNCERTAIN;
}

export function isUnsignedSendRefusedError(err: unknown): boolean {
  return guardErrorCode(err) === ERR_UNSIGNED_SEND_REFUSED;
}

export function isChainMismatchError(err: unknown): boolean {
  return guardErrorCode(err) === ERR_CHAIN_MISMATCH;
}

/** True if the error is any Guard send-intercept abort (not a generic RPC failure). */
export function isGuardAbortError(err: unknown): boolean {
  const code = guardErrorCode(err);
  return (
    code === ERR_DEFINITE_REVERT ||
    code === ERR_POLICY_DENIED ||
    code === ERR_STRICT_UNCERTAIN ||
    code === ERR_UNSIGNED_SEND_REFUSED ||
    code === ERR_CHAIN_MISMATCH
  );
}

export function classifyGuardError(err: unknown): GuardErrorKind {
  const code = guardErrorCode(err);
  if (code === ERR_DEFINITE_REVERT) return "definite_revert";
  if (code === ERR_POLICY_DENIED) return "policy_denied";
  if (code === ERR_STRICT_UNCERTAIN) return "strict_uncertain";
  if (code === ERR_UNSIGNED_SEND_REFUSED) return "unsigned_refused";
  if (code === ERR_CHAIN_MISMATCH) return "chain_mismatch";
  return "other";
}

/** Pull Guard metadata from error.data when present. */
export function guardErrorData(err: unknown): Record<string, unknown> | undefined {
  const data = asError(err)?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return undefined;
}
