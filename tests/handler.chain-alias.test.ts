import { describe, it, expect, vi } from "vitest";
import { handleRequest } from "../src/proxy/handler.js";
import type { GuardConfig } from "../src/types/index.js";
import { defaultSpendPolicy } from "../src/policy/index.js";

const config = (): GuardConfig => ({
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
});

describe("numeric x-l2sg-chain alias (GFI #1)", () => {
  const cases: Array<[string, string]> = [
    ["84532", "http://upstream-base"],
    ["421614", "http://upstream-arb"],
    ["11155420", "http://upstream-op"],
  ];

  for (const [numeric, expectedUrl] of cases) {
    it(`routes x-l2sg-chain: ${numeric} to matching chain`, async () => {
      const forward = vi.fn(async (url: string) => ({
        jsonrpc: "2.0" as const,
        id: 1,
        result: url,
      }));
      const headers = new Headers({ "x-l2sg-chain": numeric });
      const res = await handleRequest(
        config(),
        { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        headers,
        { forward }
      );
      expect(res.result).toBe(expectedUrl);
    });
  }
});
