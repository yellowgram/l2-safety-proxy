import { describe, expect, it } from "vitest";
import { encodeAbiParameters, pad, type Address, type Hex } from "viem";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { TOPICS, classifyLog, looksLike, maySpend, reclassify, scanOnce, trustedAddresses } from "../../src/guard/receive/index.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import { AGENT, CHAIN, PERMIT2, RECIPIENT, SPENDER_BAD, SPENDER_OK, TOKEN, basePolicy, sign } from "./helpers.js";

const t = (a: string) => pad(a as Hex, { size: 32 });
const u256 = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
// Same first and last 4 hex chars as RECIPIENT (0x6666…6666), different middle.
const LOOKALIKE = "0x6666000000000000000000000000000000006666" as Address;

function log(topics: Hex[], data: Hex, address: Address = TOKEN, i = 0) {
  return { address, topics, data, transactionHash: `0x${"ab".repeat(32)}` as Hex, logIndex: i, blockNumber: 1 };
}
const rules = (p = basePolicy()) => ({ agents: new Set([AGENT]), trusted: trustedAddresses(p) });

describe("inbound classification", () => {
  it("lookalike sender is toxic and named as a poisoner", () => {
    expect(looksLike(LOOKALIKE, RECIPIENT)).toBe(true);
    const f = classifyLog(log([TOPICS.Transfer, t(LOOKALIKE), t(AGENT)], u256(1n)), basePolicy(), rules(), CHAIN);
    expect(f).toMatchObject({ kind: "inbound", poisoner: LOOKALIKE.toLowerCase(), asset: { label: "toxic" } });
  });
  it("zero-value 'transfer from the agent' to a lookalike marks the lookalike", () => {
    const f = classifyLog(log([TOPICS.Transfer, t(AGENT), t(LOOKALIKE)], u256(0n), "0x9876000000000000000000000000000000000000"), basePolicy(), rules(), CHAIN);
    expect(f).toMatchObject({ kind: "inbound", poisoner: LOOKALIKE.toLowerCase() });
  });
  it("unknown token is quarantined; known token from a normal sender is clear", () => {
    const p = basePolicy();
    const a = classifyLog(log([TOPICS.Transfer, t(SPENDER_OK), t(AGENT)], u256(5n), "0x9876000000000000000000000000000000000000"), p, rules(p), CHAIN);
    const b = classifyLog(log([TOPICS.Transfer, t(SPENDER_OK), t(AGENT)], u256(5n)), p, rules(p), CHAIN);
    expect(a).toMatchObject({ asset: { label: "quarantine", reasons: ["unknown_token"] } });
    expect(b).toMatchObject({ asset: { label: "clear" } });
  });
});

describe("approval watch", () => {
  it("flags effectively-unlimited approvals (>= 2^128), not only 2^256-1, and emits unsigned revoke calldata", () => {
    const f = classifyLog(log([TOPICS.Approval, t(AGENT), t(SPENDER_OK)], u256(1n << 200n)), basePolicy(), rules(), CHAIN);
    expect(f).toMatchObject({ kind: "approval", expected: false, unlimited: true });
    expect(f?.kind === "approval" && f.revoke.data.startsWith("0x095ea7b3")).toBe(true);
  });
  it("accepts approvals the policy would allow", () => {
    const f = classifyLog(log([TOPICS.Approval, t(AGENT), t(SPENDER_OK)], u256(10n)), basePolicy(), rules(), CHAIN);
    expect(f).toMatchObject({ expected: true });
  });
  it("watches Permit2 Approval events and offers a lockdown", () => {
    const data = encodeAbiParameters([{ type: "uint160" }, { type: "uint48" }], [5n, 0]);
    const f = classifyLog(log([TOPICS.Permit2Approval, t(AGENT), t(TOKEN), t(SPENDER_BAD)], data, PERMIT2), basePolicy(), rules(), CHAIN);
    expect(f).toMatchObject({ kind: "approval", expected: false });
    expect(f?.kind === "approval" && f.revoke.to.toLowerCase()).toBe(PERMIT2.toLowerCase());
  });
});

describe("scanOnce joins the receive side to the send side", () => {
  it("records assets, marks the poisoner (sends to it are then refused) and locks on a rogue approval", async () => {
    const store = new MemoryStore();
    const p = basePolicy();
    const logs = [
      log([TOPICS.Transfer, t(LOOKALIKE), t(AGENT)], u256(1n), TOKEN, 0),
      log([TOPICS.Approval, t(AGENT), t(SPENDER_BAD)], u256(1n << 255n), TOKEN, 1),
    ];
    const provider = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_blockNumber") return "0x10";
        const q = params![0] as { topics: unknown[] };
        const first = q.topics[0];
        return logs.filter((l) => (Array.isArray(first) ? first.includes(l.topics[0]) : l.topics[0] === first));
      },
    };
    const findings: unknown[] = [];
    const head = await scanOnce({ provider, store, policy: p, chainId: CHAIN, agents: [AGENT], startBlock: 0n, onFinding: (f) => void findings.push(f) });
    expect(head).toBe(14n);
    expect(await store.getCursor(`watch:${CHAIN}:${AGENT}`)).toBe("14");
    expect(await store.poisoned()).toContain(LOOKALIKE.toLowerCase());
    expect((await store.senderState(CHAIN, AGENT)).locked).toBeDefined();
    const v = evaluateTx(p, await parseSignedTx(await sign({ to: LOOKALIKE, value: 1n })), { chainId: CHAIN, poisoned: await store.poisoned() });
    expect(v.code).toBe("POISONED_ADDRESS");
    const assetKey = `${CHAIN}:0x${"ab".repeat(32)}:0`;
    expect((await maySpend(store, assetKey)).allow).toBe(false);
    await reclassify(store, assetKey, "clear", "checked: it's our own test transfer");
    expect((await maySpend(store, assetKey)).allow).toBe(true);
  });
});
