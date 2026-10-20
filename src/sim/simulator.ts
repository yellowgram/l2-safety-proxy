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
import { isExecTransactionData } from "./safeExec.js";
import { inspectExecTransactionTrace } from "./debugTraceCall.js";
import { ethCallHonorsOverrides, planDelegation } from "./delegation.js";

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
 * 5. Safe execTransaction certainty lock (issue #17):
 *    - Simulated ExecutionFailure → hard abort
 *    - Outer success without log/trace inspection → uncertain (not definite forward)
 *    - debug_traceCall+callTracer optional for proof/copy; abort ≠ inner reason
 * 6. Uncertain results remain fail-open at the handler (never invent definite)
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

  // EIP-7702: simulate with the delegations the authorizations will install.
  const plan = await planDelegation(rawTx, chain.chainId, call);
  if (plan.kind === "uncertain") {
    return { ok: false, method: "unavailable", confidence: "uncertain", reason: plan.reason, code: "SIM_FAILURE" };
  }
  const delegated = plan.kind === "overrides" && Object.keys(plan.overrides).length > 0;
  if (plan.kind === "overrides") parsed.codeOverrides = plan.overrides;
  const ethCall = async (c: RpcCaller, key: string): Promise<SimResult> => {
    if (delegated && !(await ethCallHonorsOverrides(c, key))) {
      return {
        ok: false,
        method: "eth_call",
        confidence: "uncertain",
        reason: "7702 transaction: this RPC has no eth_simulateV1 and ignores eth_call state overrides, so the delegated code can't be simulated",
        code: "SIM_FAILURE",
      };
    }
    return simulateEthCall(c, parsed, from);
  };

  let result: SimResult;

  if (chain.preferSimulateV1 && !isSimulateV1Unsupported(primaryKey)) {
    const v1 = await simulateV1(call, parsed, from);
    if (v1 !== null) {
      result = v1;
    } else {
      // Unsupported for this upstream — cache and fall through to eth_call
      markSimulateV1Unsupported(primaryKey);
      result = await ethCall(call, primaryKey);
    }
  } else {
    result = await ethCall(call, primaryKey);
  }

  // Primary uncertain — optional alternate RPC for simulation only
  if (
    !result.ok &&
    result.confidence === "uncertain" &&
    chain.fallbackRpcUrl
  ) {
    const fallbackUrl = chain.fallbackRpcUrl;
    const fallbackCall = deps.fallbackCall ?? createRpcCaller(fallbackUrl);
    const fbKey = fallbackUrl;
    let fb: SimResult;
    if (chain.preferSimulateV1 && !isSimulateV1Unsupported(fbKey)) {
      const v1 = await simulateV1(fallbackCall, parsed, from);
      if (v1 !== null) {
        fb = v1;
      } else {
        markSimulateV1Unsupported(fbKey);
        fb = await ethCall(fallbackCall, fbKey);
      }
    } else {
      fb = await ethCall(fallbackCall, fbKey);
    }
    if (fb.ok || fb.confidence === "definite") {
      result = fb;
    } else {
      result = {
        ok: false,
        method: fb.method,
        confidence: "uncertain",
        reason: `primary sim uncertain (${result.reason}); fallback also failed (${fb.reason})`,
        code: "SIM_FAILURE",
        rawData: !fb.ok ? fb.rawData : undefined,
      };
    }
  }

  return applySafeExecCertainty(result, {
    call,
    parsed,
    from,
    capabilityKey: primaryKey,
  });
}

async function applySafeExecCertainty(
  result: SimResult,
  ctx: {
    call: RpcCaller;
    parsed: ReturnType<typeof parseRawTransaction>;
    from: Hex;
    capabilityKey: string;
  }
): Promise<SimResult> {
  if (!isExecTransactionData(ctx.parsed.data)) {
    return result;
  }

  // Definite revert / ExecutionFailure abort already decided — keep (GS013, bubbled, EF logs)
  if (!result.ok && result.confidence === "definite") {
    return result;
  }

  // Uncertain non-success stays uncertain
  if (!result.ok) {
    return result;
  }

  // Outer success path — require log or trace proof before definite forward
  if (result.logsInspected === true) {
    // V1 returned logs and they did not contain ExecutionFailure
    return result;
  }

  const traced = await inspectExecTransactionTrace(
    ctx.call,
    ctx.parsed,
    ctx.from,
    ctx.capabilityKey
  );

  if (traced.kind === "execution_failure") {
    return {
      ok: false,
      method: result.method,
      confidence: "definite",
      reason: traced.reason,
      code: "DEFINITE_REVERT",
      gasUsed: result.gasUsed,
    };
  }

  if (traced.kind === "clean") {
    return {
      ...result,
      logsInspected: true,
    };
  }

  // No log array and no usable trace → uncertain (an outer success may hide an inner Safe failure)
  return {
    ok: false,
    method: result.method,
    confidence: "uncertain",
    reason:
      "Safe execTransaction outer success without log/trace inspection " +
      `(${traced.reason}); treating as uncertain — not definite forward`,
    code: "SIM_FAILURE",
    gasUsed: result.gasUsed,
  };
}
