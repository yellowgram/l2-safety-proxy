import { describe, it, expect, afterEach } from "vitest";
import {
  CHAIN_TEMPLATES,
  PUBLIC_RPC_DEFAULTS,
} from "../src/config/chains.js";
import { loadConfig } from "../src/config/env.js";

const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of Object.keys(saved)) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
});

function stash(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("chain templates + loadConfig", () => {
  it("defines OP Sepolia alongside Arb + Base templates", () => {
    expect(CHAIN_TEMPLATES["op-sepolia"]).toMatchObject({
      id: "op-sepolia",
      name: "OP Sepolia",
      chainId: 11155420,
      ecosystem: "op-stack",
      preferSimulateV1: true,
    });
    expect(CHAIN_TEMPLATES["arb-sepolia"]?.chainId).toBe(421614);
    expect(CHAIN_TEMPLATES["base-sepolia"]?.chainId).toBe(84532);
    expect(PUBLIC_RPC_DEFAULTS["op-sepolia"]).toMatch(/optimism/i);
  });

  it("defaults L2SG_CHAINS to arb + op + base Sepolia", () => {
    stash({
      L2SG_CHAINS: undefined,
      L2SG_DEFAULT_CHAIN: undefined,
    });
    const cfg = loadConfig();
    expect(Object.keys(cfg.chains).sort()).toEqual([
      "arb-sepolia",
      "base-sepolia",
      "op-sepolia",
    ]);
    expect(cfg.defaultChain).toBe("arb-sepolia");
    expect(cfg.chains["op-sepolia"]?.upstreamRpcUrl).toBeTruthy();
    expect(cfg.chains["op-sepolia"]?.chainId).toBe(11155420);
    expect(cfg.failOpen).toBe(true);
  });

  it("can enable only OP Sepolia via env", () => {
    stash({
      L2SG_CHAINS: "op-sepolia",
      L2SG_DEFAULT_CHAIN: "op-sepolia",
    });
    const cfg = loadConfig();
    expect(Object.keys(cfg.chains)).toEqual(["op-sepolia"]);
    expect(cfg.chains["op-sepolia"]?.ecosystem).toBe("op-stack");
  });
});
