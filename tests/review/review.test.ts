// Regression tests for the 2026-10-19 independent review (one test per finding).
import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseAbi, serializeTransaction, type Address, type Hex } from "viem";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { parsePolicy } from "../../src/guard/policy/load.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import { Guard } from "../../src/guard/guard.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { handleRequest } from "../../src/proxy/handler.js";
import type { GuardConfig, SimResult } from "../../src/types/index.js";
import { ALLOWED, ATTACKER, CHAIN, ETH, ROUTER, TOKEN, RECIPIENT, SPENDER_OK, agent, basePolicy, sign } from "../guard/helpers.js";

const mc = (items: Hex[]) => encodeFunctionData({ abi: parseAbi(["function multicall(bytes[] data)"]), args: [items] });
const exec1 = (t: Address, v: bigint, d: Hex) => encodeFunctionData({ abi: parseAbi(["function execute(address target,uint256 value,bytes data)"]), args: [t, v, d] });
const decAllow = encodeFunctionData({ abi: parseAbi(["function decreaseAllowance(address,uint256)"]), args: [ATTACKER, 1n] });
const approve0 = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [ATTACKER, 0n] });
const deposit = "0xd0e30db0" as Hex; // deposit()

async function judge(policy: ReturnType<typeof basePolicy>, tx: Parameters<typeof sign>[0]) {
  return evaluateTx(policy, await parseSignedTx(await sign(tx)), { chainId: CHAIN, now: 1_000_000 });
}

describe("review: evaluate", () => {
  it("PROBE-1 per-destination maxNativeWei holds when the call is wrapped in the destination's own multicall", async () => {
    const p = basePolicy({ destinations: { [ROUTER]: { maxNativeWei: (ETH / 100n).toString(), selectors: ["deposit()", "multicall(bytes[])"] } } });
    // plain call over the per-destination cap: denied (control)
    expect((await judge(p, { to: ROUTER, value: ETH / 20n, data: deposit })).allow).toBe(false);
    // same value, same router, same inner call, wrapped in multicall(bytes[])
    const v = await judge(p, { to: ROUTER, value: ETH / 20n, data: mc([deposit]) });
    expect(v.allow).toBe(false);
  });
  it("PROBE-2 destination selectors hold when the destination exposes a wrapper-shaped function", async () => {
    const p = basePolicy({ destinations: { [ALLOWED]: { selectors: ["deposit()"] } } });
    const v = await judge(p, { to: ALLOWED, value: 0n, data: exec1(agent.address, 0n, "0x") });
    expect(v.allow).toBe(false);
  });
  it("PROBE-3 a call to a non-allowlisted contract is denied even with a 'reducing' token selector", async () => {
    const p = basePolicy();
    const a = await judge(p, { to: ATTACKER, data: decAllow });
    const b = await judge(p, { to: ATTACKER, data: approve0 });
    expect([a.allow, b.allow]).toEqual([false, false]);
  });
  it("PROBE-4 a pre-EIP-155 (no chainId) legacy tx is refused: it is replayable on every chain", async () => {
    const raw = await agent.signTransaction({ type: "legacy", nonce: 0, to: ALLOWED, value: 1n, gas: 21000n, gasPrice: 1n } as never);
    const tx = await parseSignedTx(raw);
    expect(tx.chainId).toBeUndefined();
    const g = new Guard({ policy: basePolicy(), store: new MemoryStore() });
    const c = await g.check(raw, { chainId: CHAIN });
    expect(c.action).toBe("deny");
  });
});

function cfg(guard: Guard): GuardConfig {
  return {
    listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base",
    guard,
    chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } },
  } as GuardConfig;
}
const okSim = vi.fn(async (): Promise<SimResult> => ({ ok: true, method: "simulate_v1", confidence: "definite", logsInspected: true } as SimResult));

describe("review: proxy", () => {
  it("PROBE-5 the body forwarded upstream carries only the keys the guard judged (no case-variant Params/Method smuggling)", async () => {
    const g = new Guard({ policy: basePolicy(), store: new MemoryStore() });
    const good = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    const evil = await sign({ to: ATTACKER, value: ETH, nonce: 0 });
    let sent: unknown;
    const forward = vi.fn(async (_u: string, body: unknown) => { sent = JSON.parse(JSON.stringify(body)); return { jsonrpc: "2.0" as const, id: 1, result: "0xok" }; });
    const req = JSON.parse(`{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["${good}"],"Params":["${evil}"]}`);
    const res = await handleRequest(cfg(g), req, undefined, { simulate: okSim, forward });
    // Either refuse, or forward a body with no extra keys.
    if (!res.error) expect(Object.keys(sent as object).sort()).toEqual(["id", "jsonrpc", "method", "params"]);
  });
  it("PROBE-5b a pass-through method cannot carry a case-variant Method key upstream", async () => {
    const g = new Guard({ policy: basePolicy(), store: new MemoryStore() });
    const evil = await sign({ to: ATTACKER, value: ETH, nonce: 0 });
    let sent: unknown;
    const forward = vi.fn(async (_u: string, body: unknown) => { sent = JSON.parse(JSON.stringify(body)); return { jsonrpc: "2.0" as const, id: 1, result: "0x1" }; });
    const req = JSON.parse(`{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":["${evil}"],"Method":"eth_sendRawTransaction"}`);
    const res = await handleRequest(cfg(g), req, undefined, { simulate: okSim, forward });
    if (!res.error) expect(Object.keys(sent as object).sort()).toEqual(["id", "jsonrpc", "method", "params"]);
  });
  it("PROBE-6 eth_sendRawTransactionSync timeout (code 4: in mempool) does not release caps or free the key", async () => {
    const store = new MemoryStore();
    const g = new Guard({ policy: basePolicy(), store, detectBypass: false });
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, error: { code: 4, message: "The transaction was added to the mempool but wasn't processed within the designated timeout interval.", data: "0x" } }));
    let landed = 0;
    for (let n = 0; n < 10; n++) {
      const raw = await sign({ to: ALLOWED, value: ETH / 10n, nonce: n });
      const res = await handleRequest(cfg(g), { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransactionSync", params: [raw, 1] }, undefined, { simulate: okSim, forward });
      if (forward.mock.calls.length > landed) landed = forward.mock.calls.length;
      void res;
    }
    // window is 0.5 ETH: at most 5 x 0.1 ETH may reach the mempool
    expect(landed).toBeLessThanOrEqual(5);
  });
  it("PROBE-6b same: Idempotency-Key is not freed by a code-4 timeout", async () => {
    const g = new Guard({ policy: basePolicy(), store: new MemoryStore(), detectBypass: false });
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, error: { code: 4, message: "timeout", data: "0x" } }));
    const h = new Headers({ "idempotency-key": "pay-42" });
    await handleRequest(cfg(g), { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransactionSync", params: [await sign({ to: RECIPIENT === RECIPIENT ? ALLOWED : ALLOWED, value: 1n, nonce: 0 })] }, h, { simulate: okSim, forward });
    const second = await handleRequest(cfg(g), { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: [await sign({ to: ALLOWED, value: 2n, nonce: 1 })] }, h, { simulate: okSim, forward });
    expect(second.error?.code).toBe(-32087);
  });
  it("PROBE-7 mev_sendBundle item with both tx (0X-prefixed) and hash is not treated as someone else's hash", async () => {
    const g = new Guard({ policy: basePolicy(), store: new MemoryStore() });
    const evil = await sign({ to: ATTACKER, value: ETH, nonce: 0 });
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: { bundleHash: "0x" } }));
    const res = await handleRequest(cfg(g), { jsonrpc: "2.0", id: 1, method: "mev_sendBundle", params: [{ version: "v0.1", inclusion: { block: "0x1" }, body: [{ tx: "0X" + evil.slice(2), hash: "0x" + "11".repeat(32) }] }] }, undefined, { simulate: okSim, forward });
    expect(forward).not.toHaveBeenCalled();
    void res;
  });
});
