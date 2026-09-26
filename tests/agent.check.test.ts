import { describe, it, expect, vi } from "vitest";
import type { Hex } from "viem";
import { check, checkWithConfig } from "../src/agent/check.js";
import type { ChainConfig, GuardConfig, SimResult } from "../src/types/index.js";
import { defaultSpendPolicy } from "../src/policy/index.js";

const RAW =
  "0x02f86d83066eee80843b9aca00843b9aca008252089400000000000000000000000000000000000000018080c001a07eade7c743ff2ea60f61c687ccca4b77553a14de08378371ac40c7d52a8f1d74a06fed4faa592ac84bae32b9311844176fc059eb70057c18450d4310072a880629" as Hex;

const chain: ChainConfig = {
  id: "arb-sepolia",
  name: "Arbitrum Sepolia",
  chainId: 421614,
  upstreamRpcUrl: "http://test",
  preferSimulateV1: true,
  ecosystem: "arbitrum",
};

function shapeKeys(r: Record<string, unknown>) {
  return Object.keys(r).sort();
}

describe("agent check()", () => {
  it("returns { decision, reason, certainty, simProvenance } on definite abort", async () => {
    const sim: SimResult = {
      ok: false,
      method: "eth_call",
      confidence: "definite",
      reason: "execution reverted",
      code: "DEFINITE_REVERT",
      rawData:
        "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b6576616c2d726576657274000000000000000000000000000000000000000000",
    };
    const r = await check(RAW, chain, {
      simulate: async () => sim,
    });
    expect(shapeKeys(r as unknown as Record<string, unknown>)).toEqual(
      ["certainty", "decision", "layer", "reason", "simProvenance"].sort()
    );
    expect(r.decision).toBe("abort");
    expect(r.certainty).toBe("definite");
    expect(r.simProvenance).toBe("eth_call");
    expect(typeof r.reason).toBe("string");
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it("returns forward on sim success", async () => {
    const r = await check(RAW, chain, {
      simulate: async () => ({
        ok: true,
        method: "eth_simulateV1",
        confidence: "definite",
      }),
    });
    expect(r.decision).toBe("forward");
    expect(r.certainty).toBe("definite");
    expect(r.simProvenance).toBe("simulate_v1");
    expect(r.reason).toMatch(/succeed/i);
  });

  it("fail_open on uncertain in open mode", async () => {
    const r = await check(RAW, chain, {
      guardMode: "open",
      simulate: async () => ({
        ok: false,
        method: "eth_call",
        confidence: "uncertain",
        reason: "node glitch",
        code: "UNCERTAIN_REVERT",
      }),
    });
    expect(r.decision).toBe("fail_open");
    expect(r.certainty).toBe("uncertain");
    expect(r.simProvenance).toBe("eth_call");
  });

  it("abort on uncertain in strict mode", async () => {
    const r = await check(RAW, chain, {
      guardMode: "strict",
      simulate: async () => ({
        ok: false,
        method: "unavailable",
        confidence: "uncertain",
        reason: "sim missing",
        code: "SIM_FAILURE",
      }),
    });
    expect(r.decision).toBe("abort");
    expect(r.certainty).toBe("uncertain");
    expect(r.simProvenance).toBe("unknown");
  });

  it("checkWithConfig resolves chain and shape", async () => {
    const config: GuardConfig = {
      listenHost: "127.0.0.1",
      listenPort: 8545,
      defaultChain: "arb-sepolia",
      guardMode: "open",
      failOpen: true,
    policy: defaultSpendPolicy(),
      chains: { "arb-sepolia": chain },
    };
    const r = await checkWithConfig(RAW, config, "arb-sepolia", {
      simulate: async () => ({
        ok: true,
        method: "eth_call",
        confidence: "definite",
      }),
    });
    expect(r.decision).toBe("forward");
    expect(shapeKeys(r as unknown as Record<string, unknown>)).toEqual(
      ["certainty", "decision", "layer", "reason", "simProvenance"].sort()
    );
  });
});

describe("check() Layer 2 policy", () => {
  it("checkWithConfig returns policy_denied without simulating", async () => {
    const policy = defaultSpendPolicy();
    policy.enabled = true;
    policy.destinations = new Map(); // deny-all
    const config: GuardConfig = {
      listenHost: "127.0.0.1",
      listenPort: 8545,
      defaultChain: "arb-sepolia",
      guardMode: "open",
      failOpen: true,
      policy,
      chains: { "arb-sepolia": chain },
    };
    const simulate = vi.fn();
    const r = await checkWithConfig(RAW, config, "arb-sepolia", { simulate });
    expect(r.decision).toBe("policy_denied");
    expect(r.layer).toBe(2);
    expect(simulate).not.toHaveBeenCalled();
  });

  it("signed chainId mismatch does not simulate", async () => {
    const base: ChainConfig = {
      ...chain,
      id: "base-sepolia",
      name: "Base Sepolia",
      chainId: 84532,
      ecosystem: "base",
    };
    const simulate = vi.fn();
    const r = await check(RAW, base, { simulate });
    expect(r.decision).toBe("chain_mismatch");
    expect(r.layer).toBeNull();
    expect(simulate).not.toHaveBeenCalled();
  });
});
