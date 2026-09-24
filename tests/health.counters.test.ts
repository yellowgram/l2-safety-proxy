import { describe, it, expect, beforeEach } from "vitest";
import http from "node:http";
import { createServer } from "../src/proxy/server.js";
import { handleRequest } from "../src/proxy/handler.js";
import {
  getDecisionCounters,
  resetDecisionCounters,
} from "../src/proxy/counters.js";
import { defaultSpendPolicy } from "../src/policy/index.js";
import type { GuardConfig, SimResult } from "../src/types/index.js";
import { FAKE_RAW as RAW } from "./fixtures.js";
import { ERR_DEFINITE_REVERT, ERR_POLICY_DENIED } from "../src/types/index.js";

function baseConfig(policy = defaultSpendPolicy()): GuardConfig {
  return {
    listenHost: "127.0.0.1",
    listenPort: 0,
    guardMode: "open",
    failOpen: true,
    policy,
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

describe("health policy summary + decision counters", () => {
  beforeEach(() => {
    resetDecisionCounters();
  });

  it("/health includes policy summary without addresses and zero counters", async () => {
    const policy = defaultSpendPolicy();
    policy.enabled = true;
    policy.destinations = new Map([
      ["0x1111111111111111111111111111111111111111", {}],
      ["0x2222222222222222222222222222222222222222", {}],
    ]);
    const config = baseConfig(policy);
    const server = createServer(config);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.policy.enabled).toBe(true);
    expect(body.policy.destinationCount).toBe(2);
    expect(JSON.stringify(body)).not.toMatch(/0x11111111/i);
    expect(body.decisions.totalSendDecisions).toBe(0);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("records abort and policy_denied counters", async () => {
    const config = baseConfig();
    const definite: SimResult = {
      ok: false,
      method: "eth_call",
      confidence: "definite",
      reason: "boom",
      code: "DEFINITE_REVERT",
    };
    const abortRes = await handleRequest(
      config,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      {
        simulate: async () => definite,
        forward: async () => {
          throw new Error("should not forward");
        },
      }
    );
    expect(abortRes.error?.code).toBe(ERR_DEFINITE_REVERT);
    expect(getDecisionCounters().abort).toBe(1);

    const pol = defaultSpendPolicy();
    pol.enabled = true;
    pol.destinations = new Map([
      ["0x1111111111111111111111111111111111111111", {}],
    ]);
    const denyRes = await handleRequest(
      baseConfig(pol),
      {
        jsonrpc: "2.0",
        id: 2,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      {
        simulate: async () => ({
          ok: true,
          method: "eth_call",
          confidence: "definite",
        }),
        forward: async () => {
          throw new Error("should not forward");
        },
      }
    );
    expect(denyRes.error?.code).toBe(ERR_POLICY_DENIED);
    const c = getDecisionCounters();
    expect(c.policy_denied).toBe(1);
    expect(c.abort).toBe(1);
    expect(c.totalSendDecisions).toBe(2);
  });
});
