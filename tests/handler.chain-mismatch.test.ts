import { describe, it, expect, vi } from "vitest";
import { handleRequest } from "../src/proxy/handler.js";
import { defaultSpendPolicy } from "../src/policy/index.js";
import type { GuardConfig } from "../src/types/index.js";
import { ERR_CHAIN_MISMATCH } from "../src/types/index.js";
import { FAKE_RAW as RAW } from "./fixtures.js";

function config(): GuardConfig {
  return {
    listenHost: "127.0.0.1",
    listenPort: 8545,
    guardMode: "open",
    failOpen: true,
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
      "op-sepolia": {
        id: "op-sepolia",
        name: "OP Sepolia",
        chainId: 11155420,
        upstreamRpcUrl: "http://upstream-op",
        preferSimulateV1: true,
        ecosystem: "op-stack",
      },
      "base-sepolia": {
        id: "base-sepolia",
        name: "Base Sepolia",
        chainId: 84532,
        upstreamRpcUrl: "http://upstream-base",
        preferSimulateV1: true,
        ecosystem: "base",
      },
    },
  };
}

describe("signed chainId vs x-l2sg-chain", () => {
  it("denies when the header selects a different chain than the signed tx", async () => {
    const simulate = vi.fn();
    const forward = vi.fn();
    const res = await handleRequest(
      config(),
      { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [RAW] },
      new Headers({ "x-l2sg-chain": "op-sepolia" }),
      { simulate, forward }
    );
    expect(simulate).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    expect(res.error?.code).toBe(ERR_CHAIN_MISMATCH);
    expect(res.error?.data).toMatchObject({
      decision: "chain_mismatch",
      chainId: 11155420,
      signedChainId: 421614,
      layer: null,
      policyCode: null,
      failOpen: false,
    });
  });

  it("numeric header 84532 also mismatches an Arb-signed raw", async () => {
    const forward = vi.fn();
    const res = await handleRequest(
      config(),
      { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: [RAW] },
      new Headers({ "x-l2sg-chain": "84532" }),
      { forward, simulate: vi.fn() }
    );
    expect(forward).not.toHaveBeenCalled();
    expect(res.error?.code).toBe(ERR_CHAIN_MISMATCH);
    expect((res.error?.data as { chainId?: number }).chainId).toBe(84532);
  });

  it("matching header still reaches simulation", async () => {
    const simulate = vi.fn(async () => ({
      ok: true as const,
      method: "eth_call" as const,
      confidence: "definite" as const,
    }));
    const forward = vi.fn(async () => ({
      jsonrpc: "2.0" as const,
      id: 3,
      result: "0xok",
    }));
    const res = await handleRequest(
      config(),
      { jsonrpc: "2.0", id: 3, method: "eth_sendRawTransaction", params: [RAW] },
      new Headers({ "x-l2sg-chain": "421614" }),
      { simulate, forward }
    );
    expect(simulate).toHaveBeenCalled();
    expect(res.result).toBe("0xok");
  });
});
