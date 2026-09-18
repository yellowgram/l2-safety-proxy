import type { Hex } from "viem";
import type { ChainConfig, SimResult } from "../types/index.js";
import { createRpcCaller, type RpcCaller } from "./rpcClient.js";
import { parseRawTransaction } from "./txParse.js";
import { simulateV1 } from "./ethSimulateV1.js";
import { recoverSender, simulateEthCall } from "./callFallback.js";

export interface SimulatorDeps {
  call?: RpcCaller;
  recover?: (raw: Hex) => Promise<Hex>;
}

/**
 * Simulate a raw signed tx against the chain's upstream RPC.
 * Prefer eth_simulateV1 when configured/available; else eth_call.
 */
export async function simulateRawTransaction(
  chain: ChainConfig,
  rawTx: Hex,
  deps: SimulatorDeps = {}
): Promise<SimResult> {
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

  if (chain.preferSimulateV1) {
    const v1 = await simulateV1(call, parsed, from);
    if (v1 !== null) return v1;
    // fall through to eth_call
  }

  return simulateEthCall(call, parsed, from);
}
