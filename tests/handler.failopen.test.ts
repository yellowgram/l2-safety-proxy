import { describe, it, expect, vi } from "vitest";
import { handleRequest } from "../src/proxy/handler.js";
import type { GuardConfig, SimResult } from "../src/types/index.js";
import { ERR_DEFINITE_REVERT } from "../src/types/index.js";
import { FAKE_RAW as RAW } from "./fixtures.js";

const baseConfig = (): GuardConfig => ({
  listenHost: "127.0.0.1",
  listenPort: 8545,
  failOpen: true,
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

describe("handleRequest fail-open / abort", () => {
  it("aborts definite revert and does NOT forward", async () => {
    const forward = vi.fn();
    const simulate = async (): Promise<SimResult> => ({
      ok: false,
      method: "eth_call",
      confidence: "definite",
      reason: "insufficient balance",
      code: "DEFINITE_REVERT",
    });
    const res = await handleRequest(
      baseConfig(),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      { simulate, forward }
    );
    expect(forward).not.toHaveBeenCalled();
    expect(res.error?.code).toBe(ERR_DEFINITE_REVERT);
    expect(res.error?.data).toMatchObject({
      confidence: "definite",
      aborted: true,
      reason: "insufficient balance",
    });
  });

  it("fail-opens on uncertain sim failure (forwards upstream)", async () => {
    const forward = vi.fn(async () => ({
      jsonrpc: "2.0" as const,
      id: 2,
      result: "0xdeadbeef",
    }));
    const simulate = async (): Promise<SimResult> => ({
      ok: false,
      method: "eth_call",
      confidence: "uncertain",
      reason: "ECONNREFUSED",
      code: "SIM_FAILURE",
    });
    const res = await handleRequest(
      baseConfig(),
      {
        jsonrpc: "2.0",
        id: 2,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      { simulate, forward }
    );
    expect(forward).toHaveBeenCalledOnce();
    expect(res.result).toBe("0xdeadbeef");
    expect(res.error).toBeUndefined();
  });

  it("fail-opens when simulate throws", async () => {
    const forward = vi.fn(async () => ({
      jsonrpc: "2.0" as const,
      id: 3,
      result: "0xforwarded",
    }));
    const simulate = async (): Promise<SimResult> => {
      throw new Error("unexpected boom");
    };
    const res = await handleRequest(
      baseConfig(),
      {
        jsonrpc: "2.0",
        id: 3,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      { simulate, forward }
    );
    expect(forward).toHaveBeenCalledOnce();
    expect(res.result).toBe("0xforwarded");
  });

  it("forwards non-send methods without simulating", async () => {
    const simulate = vi.fn();
    const forward = vi.fn(async () => ({
      jsonrpc: "2.0" as const,
      id: 4,
      result: "0x64",
    }));
    const res = await handleRequest(
      baseConfig(),
      { jsonrpc: "2.0", id: 4, method: "eth_blockNumber", params: [] },
      undefined,
      { simulate, forward }
    );
    expect(simulate).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledOnce();
    expect(res.result).toBe("0x64");
  });

  it("routes by x-l2sg-chain header to Base Sepolia", async () => {
    const forward = vi.fn(async (url: string) => ({
      jsonrpc: "2.0" as const,
      id: 5,
      result: url,
    }));
    const headers = new Headers({ "x-l2sg-chain": "base-sepolia" });
    const res = await handleRequest(
      baseConfig(),
      { jsonrpc: "2.0", id: 5, method: "eth_chainId", params: [] },
      headers,
      { forward }
    );
    expect(res.result).toBe("http://upstream-base");
  });

  it("when failOpen=false, surfaces uncertain errors instead of forwarding", async () => {
    const cfg = baseConfig();
    cfg.failOpen = false;
    const forward = vi.fn();
    const simulate = async (): Promise<SimResult> => ({
      ok: false,
      method: "unavailable",
      confidence: "uncertain",
      reason: "stale",
      code: "SIM_FAILURE",
    });
    const res = await handleRequest(
      cfg,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      { simulate, forward }
    );
    expect(forward).not.toHaveBeenCalled();
    expect(res.error?.message).toMatch(/SIM_FAILURE/);
  });

  it("forwards successful simulation", async () => {
    const forward = vi.fn(async () => ({
      jsonrpc: "2.0" as const,
      id: 7,
      result: "0xtxhash",
    }));
    const simulate = async (): Promise<SimResult> => ({
      ok: true,
      method: "eth_simulateV1",
      confidence: "definite",
    });
    const res = await handleRequest(
      baseConfig(),
      {
        jsonrpc: "2.0",
        id: 7,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      { simulate, forward }
    );
    expect(forward).toHaveBeenCalledOnce();
    expect(res.result).toBe("0xtxhash");
  });
});
