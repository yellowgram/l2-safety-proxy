/** Confidence that a simulation result reflects on-chain truth. */
export type Confidence = "definite" | "uncertain";

/** How the simulation was performed. */
export type SimMethod =
  | "eth_simulateV1"
  | "eth_call"
  | "unavailable";

export interface SimSuccess {
  ok: true;
  method: SimMethod;
  confidence: Confidence;
  gasUsed?: bigint;
}

export interface SimRevert {
  ok: false;
  method: SimMethod;
  confidence: Confidence;
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
  /** Fail-open: forward send when sim is uncertain or fails */
  failOpen: boolean;
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
}

/** Methods that submit signed txs — intercepted for simulation. */
export const SEND_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_sendRawTransactionSync",
]);

/**
 * Unsigned send methods — refused (no key custody).
 * Agents/wallets must sign externally and use eth_sendRawTransaction.
 */
export const UNSIGNED_SEND_METHODS = new Set([
  "eth_sendTransaction",
]);

/** Custom error code: definite revert blocked by L2 Send Guard */
export const ERR_DEFINITE_REVERT = -32080;

/** Custom error code: unsigned send refused (use raw + external signer) */
export const ERR_UNSIGNED_SEND_REFUSED = -32081;
