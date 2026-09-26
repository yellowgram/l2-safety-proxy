import { describe, it, expect, vi } from "vitest";
import { handleRequest } from "../src/proxy/handler.js";
import { defaultSpendPolicy } from "../src/policy/index.js";
import type { GuardConfig, GuardResponseMeta, SimResult } from "../src/types/index.js";
import {
  ERR_DEFINITE_REVERT,
  ERR_POLICY_DENIED,
  ERR_STRICT_UNCERTAIN,
  ERR_UNSIGNED_SEND_REFUSED,
} from "../src/types/index.js";
import { FAKE_RAW as RAW } from "./fixtures.js";

function config(mode: "open" | "strict" = "open"): GuardConfig {
  return {
    listenHost: "127.0.0.1",
    listenPort: 8545,
    guardMode: mode,
    failOpen: mode === "open",
    policy: defaultSpendPolicy(),
    defaultChain: "arb-sepolia",
    chains: {
      "arb-sepolia": {
        id: "arb-sepolia",
        name: "Arbitrum Sepolia",
        chainId: 421614,
        upstreamRpcUrl: "http://upstream-arb",
        preferSimulateV1: true,
        ecosystem: "arbitrum",
      },
    },
  };
}

function dataOf(res: { error?: { data?: unknown } }): GuardResponseMeta {
  return res.error?.data as GuardResponseMeta;
}

describe("golden error.data shape", () => {
  it("-32080 definite revert abort", async () => {
    const sim: SimResult = {
      ok: false,
      method: "eth_call",
      confidence: "definite",
      reason: "boom",
      code: "DEFINITE_REVERT",
    };
    const res = await handleRequest(
      config(),
      { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [RAW] },
      undefined,
      { simulate: async () => sim, forward: vi.fn() }
    );
    expect(res.error?.code).toBe(ERR_DEFINITE_REVERT);
    expect(dataOf(res)).toMatchObject({
      decision: "abort",
      certainty: "definite",
      confidence: "eth_call",
      chainId: 421614,
      layer: 1,
      policyCode: null,
    });
  });

  it("-32081 unsigned send refused", async () => {
    const res = await handleRequest(
      config(),
      { jsonrpc: "2.0", id: 2, method: "eth_sendTransaction", params: [{}] },
      undefined,
      { simulate: vi.fn(), forward: vi.fn() }
    );
    expect(res.error?.code).toBe(ERR_UNSIGNED_SEND_REFUSED);
    expect(dataOf(res)).toMatchObject({
      decision: "unsigned_refused",
      certainty: "definite",
      confidence: "unknown",
      chainId: 421614,
      layer: null,
      policyCode: null,
    });
  });

  it("-32082 strict uncertain abort", async () => {
    const sim: SimResult = {
      ok: false,
      method: "unavailable",
      confidence: "uncertain",
      reason: "sim missing",
      code: "SIM_FAILURE",
    };
    const res = await handleRequest(
      config("strict"),
      { jsonrpc: "2.0", id: 3, method: "eth_sendRawTransaction", params: [RAW] },
      undefined,
      { simulate: async () => sim, forward: vi.fn() }
    );
    expect(res.error?.code).toBe(ERR_STRICT_UNCERTAIN);
    expect(dataOf(res)).toMatchObject({
      decision: "abort",
      certainty: "uncertain",
      confidence: "unknown",
      chainId: 421614,
      layer: 1,
      policyCode: null,
    });
  });

  it("-32083 policy denied", async () => {
    const cfg = config();
    cfg.policy = defaultSpendPolicy();
    cfg.policy.enabled = true;
    cfg.policy.destinations = new Map();
    const simulate = vi.fn();
    const forward = vi.fn();
    const res = await handleRequest(
      cfg,
      { jsonrpc: "2.0", id: 4, method: "eth_sendRawTransaction", params: [RAW] },
      undefined,
      { simulate, forward }
    );
    expect(simulate).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    expect(res.error?.code).toBe(ERR_POLICY_DENIED);
    const data = dataOf(res);
    expect(data).toMatchObject({
      decision: "policy_denied",
      certainty: "definite",
      confidence: "unknown",
      chainId: 421614,
      layer: 2,
    });
    expect(typeof data.policyCode).toBe("string");
    expect(data.policyCode).toBe("DESTINATION_NOT_ALLOWLISTED");
  });
});
