import { describe, it, expect, vi } from "vitest";
import { handleRequest } from "../src/proxy/handler.js";
import type { GuardConfig, SimResult } from "../src/types/index.js";
import {
  ERR_DEFINITE_REVERT,
  ERR_STRICT_UNCERTAIN,
  methodConfidence,
} from "../src/types/index.js";
import { FAKE_RAW as RAW } from "./fixtures.js";
import { defaultSpendPolicy } from "../src/policy/index.js";

const base = (mode: "open" | "strict"): GuardConfig => ({
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
});

describe("methodConfidence mapping", () => {
  it("maps sim methods to response confidence labels", () => {
    expect(methodConfidence("eth_simulateV1")).toBe("simulate_v1");
    expect(methodConfidence("eth_call")).toBe("eth_call");
    expect(methodConfidence("unavailable")).toBe("unknown");
  });
});

describe("GUARD_MODE open vs strict", () => {
  it("open: uncertain sim → fail_open forward with metadata", async () => {
    const forward = vi.fn(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: "0xforwarded",
    }));
    const simulate = async (): Promise<SimResult> => ({
      ok: false,
      method: "unavailable",
      confidence: "uncertain",
      reason: "ECONNREFUSED",
      code: "SIM_FAILURE",
    });
    const res = await handleRequest(
      base("open"),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      { simulate, forward }
    );
    expect(forward).toHaveBeenCalledOnce();
    expect(res.result).toBe("0xforwarded");
    expect(res.l2sg).toMatchObject({
      decision: "fail_open",
      confidence: "unknown",
      certainty: "uncertain",
      chainId: 421614,
      failOpen: true,
      aborted: false,
    });
  });

  it("strict: uncertain sim → abort (no forward)", async () => {
    const forward = vi.fn();
    const simulate = async (): Promise<SimResult> => ({
      ok: false,
      method: "unavailable",
      confidence: "uncertain",
      reason: "sim missing",
      code: "SIM_FAILURE",
    });
    const res = await handleRequest(
      base("strict"),
      {
        jsonrpc: "2.0",
        id: 2,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      { simulate, forward }
    );
    expect(forward).not.toHaveBeenCalled();
    expect(res.error?.code).toBe(ERR_STRICT_UNCERTAIN);
    expect(res.error?.data).toMatchObject({
      decision: "abort",
      confidence: "unknown",
      certainty: "uncertain",
      chainId: 421614,
      aborted: true,
    });
  });

  it("both modes: definite revert → abort with eth_call confidence + decoded", async () => {
    const forward = vi.fn();
    const simulate = async (): Promise<SimResult> => ({
      ok: false,
      method: "eth_call",
      confidence: "definite",
      reason: "execution reverted: nope",
      rawData: "0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000046e6f706500000000000000000000000000000000000000000000000000000000",
      code: "DEFINITE_REVERT",
    });
    for (const mode of ["open", "strict"] as const) {
      const res = await handleRequest(
        base(mode),
        {
          jsonrpc: "2.0",
          id: 3,
          method: "eth_sendRawTransaction",
          params: [RAW],
        },
        undefined,
        { simulate, forward }
      );
      expect(res.error?.code).toBe(ERR_DEFINITE_REVERT);
      expect(res.error?.data).toMatchObject({
        decision: "abort",
        confidence: "eth_call",
        certainty: "definite",
        chainId: 421614,
        aborted: true,
      });
      const data = res.error?.data as { decoded?: { reason: string } };
      expect(data.decoded?.reason).toMatch(/nope/i);
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it("forward success includes decision + simulate_v1 confidence", async () => {
    const forward = vi.fn(async () => ({
      jsonrpc: "2.0" as const,
      id: 4,
      result: "0x" + "ab".repeat(32),
    }));
    const simulate = async (): Promise<SimResult> => ({
      ok: true,
      method: "eth_simulateV1",
      confidence: "definite",
    });
    const res = await handleRequest(
      base("open"),
      {
        jsonrpc: "2.0",
        id: 4,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      { simulate, forward }
    );
    expect(res.result).toMatch(/^0xab/);
    expect(res.l2sg).toMatchObject({
      decision: "forward",
      confidence: "simulate_v1",
      certainty: "definite",
      chainId: 421614,
    });
  });

  it("strict: simulate throw → abort with unknown confidence", async () => {
    const forward = vi.fn();
    const simulate = async (): Promise<SimResult> => {
      throw new Error("boom");
    };
    const res = await handleRequest(
      base("strict"),
      {
        jsonrpc: "2.0",
        id: 5,
        method: "eth_sendRawTransaction",
        params: [RAW],
      },
      undefined,
      { simulate, forward }
    );
    expect(forward).not.toHaveBeenCalled();
    expect(res.error?.data).toMatchObject({
      decision: "abort",
      confidence: "unknown",
      certainty: "uncertain",
      chainId: 421614,
    });
  });
});
