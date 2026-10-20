import type { Guard } from "../guard/guard.js";
import type { Policy } from "../guard/policy/types.js";
/** Certainty that a simulation result reflects on-chain truth. */
export type Certainty = "definite" | "uncertain";

/** @deprecated Use Certainty — kept as alias for older imports. */
export type Confidence = Certainty;

/**
 * Provenance of the simulation used for a send decision.
 * Surface name in abort / fail_open / forward responses.
 */
export type MethodConfidence = "simulate_v1" | "eth_call" | "unknown";

/** How the simulation was performed (internal). */
export type SimMethod =
  | "eth_simulateV1"
  | "eth_call"
  | "unavailable";

/** Guard policy: open = fail-open on uncertain; strict = abort on uncertain. */
export type GuardMode = "open" | "strict";

/** Decision taken by the guard for a send. */
export type GuardDecision =
  | "abort"
  | "fail_open"
  | "forward"
  | "policy_denied"
  | "chain_mismatch"
  | "unsigned_refused"
  | "idempotency_conflict"
  | "bypass_locked";

export interface SimSuccess {
  ok: true;
  method: SimMethod;
  confidence: Certainty;
  gasUsed?: bigint;
  /**
   * eth_simulateV1 returned a logs array that was scanned for Safe
   * ExecutionFailure. Absent/false means log proof was not available.
   */
  logsInspected?: boolean;
}

export interface SimRevert {
  ok: false;
  method: SimMethod;
  confidence: Certainty;
  reason: string;
  rawData?: `0x${string}`;
  gasUsed?: bigint;
  /** Short machine-readable code for clients */
  code: "DEFINITE_REVERT" | "UNCERTAIN_REVERT" | "SIM_FAILURE";
}

export type SimResult = SimSuccess | SimRevert;

export interface ChainConfig {
  id: string;
  name: string;
  chainId: number;
  /** Upstream JSON-RPC URL (user's existing RPC — we sit in front) */
  upstreamRpcUrl: string;
  /**
   * Optional alternate RPC used only for simulation when primary eth_call
   * is uncertain (e.g. a node that supports eth_simulateV1 / richer eth_call).
   * Send forwarding always uses upstreamRpcUrl.
   */
  fallbackRpcUrl?: string;
  /** Prefer eth_simulateV1 when the node advertises it */
  preferSimulateV1: boolean;
  /** Ecosystem tag for multi-L2 differentiation */
  ecosystem: "arbitrum" | "op-stack" | "base" | "other";
}

export interface GuardConfig {
  listenHost: string;
  listenPort: number;
  chains: Record<string, ChainConfig>;
  /** Default chain key when request has no x-l2sg-chain header */
  defaultChain: string;
  /**
   * strict = abort when the simulation is missing or uncertain (default);
   * open = forward anyway (fail-open) and say so in the response.
   */
  guardMode: GuardMode;
  /** Derived: true iff guardMode === "open". Kept for callers/tests. */
  failOpen: boolean;
  /**
   * The send policy, caps, idempotency and bypass detection. Absent only when the
   * operator chose simulation-only mode (L2SG_POLICY=off).
   */
  guard?: Guard;
  /** Where the policy came from ("off" = simulation only), for the banner and /health. */
  policySource?: string;
  /** What loadConfig read; createGuardFromConfig turns it into `guard`. */
  guardSpec?: GuardSpec;
  /**
   * Append-only JSONL of send decisions. Unset = do not write.
   * One JSON object per line: decision, code, chain, method, policyCode, path.
   */
  decisionLogPath?: string;
}

/** Guard metadata attached to every send abort / fail_open / forward. */
export interface GuardResponseMeta {
  l2SendGuard: true;
  decision: GuardDecision;
  /** Simulation method provenance */
  confidence: MethodConfidence;
  /** definite | uncertain */
  certainty: Certainty;
  chainId: number;
  simMethod: SimMethod;
  /** Present when a revert was decoded */
  decoded?: {
    reason: string;
    kind?: string;
    selector?: string;
  };
  reason?: string;
  code?: string;
  rawData?: `0x${string}`;
  aborted?: boolean;
  failOpen?: boolean;
  /** 1 = simulation, 2 = spend policy, null = not a layer decision */
  layer?: 1 | 2 | null;
  /** Machine policy code, or null when this decision is not a policy deny. */
  policyCode?: string | null;
  /** Signed tx chain id when it disagreed with the selected chain. */
  signedChainId?: number;
  to?: `0x${string}`;
  value?: `0x${string}`;
  hint?: string;
  /** Where in a nested call the policy rule fired, e.g. tx>aggregate3[1]. */
  path?: string;
  /** On an idempotency conflict: the transaction already sent under this key. */
  priorTxHash?: string;
  /** In a bundle: which transaction was denied. */
  index?: number;
  /** Identical bytes were already sent under this Idempotency-Key; re-sending them is harmless. */
  replay?: boolean;
  /** How the guard read the transaction, e.g. a Universal Router calldata tag it stripped before decoding. */
  notes?: string[];
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown[];
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
  /** Non-standard extension: send-guard metadata on forward / fail_open success */
  l2sg?: GuardResponseMeta;
}

/** Methods that submit signed txs — intercepted for simulation. */
/** Methods whose first param is one signed raw tx. */
export const SEND_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_sendRawTransactionSync",
  "eth_sendRawTransactionConditional",
  "eth_sendPrivateRawTransaction",
]);

/** Methods that carry signed txs in another shape; see extractSignedTxs. */
export const WRAPPED_SEND_METHODS = new Set([
  "eth_sendPrivateTransaction",
  "eth_sendBundle",
  "mev_sendBundle",
]);

/** Anything that looks like a submit and isn't one of the above is refused. */
export const SUBMIT_LIKE = /^[a-z0-9]+_(send|submit|broadcast|relay)/i;

/**
 * Unsigned send methods — refused (no key custody).
 * Agents/wallets must sign externally and use eth_sendRawTransaction.
 */
/** The guard holds no keys: anything asking the node to sign is refused (-32081). */
export const UNSIGNED_SEND_METHODS = new Set([
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "wallet_sendCalls",
]);

/** Custom error code: definite revert blocked by L2 Send Guard */
export const ERR_DEFINITE_REVERT = -32080;

/** Custom error code: unsigned send refused (use raw + external signer) */
export const ERR_UNSIGNED_SEND_REFUSED = -32081;

/** Custom error code: strict-mode abort on uncertain / missing sim */
export const ERR_STRICT_UNCERTAIN = -32082;

/** Custom error code: Layer 2 address/spend policy denied (definite stop, not fail-open) */
export const ERR_POLICY_DENIED = -32083;

/**
 * Signed tx chainId disagrees with the chain selected by x-l2sg-chain
 * (or the default chain). Not forwarded. Not a policy deny and not a sim abort.
 */
export const ERR_CHAIN_MISMATCH = -32084;

/** Idempotency key reused for a different transaction, or the state store is down. */
export const ERR_IDEMPOTENCY = -32087;

/** A transaction from this sender landed without passing the guard; sends are locked. */
export const ERR_BYPASS_LOCKED = -32088;

/** Map internal SimMethod → response confidence provenance. */
export function methodConfidence(method: SimMethod): MethodConfidence {
  if (method === "eth_simulateV1") return "simulate_v1";
  if (method === "eth_call") return "eth_call";
  return "unknown";
}

export interface GuardSpec {
  policy: Policy;
  store: { kind: "memory" } | { kind: "file"; path: string } | { kind: "postgres"; url: string };
  idempotencyTtlSeconds: number;
  /** lock = refuse further sends from a sender after a bypass (default); alert = log only. */
  bypass: "lock" | "alert" | "off";
  alertWebhook?: string;
  /** Receive-side watch (L2SG_WATCH_AGENTS). Off when unset. */
  watch?: { agents: string[]; expectedSenders: string[]; dustRaw: bigint; intervalSeconds: number };
}
