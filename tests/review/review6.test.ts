// LaunchGate re-review (2026-10-20): N-L2-1 (nested params smuggling) and N-L2-2 (reducing calls
// skipping the destination's selectors and maxNativeWei). RR-* names match the probes in
// lg-rereview-parts/probes_partA/l2/rr_probes.test.ts.
import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import { Guard } from "../../src/guard/guard.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { handleRequest } from "../../src/proxy/handler.js";
import { canonicalParams, isCanonicalizedMethod } from "../../src/proxy/canonical.js";
import { SEND_METHODS, WRAPPED_SEND_METHODS, type GuardConfig, type SimResult } from "../../src/types/index.js";
import { ALLOWED, ATTACKER, CHAIN, ETH, basePolicy, sign } from "../guard/helpers.js";

const okSim = vi.fn(async (): Promise<SimResult> => ({ ok: true, method: "simulate_v1", confidence: "definite", logsInspected: true }) as SimResult);
const cfg = (guard: Guard) =>
  ({ listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base", guard,
    chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } } }) as GuardConfig;
function capture() {
  const sent: unknown[] = [];
  const forward = vi.fn(async (_u: string, body: unknown) => {
    sent.push(JSON.parse(JSON.stringify(body)));
    return { jsonrpc: "2.0" as const, id: 1, result: "0xok" };
  });
  return { sent, forward };
}
const guard = () => new Guard({ policy: basePolicy(), store: new MemoryStore() });
const H = (b: string) => ("0x" + b.repeat(32)) as Hex;

/** Every object key anywhere in `v`. */
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}

describe("N-L2-1: gated methods forward params rebuilt from an exact-key allowlist", () => {
  it("RR-1a eth_sendBundle {txs:[GOOD], 'txſ':[EVIL]} is refused and nothing is forwarded", async () => {
    const good = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    const evil = await sign({ to: ATTACKER, value: ETH, nonce: 0 });
    const { sent, forward } = capture();
    const req = JSON.parse(`{"jsonrpc":"2.0","id":1,"method":"eth_sendBundle","params":[{"txs":["${good}"],"tx\\u017f":["${evil}"],"blockNumber":"0x1"}]}`);
    const r = await handleRequest(cfg(guard()), req, undefined, { simulate: okSim, forward });
    expect(r.error?.code).toBe(-32600);
    expect(sent).toHaveLength(0);
  });

  it("RR-1a': eth_sendBundle with an ASCII case variant of a known key ('TXS', 'Txs') is refused", async () => {
    const good = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    const evil = await sign({ to: ATTACKER, value: ETH, nonce: 0 });
    for (const k of ["Txs", "TXS"]) {
      const { sent, forward } = capture();
      const r = await handleRequest(cfg(guard()), { jsonrpc: "2.0", id: 1, method: "eth_sendBundle", params: [{ txs: [good], [k]: [evil], blockNumber: "0x1" }] } as never, undefined, { simulate: okSim, forward });
      expect(r.error?.code, k).toBeLessThan(-32000);
      expect(sent, k).toHaveLength(0);
    }
  });

  it("RR-1b mev_sendBundle item {bundle:{…}, Tx: EVIL} is refused and nothing is forwarded", async () => {
    const evil = await sign({ to: ATTACKER, value: ETH, nonce: 0 });
    const { sent, forward } = capture();
    const r = await handleRequest(cfg(guard()), { jsonrpc: "2.0", id: 1, method: "mev_sendBundle",
      params: [{ version: "v0.1", inclusion: { block: "0x1" }, body: [{ bundle: { version: "v0.1", inclusion: { block: "0x1" }, body: [] }, Tx: evil }] }] } as never,
      undefined, { simulate: okSim, forward });
    expect(r.error?.code).toBe(-32602);
    expect(r.error?.message).toMatch(/"Tx"/);
    expect(sent).toHaveLength(0);
  });

  it("RR-1c mev_sendBundle item {hash:H, TX: EVIL} is refused and nothing is forwarded", async () => {
    const evil = await sign({ to: ATTACKER, value: ETH, nonce: 0 });
    const { sent, forward } = capture();
    const r = await handleRequest(cfg(guard()), { jsonrpc: "2.0", id: 1, method: "mev_sendBundle",
      params: [{ version: "v0.1", inclusion: { block: "0x1" }, body: [{ hash: H("11"), TX: evil }, { hash: H("22") }] }] } as never,
      undefined, { simulate: okSim, forward });
    expect(r.error?.code).toBe(-32602);
    expect(sent).toHaveLength(0);
  });

  it("a duplicate case-folded key inside params is refused (eth_sendPrivateTransaction {tx, Tx})", async () => {
    const good = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    const evil = await sign({ to: ATTACKER, value: ETH, nonce: 0 });
    const { sent, forward } = capture();
    const r = await handleRequest(cfg(guard()), { jsonrpc: "2.0", id: 1, method: "eth_sendPrivateTransaction", params: [{ tx: good, Tx: evil }] } as never, undefined, { simulate: okSim, forward });
    expect(r.error).toBeDefined();
    expect(sent).toHaveLength(0);
  });

  it("a legitimate eth_sendBundle still forwards, with only allowlisted keys", async () => {
    const good = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    const { sent, forward } = capture();
    const r = await handleRequest(cfg(guard()), { jsonrpc: "2.0", id: 1, method: "eth_sendBundle",
      params: [{ txs: [good], blockNumber: "0x10", minTimestamp: 0, revertingTxHashes: [], replacementUuid: "a-b" }] } as never,
      undefined, { simulate: okSim, forward });
    expect(r.error).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect([...keysDeep((sent[0] as { params: unknown }).params)].sort()).toEqual(["blockNumber", "minTimestamp", "replacementUuid", "revertingTxHashes", "txs"]);
  });

  it("a legitimate nested mev_sendBundle still forwards, with only allowlisted keys", async () => {
    const good = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    const { sent, forward } = capture();
    const params = [{ version: "v0.1", inclusion: { block: "0x1", maxBlock: "0x5" },
      body: [{ hash: H("33") }, { tx: good, canRevert: false }, { bundle: { version: "v0.1", inclusion: { block: "0x1" }, body: [{ hash: H("44") }] } }],
      validity: { refund: [{ bodyIdx: 0, percent: 50 }] }, privacy: { hints: ["hash"], builders: ["flashbots"] } }];
    const r = await handleRequest(cfg(guard()), { jsonrpc: "2.0", id: 1, method: "mev_sendBundle", params } as never, undefined, { simulate: okSim, forward });
    expect(r.error).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect((sent[0] as { params: unknown }).params).toEqual(params);
    const allowed = new Set(["version", "inclusion", "block", "maxBlock", "body", "hash", "tx", "canRevert", "bundle", "validity", "refund", "bodyIdx", "percent", "privacy", "hints", "builders"]);
    for (const k of keysDeep((sent[0] as { params: unknown }).params)) expect(allowed.has(k), k).toBe(true);
  });

  it("every gated send method has an allowlist (no gated method forwards params verbatim)", () => {
    for (const m of [...SEND_METHODS, ...WRAPPED_SEND_METHODS]) expect(isCanonicalizedMethod(m), m).toBe(true);
  });

  it("unknown keys in eth_sendRawTransactionConditional options and extra positional params are refused", () => {
    expect("error" in canonicalParams("eth_sendRawTransactionConditional", ["0x01", { knownAccounts: {}, blockNumberMaX: "0x1" }])).toBe(true);
    expect("error" in canonicalParams("eth_sendRawTransaction", ["0x01", { extra: 1 }])).toBe(true);
    expect(canonicalParams("eth_sendRawTransactionConditional", ["0x01", { knownAccounts: { ["0x" + "ab".repeat(20)]: H("01") }, blockNumberMax: "0x9" }])).toEqual({
      params: ["0x01", { knownAccounts: { ["0x" + "ab".repeat(20)]: H("01") }, blockNumberMax: "0x9" }],
    });
  });

  it("a non-ASCII key anywhere in params is refused, for any method", async () => {
    const { sent, forward } = capture();
    const r = await handleRequest(cfg(guard()), JSON.parse(`{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x${"11".repeat(20)}","dat\\u0251":"0x"},"latest"]}`), undefined, { simulate: okSim, forward });
    expect(r.error?.code).toBe(-32600);
    expect(sent).toHaveLength(0);
  });
});

describe("N-L2-2: a reducing call to a listed destination keeps that destination's limits", () => {
  const a0 = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [ATTACKER, 0n] });
  const judge = async (p: ReturnType<typeof basePolicy>, tx: Parameters<typeof sign>[0]) =>
    evaluateTx(p, await parseSignedTx(await sign(tx)), { chainId: CHAIN, now: 1_000_000 });

  it("RR-7a a destination with selectors [deposit()] does not accept approve(x,0)", async () => {
    const p = basePolicy({ destinations: { [ALLOWED]: { selectors: ["deposit()"] } } });
    const v = await judge(p, { to: ALLOWED, data: a0 });
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.code).toBe("SELECTOR_NOT_ALLOWED");
  });

  it("RR-7b a destination with maxNativeWei 0.01 ETH does not accept 0.05 ETH carried on approve(x,0)", async () => {
    const p = basePolicy({ destinations: { [ALLOWED]: { maxNativeWei: (ETH / 100n).toString() } } });
    const v = await judge(p, { to: ALLOWED, value: ETH / 20n, data: a0 });
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.code).toBe("OVER_CAP");
  });

  it("control: approve(x,0) to a destination with no selector list and no value is still allowed", async () => {
    const p = basePolicy({ destinations: { [ALLOWED]: {} } });
    expect((await judge(p, { to: ALLOWED, data: a0 })).allow).toBe(true);
  });
});
