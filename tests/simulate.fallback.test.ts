import { describe, it, expect, beforeEach } from "vitest";
import { encodeErrorResult } from "viem";
import type { ChainConfig } from "../src/types/index.js";
import { simulateRawTransaction } from "../src/sim/simulator.js";
import { COMMON_ERRORS_ABI } from "../src/decode/revert.js";
import {
  clearSimulateV1CapabilityCache,
  isSimulateV1Unsupported,
} from "../src/sim/capabilityCache.js";
import { FAKE_RAW, FAKE_FROM } from "./fixtures.js";
import { handleRequest } from "../src/proxy/handler.js";
import type { GuardConfig } from "../src/types/index.js";
import { ERR_DEFINITE_REVERT } from "../src/types/index.js";
import { defaultSpendPolicy } from "../src/policy/index.js";

const baseChain = (over: Partial<ChainConfig> = {}): ChainConfig => ({
  id: "base-sepolia",
  name: "Base Sepolia",
  // FAKE_RAW is signed for Arb Sepolia. Handler tests reject a mismatch
  // before simulation, so this helper uses the signed chain id.
  chainId: 421614,
  upstreamRpcUrl: "http://primary-rpc",
  preferSimulateV1: true,
  ecosystem: "base",
  ...over,
});

function revertErr(message: string) {
  const data = encodeErrorResult({
    abi: COMMON_ERRORS_ABI,
    errorName: "Error",
    args: [message],
  });
  const err = new Error("execution reverted") as Error & {
    code?: number;
    data?: string;
  };
  err.code = 3;
  err.data = data;
  return err;
}

function unsupported32602() {
  const err = new Error("Invalid params") as Error & { code?: number };
  err.code = -32602;
  return err;
}

describe("eth_simulateV1 unsupported → eth_call fallback", () => {
  beforeEach(() => {
    clearSimulateV1CapabilityCache();
  });

  it("unsupported -32602 then eth_call definite revert → DEFINITE_REVERT", async () => {
    const methods: string[] = [];
    const call = async (method: string) => {
      methods.push(method);
      if (method === "eth_simulateV1") throw unsupported32602();
      if (method === "eth_call") throw revertErr("transfer failed");
      throw new Error("unexpected " + method);
    };
    const result = await simulateRawTransaction(baseChain(), FAKE_RAW, {
      call,
      recover: async () => FAKE_FROM,
      capabilityKey: "http://primary-rpc",
    });
    expect(methods).toEqual(["eth_simulateV1", "eth_call"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.method).toBe("eth_call");
      expect(result.confidence).toBe("definite");
      expect(result.code).toBe("DEFINITE_REVERT");
      expect(result.reason).toBe("transfer failed");
    }
    expect(isSimulateV1Unsupported("http://primary-rpc")).toBe(true);
  });

  it("unsupported -32602 + eth_call network fail → uncertain (fail-open candidate)", async () => {
    const call = async (method: string) => {
      if (method === "eth_simulateV1") throw unsupported32602();
      throw new Error("ECONNREFUSED upstream");
    };
    const result = await simulateRawTransaction(baseChain(), FAKE_RAW, {
      call,
      recover: async () => FAKE_FROM,
      capabilityKey: "http://primary-rpc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.method).toBe("eth_call");
      expect(result.confidence).toBe("uncertain");
      expect(result.code).toBe("SIM_FAILURE");
    }
  });

  it("caches -32602 and skips eth_simulateV1 on subsequent sims", async () => {
    const methods: string[] = [];
    const call = async (method: string) => {
      methods.push(method);
      if (method === "eth_simulateV1") throw unsupported32602();
      return "0x";
    };
    const deps = {
      call,
      recover: async () => FAKE_FROM,
      capabilityKey: "http://primary-rpc",
    };
    await simulateRawTransaction(baseChain(), FAKE_RAW, deps);
    methods.length = 0;
    const second = await simulateRawTransaction(baseChain(), FAKE_RAW, deps);
    expect(methods).toEqual(["eth_call"]);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.method).toBe("eth_call");
  });

  it("handler: unsupported V1 → eth_call revert → abort (no forward)", async () => {
    const methods: string[] = [];
    const call = async (method: string) => {
      methods.push(method);
      if (method === "eth_simulateV1") throw unsupported32602();
      if (method === "eth_call") throw revertErr("boom");
      throw new Error("unexpected");
    };
    const config: GuardConfig = {
      listenHost: "127.0.0.1",
      listenPort: 8545,
      guardMode: "open",
      failOpen: true,
    policy: defaultSpendPolicy(),
      defaultChain: "base-sepolia",
      chains: { "base-sepolia": baseChain() },
    };
    const forward = async () => {
      throw new Error("must not forward");
    };
    const res = await handleRequest(
      config,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [FAKE_RAW],
      },
      undefined,
      {
        simulate: (chain, raw) =>
          simulateRawTransaction(chain, raw, {
            call,
            recover: async () => FAKE_FROM,
            capabilityKey: chain.upstreamRpcUrl,
          }),
        forward,
      }
    );
    expect(methods).toEqual(["eth_simulateV1", "eth_call"]);
    expect(res.error?.code).toBe(ERR_DEFINITE_REVERT);
    expect(res.error?.data).toMatchObject({
      decision: "abort",
      confidence: "eth_call",
      certainty: "definite",
      aborted: true,
      simMethod: "eth_call",
    });
  });

  it("handler: unsupported V1 + eth_call fail → fail-open forward", async () => {
    const call = async (method: string) => {
      if (method === "eth_simulateV1") throw unsupported32602();
      throw new Error("ECONNREFUSED");
    };
    const config: GuardConfig = {
      listenHost: "127.0.0.1",
      listenPort: 8545,
      guardMode: "open",
      failOpen: true,
    policy: defaultSpendPolicy(),
      defaultChain: "base-sepolia",
      chains: { "base-sepolia": baseChain() },
    };
    let forwarded = false;
    const res = await handleRequest(
      config,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "eth_sendRawTransaction",
        params: [FAKE_RAW],
      },
      undefined,
      {
        simulate: (chain, raw) =>
          simulateRawTransaction(chain, raw, {
            call,
            recover: async () => FAKE_FROM,
            capabilityKey: chain.upstreamRpcUrl,
          }),
        forward: async () => {
          forwarded = true;
          return { jsonrpc: "2.0", id: 2, result: "0xforwarded" };
        },
      }
    );
    expect(forwarded).toBe(true);
    expect(res.result).toBe("0xforwarded");
    expect(res.error).toBeUndefined();
  });

  it("optional fallback RPC used when primary eth_call is uncertain", async () => {
    const primaryMethods: string[] = [];
    const fallbackMethods: string[] = [];
    const primary = async (method: string) => {
      primaryMethods.push(method);
      if (method === "eth_simulateV1") throw unsupported32602();
      throw new Error("ECONNREFUSED primary");
    };
    const fallback = async (method: string) => {
      fallbackMethods.push(method);
      if (method === "eth_simulateV1") {
        const err = new Error("method not found") as Error & { code?: number };
        err.code = -32601;
        throw err;
      }
      if (method === "eth_call") throw revertErr("from-fallback");
      throw new Error("unexpected");
    };
    const result = await simulateRawTransaction(
      baseChain({ fallbackRpcUrl: "http://fallback-rpc" }),
      FAKE_RAW,
      {
        call: primary,
        fallbackCall: fallback,
        recover: async () => FAKE_FROM,
        capabilityKey: "http://primary-rpc",
      }
    );
    expect(primaryMethods).toEqual(["eth_simulateV1", "eth_call"]);
    expect(fallbackMethods).toContain("eth_call");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.confidence).toBe("definite");
      expect(result.code).toBe("DEFINITE_REVERT");
      expect(result.reason).toBe("from-fallback");
    }
  });
});

describe("Arb Sepolia V1 shape reject → eth_call", () => {
  it("treats cannot unmarshal / simOpts as unsupported and falls back", async () => {
    const { clearSimulateV1CapabilityCache } = await import("../src/sim/capabilityCache.js");
    const { simulateRawTransaction } = await import("../src/sim/simulator.js");
    const { FAKE_RAW, FAKE_FROM } = await import("./fixtures.js");
    clearSimulateV1CapabilityCache();
    const chain = {
      id: "arb-sepolia",
      name: "Arbitrum Sepolia",
      chainId: 421614,
      upstreamRpcUrl: "http://arb",
      preferSimulateV1: true,
      ecosystem: "arbitrum" as const,
    };
    const methods: string[] = [];
    const call = async (method: string) => {
      methods.push(method);
      if (method === "eth_simulateV1") {
        const err = new Error(
          "json: cannot unmarshal array into Go value of type rpc.simOpts"
        ) as Error & { code?: number };
        err.code = -32000;
        throw err;
      }
      // eth_call definite revert
      const err = new Error("execution reverted") as Error & { data?: string };
      err.data = "0x";
      throw err;
    };
    const result = await simulateRawTransaction(chain, FAKE_RAW, {
      call,
      recover: async () => FAKE_FROM,
    });
    expect(methods).toEqual(["eth_simulateV1", "eth_call"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.confidence).toBe("definite");
      expect(result.method).toBe("eth_call");
      expect(result.code).toBe("DEFINITE_REVERT");
    }
  });
});
