import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { Guard, type ChainReader } from "../../src/guard/guard.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { handleRequest } from "../../src/proxy/handler.js";
import type { GuardConfig, SimResult } from "../../src/types/index.js";
import { ALLOWED, CHAIN, ETH, basePolicy, sign } from "../guard/helpers.js";

class FakeChain implements ChainReader { nonce = 0; known = new Set<string>(); async getNonce() { return this.nonce; } async hasTransaction(h: Hex) { return this.known.has(h); } }
function cfg(guard: Guard): GuardConfig {
  return { listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base", guard,
    chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } } } as GuardConfig;
}
const okSim = vi.fn(async (): Promise<SimResult> => ({ ok: true, method: "simulate_v1", confidence: "definite", logsInspected: true } as SimResult));

describe("caps and nonces", () => {
  it("PROBE-8 rebroadcasting an already-mined tx (nonce too low) must not erase its record and false-lock the sender", async () => {
    const chain = new FakeChain();
    const g = new Guard({ policy: basePolicy(), store: new MemoryStore(), readers: new Map([[CHAIN, chain]]) });
    const raw0 = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    let reply: unknown = { jsonrpc: "2.0", id: 1, result: "0xh" };
    const forward = vi.fn(async () => reply as never);
    const r1 = await handleRequest(cfg(g), { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw0] }, undefined, { simulate: okSim, forward });
    expect(r1.error).toBeUndefined();
    chain.nonce = 1; // mined
    reply = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nonce too low: next nonce 1, tx nonce 0" } };
    await handleRequest(cfg(g), { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: [raw0] }, undefined, { simulate: okSim, forward });
    reply = { jsonrpc: "2.0", id: 1, result: "0xh2" };
    const r3 = await handleRequest(cfg(g), { jsonrpc: "2.0", id: 3, method: "eth_sendRawTransaction", params: [await sign({ to: ALLOWED, value: 1n, nonce: 1 })] }, undefined, { simulate: okSim, forward });
    expect(r3.error?.code).not.toBe(-32088);
  });
  it("PROBE-9 window cap is per sender (docs) — not multiplied by the number of chains in the policy", async () => {
    const p = basePolicy({ chains: [CHAIN, 10] });
    const g = new Guard({ policy: p, store: new MemoryStore() });
    let ok = 0;
    for (let n = 0; n < 5; n++) if ((await g.check(await sign({ to: ALLOWED, value: ETH / 10n, nonce: n, chainId: CHAIN }), { chainId: CHAIN })).action === "forward") ok++;
    for (let n = 0; n < 5; n++) if ((await g.check(await sign({ to: ALLOWED, value: ETH / 10n, nonce: n, chainId: 10 }), { chainId: 10 })).action === "forward") ok++;
    expect(ok).toBeLessThanOrEqual(5); // 0.5 ETH window
  });
});
