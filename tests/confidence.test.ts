import { describe, it, expect, beforeEach } from "vitest";
import { clearSimulateV1CapabilityCache } from "../src/sim/capabilityCache.js";
import type { ChainConfig, SimResult } from "../src/types/index.js";
import { simulateRawTransaction } from "../src/sim/simulator.js";
import { encodeErrorResult } from "viem";
import { COMMON_ERRORS_ABI } from "../src/decode/revert.js";
import { FAKE_RAW, FAKE_FROM } from "./fixtures.js";

const chain: ChainConfig = {
  id: "test",
  name: "Test",
  chainId: 1,
  upstreamRpcUrl: "http://localhost:0",
  preferSimulateV1: false,
  ecosystem: "other",
};

describe("confidence classification via simulator deps", () => {
  beforeEach(() => {
    clearSimulateV1CapabilityCache();
  });

  it("marks eth_call revert with data as definite", async () => {
    const revertData = encodeErrorResult({
      abi: COMMON_ERRORS_ABI,
      errorName: "Error",
      args: ["boom"],
    });
    const call = async () => {
      const err = new Error("execution reverted") as Error & { data?: string };
      err.data = revertData;
      throw err;
    };
    const result = await simulateRawTransaction(chain, FAKE_RAW, {
      call,
      recover: async () => FAKE_FROM,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.confidence).toBe("definite");
      expect(result.code).toBe("DEFINITE_REVERT");
      expect(result.reason).toBe("boom");
    }
  });

  it("marks network/sim failure as uncertain", async () => {
    const call = async () => {
      throw new Error("ECONNREFUSED upstream");
    };
    const result = await simulateRawTransaction(chain, FAKE_RAW, {
      call,
      recover: async () => FAKE_FROM,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.confidence).toBe("uncertain");
      expect(result.code).toBe("SIM_FAILURE");
    }
  });

  it("marks parse failure as uncertain", async () => {
    const result = await simulateRawTransaction(chain, "0xdead" as `0x${string}`, {
      call: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.confidence).toBe("uncertain");
      expect(result.code).toBe("SIM_FAILURE");
    }
  });

  it("prefers eth_simulateV1 when available", async () => {
    const chainV1: ChainConfig = { ...chain, preferSimulateV1: true };
    const methods: string[] = [];
    const call = async (method: string) => {
      methods.push(method);
      if (method === "eth_simulateV1") {
        return [
          {
            calls: [{ status: "0x1", returnData: "0x", gasUsed: "0x5208" }],
          },
        ];
      }
      throw new Error("unexpected " + method);
    };
    const result: SimResult = await simulateRawTransaction(
      chainV1,
      FAKE_RAW,
      {
        call,
        recover: async () => FAKE_FROM,
      }
    );
    expect(methods[0]).toBe("eth_simulateV1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe("eth_simulateV1");
      expect(result.confidence).toBe("definite");
    }
  });

  it("falls back to eth_call when eth_simulateV1 unsupported", async () => {
    const chainV1: ChainConfig = { ...chain, preferSimulateV1: true };
    const methods: string[] = [];
    const call = async (method: string) => {
      methods.push(method);
      if (method === "eth_simulateV1") {
        const err = new Error("method not found") as Error & { code?: number };
        err.code = -32601;
        throw err;
      }
      return "0x";
    };
    const result = await simulateRawTransaction(chainV1, FAKE_RAW, {
      call,
      recover: async () => FAKE_FROM,
    });
    expect(methods).toEqual(["eth_simulateV1", "eth_call"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.method).toBe("eth_call");
  });
});
