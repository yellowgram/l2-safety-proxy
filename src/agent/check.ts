/**
 * Thin agent API: check(rawTx) → decision without broadcasting.
 * Founder-controlled / offline-friendly; no hosted SaaS surface.
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
import { decodeRevertData } from "../decode/revert.js";

/** Surface returned by check() — stable agent contract. */
export interface CheckResult {
  decision: GuardDecision;
  reason: string;
  certainty: Certainty;
  /** Simulation method provenance (simulate_v1 | eth_call | unknown) */
  simProvenance: MethodConfidence;
}

export interface CheckOptions {
  /** Guard policy; default open (fail-open on uncertain). */
  guardMode?: "open" | "strict";
  /** Injected simulate (tests / offline loop). */
  simulate?: (chain: ChainConfig, rawTx: Hex) => Promise<SimResult>;
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
      reason: sim.reason || "strict: uncertain / missing sim",
    };
  }
  return {
    decision: "fail_open",
    reason: sim.reason || "uncertain simulation — fail-open",
  };
}

/**
 * Simulate a signed raw tx and return the guard decision **without** forwarding.
 * Agents call this before eth_sendRawTransaction (or instead, for dry-run).
 */
export async function check(
  rawTx: Hex,
  chain: ChainConfig,
  opts: CheckOptions = {}
): Promise<CheckResult> {
  const guardMode = opts.guardMode ?? "open";
  const simulate = opts.simulate ?? simulateRawTransaction;

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
  };
}

/**
 * Convenience: resolve chain from a GuardConfig by key and run check().
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
    };
  }
  return check(rawTx, chain, {
    ...opts,
    guardMode: opts.guardMode ?? config.guardMode,
  });
}
