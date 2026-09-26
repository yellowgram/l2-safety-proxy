/**
 * Thin agent API: check(rawTx) → decision without broadcasting.
 * Founder-controlled / offline-friendly; no hosted SaaS surface.
 * When policy is provided/enabled, Layer 2 runs before simulation.
 */
import type { Hex } from "viem";
import type {
  Certainty,
  ChainConfig,
  GuardConfig,
  GuardDecision,
  MethodConfidence,
  SimResult,
} from "../types/index.js";
import { methodConfidence } from "../types/index.js";
import { simulateRawTransaction } from "../sim/simulator.js";
import { parseRawTransaction } from "../sim/txParse.js";
import { decodeRevertData } from "../decode/revert.js";
import {
  evaluateSpendPolicy,
  type SpendPolicyConfig,
} from "../policy/index.js";

/** Surface returned by check() — stable agent contract. */
export interface CheckResult {
  decision: GuardDecision;
  reason: string;
  certainty: Certainty;
  /** Simulation method provenance (simulate_v1 | eth_call | unknown) */
  simProvenance: MethodConfidence;
  /** 1 = simulation path; 2 = spend policy; null = chain mismatch (not a layer decision) */
  layer?: 1 | 2 | null;
  policyCode?: string;
}

export interface CheckOptions {
  /** Guard policy; default open (fail-open on uncertain). */
  guardMode?: "open" | "strict";
  /** Injected simulate (tests / offline loop). */
  simulate?: (chain: ChainConfig, rawTx: Hex) => Promise<SimResult>;
  /**
   * Optional Layer 2 policy. When enabled, evaluate before sim.
   * Prefer checkWithConfig so GuardConfig.policy is applied automatically.
   */
  policy?: SpendPolicyConfig;
  /** Chain key for per-chain policy overlay (defaults to chain.id). */
  chainKey?: string;
}

function decide(
  sim: SimResult,
  guardMode: "open" | "strict"
): { decision: GuardDecision; reason: string } {
  if (sim.ok) {
    return { decision: "forward", reason: "simulation succeeded" };
  }
  if (sim.confidence === "definite" && sim.code === "DEFINITE_REVERT") {
    const decoded = sim.rawData ? decodeRevertData(sim.rawData) : null;
    return {
      decision: "abort",
      reason: decoded?.reason ?? sim.reason,
    };
  }
  if (guardMode === "strict") {
    return {
      decision: "abort",
      reason: sim.reason,
    };
  }
  return { decision: "fail_open", reason: sim.reason };
}

/**
 * Simulate a signed raw tx and return the guard decision **without** forwarding.
 * Agents call this before eth_sendRawTransaction (or instead, for dry-run).
 * Layer 2 (if enabled on opts.policy) runs before simulation.
 */
export async function check(
  rawTx: Hex,
  chain: ChainConfig,
  opts: CheckOptions = {}
): Promise<CheckResult> {
  const guardMode = opts.guardMode ?? "open";
  const simulate = opts.simulate ?? simulateRawTransaction;
  const policy = opts.policy;
  const chainKey = opts.chainKey ?? chain.id;

  let parsed: ReturnType<typeof parseRawTransaction> | undefined;
  try {
    parsed = parseRawTransaction(rawTx);
  } catch {
    parsed = undefined;
  }

  if (parsed?.tx.chainId != null && parsed.tx.chainId !== chain.chainId) {
    return {
      decision: "chain_mismatch",
      reason: `signed chainId ${parsed.tx.chainId} does not match selected chain ${chain.chainId}`,
      certainty: "definite",
      simProvenance: "unknown",
      layer: null,
    };
  }

  if (policy?.enabled && parsed) {
    const result = evaluateSpendPolicy(policy, {
      chainKey,
      chainId: chain.chainId,
      to: parsed.to,
      value: parsed.value,
      data: parsed.data,
    });
    if (!result.allow) {
      return {
        decision: "policy_denied",
        reason: result.reason ?? "policy denied",
        certainty: "definite",
        simProvenance: "unknown",
        layer: 2,
        policyCode: result.code,
      };
    }
  }

  let sim: SimResult;
  try {
    sim = await simulate(chain, rawTx);
  } catch (err) {
    sim = {
      ok: false,
      method: "unavailable",
      confidence: "uncertain",
      reason: `simulation threw: ${err instanceof Error ? err.message : String(err)}`,
      code: "SIM_FAILURE",
    };
  }

  const { decision, reason } = decide(sim, guardMode);
  return {
    decision,
    reason,
    certainty: sim.confidence,
    simProvenance: methodConfidence(sim.method),
    layer: 1,
  };
}

/**
 * Convenience: resolve chain from a GuardConfig by key and run check().
 * Applies config.policy (Layer 2) automatically.
 */
export async function checkWithConfig(
  rawTx: Hex,
  config: GuardConfig,
  chainKey?: string,
  opts: CheckOptions = {}
): Promise<CheckResult> {
  const key = chainKey ?? config.defaultChain;
  const chain = config.chains[key];
  if (!chain) {
    return {
      decision: config.guardMode === "strict" ? "abort" : "fail_open",
      reason: `unknown chain '${key}'`,
      certainty: "uncertain",
      simProvenance: "unknown",
      layer: 1,
    };
  }
  return check(rawTx, chain, {
    ...opts,
    guardMode: opts.guardMode ?? config.guardMode,
    policy: opts.policy ?? config.policy,
    chainKey: key,
  });
}
