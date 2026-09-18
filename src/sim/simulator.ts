import type { Hex } from "viem";
import type { ChainConfig, SimResult } from "../types/index.js";
import { createRpcCaller, type RpcCaller } from "./rpcClient.js";
import { parseRawTransaction } from "./txParse.js";
import { simulateV1 } from "./ethSimulateV1.js";
import { recoverSender, simulateEthCall } from "./callFallback.js";
import {
  isSimulateV1Unsupported,
  markSimulateV1Unsupported,
} from "./capabilityCache.js";

export interface SimulatorDeps {
  call?: RpcCaller;
  /** Optional second caller used when chain.fallbackRpcUrl is set and primary sim is uncertain. */
  fallbackCall?: RpcCaller;
  recover?: (raw: Hex) => Promise<Hex>;
  /** Override capability-cache key (defaults to chain.upstreamRpcUrl). */
  capabilityKey?: string;
}

/**
 * Simulate a raw signed tx against the chain's upstream RPC.
 *
 * Order:
 * 1. Prefer eth_simulateV1 when configured and not capability-cached as unsupported
 * 2. On unsupported (-32601 / -32602 / …) → mark cache, fall through to eth_call
 * 3. eth_call on primary (definite revert / success / uncertain)
 * 4. If primary eth_call is uncertain AND fallbackRpcUrl is configured → retry eth_call there
 * 5. Uncertain results remain fail-open at the handler (never invent definite)
 */
export async function simulateRawTransaction(
  chain: ChainConfig,
  rawTx: Hex,
  deps: SimulatorDeps = {}
): Promise<SimResult> {
  const primaryKey = deps.capabilityKey ?? chain.upstreamRpcUrl;
  const call = deps.call ?? createRpcCaller(chain.upstreamRpcUrl);
  const recover = deps.recover ?? recoverSender;

  let parsed;
  try {
    parsed = parseRawTransaction(rawTx);
  } catch (err) {
    return {
      ok: false,
      method: "unavailable",
      confidence: "uncertain",
      reason: `failed to parse raw tx: ${err instanceof Error ? err.message : String(err)}`,
      code: "SIM_FAILURE",
    };
  }

  let from: Hex;
  try {
    from = await recover(rawTx);
  } catch (err) {
    return {
      ok: false,
      method: "unavailable",
      confidence: "uncertain",
      reason: `failed to recover sender: ${err instanceof Error ? err.message : String(err)}`,
      code: "SIM_FAILURE",
    };
  }

  if (chain.preferSimulateV1 && !isSimulateV1Unsupported(primaryKey)) {
    const v1 = await simulateV1(call, parsed, from);
    if (v1 !== null) return v1;
    // Unsupported for this upstream — cache and fall through to eth_call
    markSimulateV1Unsupported(primaryKey);
  }

  const primary = await simulateEthCall(call, parsed, from);
  if (primary.ok || primary.confidence === "definite") {
    return primary;
  }

  // Primary eth_call uncertain — optional alternate RPC for simulation only
  const fallbackUrl = chain.fallbackRpcUrl;
  if (fallbackUrl) {
    const fallbackCall =
      deps.fallbackCall ?? createRpcCaller(fallbackUrl);
    const fbKey = fallbackUrl;
    if (chain.preferSimulateV1 && !isSimulateV1Unsupported(fbKey)) {
      const v1 = await simulateV1(fallbackCall, parsed, from);
      if (v1 !== null) return v1;
      markSimulateV1Unsupported(fbKey);
    }
    const fb = await simulateEthCall(fallbackCall, parsed, from);
    // Prefer definite (abort or success) from fallback; else keep primary uncertain
    if (fb.ok || fb.confidence === "definite") {
      return fb;
    }
    return {
      ok: false,
      method: fb.method,
      confidence: "uncertain",
      reason: `primary sim uncertain (${primary.reason}); fallback also failed (${fb.reason})`,
      code: "SIM_FAILURE",
      rawData: !fb.ok ? fb.rawData : undefined,
    };
  }

  return primary;
}
