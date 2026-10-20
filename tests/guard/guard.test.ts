import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { Guard, classifyUpstream, type ChainReader } from "../../src/guard/guard.js";
import { createGuardedSigner, GuardDenied } from "../../src/guard/signer.js";
import { FileStore } from "../../src/guard/store/file.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { ALLOWED, AGENT, CHAIN, ETH, PERMIT2, SPENDER_BAD, SPENDER_OK, TOKEN, agent, basePolicy, sign } from "./helpers.js";

class FakeChain implements ChainReader {
  nonce = 0;
  known = new Set<string>();
  async getNonce() {
    return this.nonce;
  }
  async hasTransaction(h: Hex) {
    return this.known.has(h);
  }
}

function setup(opts: { store?: MemoryStore; chain?: FakeChain; t?: { now: number } } = {}) {
  const store = opts.store ?? new MemoryStore();
  const chain = opts.chain ?? new FakeChain();
  const t = opts.t ?? { now: 1_000_000 };
  const guard = new Guard({ policy: basePolicy(), store, readers: new Map([[CHAIN, chain]]), now: () => t.now });
  return { guard, store, chain, t };
}

/** Check, then pretend the upstream accepted it and the chain mined it. */
async function sendOk(g: ReturnType<typeof setup>, raw: Hex, key?: string) {
  const c = await g.guard.check(raw, { chainId: CHAIN, idempotencyKey: key });
  if (c.action === "forward") {
    await g.guard.settle(c, "accepted");
    if (!c.replay) g.chain.nonce++;
    g.chain.known.add(keccak256(raw));
  }
  return c;
}

describe("rolling caps (audit 1b)", () => {
  it("twenty 0.1 ETH sends under a 0.5 ETH/hour window: only five go out", async () => {
    const g = setup();
    let forwarded = 0;
    for (let n = 0; n < 20; n++) {
      const c = await sendOk(g, await sign({ to: ALLOWED, value: ETH / 10n, nonce: n }));
      if (c.action === "forward") forwarded++;
      else expect(c.code).toBe("WINDOW_CAP_EXCEEDED");
    }
    expect(forwarded).toBe(5);
  });
  it("the window rolls, and a definite upstream rejection gives the budget back", async () => {
    const g = setup();
    for (let n = 0; n < 5; n++) await sendOk(g, await sign({ to: ALLOWED, value: ETH / 10n, nonce: n }));
    const c = await g.guard.check(await sign({ to: ALLOWED, value: ETH / 10n, nonce: 5 }), { chainId: CHAIN });
    expect(c.action).toBe("deny");
    g.t.now += 3601;
    const d = await g.guard.check(await sign({ to: ALLOWED, value: ETH / 10n, nonce: 5 }), { chainId: CHAIN });
    expect(d.action).toBe("forward");
    if (d.action === "forward") await g.guard.settle(d, "rejected");
    const e = await g.guard.check(await sign({ to: ALLOWED, value: ETH / 2n - ETH / 10n, nonce: 5 }), { chainId: CHAIN });
    expect(e.action).toBe("deny"); // 0.4 is over per-tx 0.1 cap
    expect(e.action === "deny" && e.code).toBe("OVER_CAP");
  });
  it("increaseAllowance ten times under a 1000 cap stops at the 1500 window (audit 2 extra)", async () => {
    const g = setup();
    const inc = encodeFunctionData({ abi: parseAbi(["function increaseAllowance(address,uint256)"]), args: [SPENDER_OK, 1000n] });
    let allowed = 0;
    for (let n = 0; n < 10; n++) if ((await sendOk(g, await sign({ to: TOKEN, data: inc, nonce: n }))).action === "forward") allowed++;
    expect(allowed).toBe(1);
  });
  it("denies when the store is down", async () => {
    const store = new MemoryStore();
    store.reserveSpend = async () => {
      throw new Error("disk full");
    };
    const g = setup({ store });
    const c = await g.guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 0 }), { chainId: CHAIN });
    expect(c).toMatchObject({ action: "deny", code: "STORE_DOWN" });
  });
});

describe("idempotency (audit claim 3)", () => {
  it("a key survives a restart: a re-signed retry after restart is a conflict, not a second send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "l2sg-"));
    const file = join(dir, "state.jsonl");
    const chain = new FakeChain();
    const s1 = new FileStore(file);
    const g1 = setup({ store: s1, chain });
    const raw = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    const first = await g1.guard.check(raw, { chainId: CHAIN, idempotencyKey: "pay-42" });
    expect(first.action).toBe("forward");
    await s1.close(); // crash before the upstream answered
    chain.nonce = 1; // ...and the first one was mined
    chain.known.add(keccak256(raw));
    const s2 = new FileStore(file);
    const g2 = setup({ store: s2, chain });
    const retry = await g2.guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 1 }), { chainId: CHAIN, idempotencyKey: "pay-42" });
    expect(retry).toMatchObject({ action: "deny", code: "IDEMPOTENCY_CONFLICT" });
    await s2.close();
  });
  it("memory store is bounded and fails closed when full", async () => {
    const store = new MemoryStore({ maxIdemEntries: 100 });
    const g = setup({ store });
    let denied = 0;
    for (let n = 0; n < 150; n++) {
      const c = await g.guard.check(await sign({ to: ALLOWED, value: 1n, nonce: n }), { chainId: CHAIN, idempotencyKey: `k${n}` });
      if (c.action === "deny") {
        expect(c.code).toBe("STORE_DOWN");
        denied++;
      }
    }
    expect(store.idemCount).toBeLessThanOrEqual(100);
    expect(denied).toBe(50);
  });
  it("an in-flight key is never stuck: the same bytes can always be re-sent", async () => {
    const g = setup();
    const raw = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    await g.guard.check(raw, { chainId: CHAIN, idempotencyKey: "k" }); // upstream timed out; never settled
    const again = await g.guard.check(raw, { chainId: CHAIN, idempotencyKey: "k" });
    expect(again).toMatchObject({ action: "forward", replay: true });
  });
  it("a fee-bump replacement (same nonce) is allowed; a new nonce is a conflict until resolved", async () => {
    const g = setup();
    await g.guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 0 }), { chainId: CHAIN, idempotencyKey: "k" });
    const bump = await g.guard.check(await sign({ to: ALLOWED, value: 2n, nonce: 0 }), { chainId: CHAIN, idempotencyKey: "k" });
    expect(bump).toMatchObject({ action: "forward", replay: false });
    const other = await g.guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 1 }), { chainId: CHAIN, idempotencyKey: "k" });
    expect(other).toMatchObject({ action: "deny", code: "IDEMPOTENCY_CONFLICT" });
    // Nonce 0 got used by some other tx (and it wasn't ours): the key is free again.
    g.chain.nonce = 1;
    await g.store.noteSent(CHAIN, AGENT, 0, "0xother");
    const freed = await g.guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 1 }), { chainId: CHAIN, idempotencyKey: "k" });
    expect(freed.action).toBe("forward");
  });
  it("a definite rejection frees the key; finished keys expire after the TTL", async () => {
    const g = setup();
    const c = await g.guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 0 }), { chainId: CHAIN, idempotencyKey: "k" });
    if (c.action === "forward") await g.guard.settle(c, "rejected");
    expect((await g.guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 0 }), { chainId: CHAIN, idempotencyKey: "k" })).action).toBe("forward");
    const d = await sendOk(g, await sign({ to: ALLOWED, value: 1n, nonce: 0 }), "k2");
    expect(d.action).toBe("forward");
    g.t.now += 86_401;
    await sendOk(g, await sign({ to: ALLOWED, value: 1n, nonce: 1 }), "k3");
    expect(await g.store.getIdem("k2")).toBeUndefined();
  });
  it("classifies upstream answers", () => {
    expect(classifyUpstream({}, false)).toBe("accepted");
    expect(classifyUpstream({ error: { message: "already known" } }, false)).toBe("accepted");
    expect(classifyUpstream({ error: { message: "nonce too low" } }, false)).toBe("rejected");
    expect(classifyUpstream(undefined, true)).toBe("unknown");
  });
});

describe("bypass detection", () => {
  it("locks the sender when a nonce moves without the guard, until unlocked", async () => {
    const g = setup();
    const events: unknown[] = [];
    const guard = new Guard({ policy: basePolicy(), store: g.store, readers: new Map([[CHAIN, g.chain]]), now: () => g.t.now, onBypass: (e) => void events.push(e) });
    const gg = { ...g, guard };
    expect((await sendOk(gg, await sign({ to: ALLOWED, value: 1n, nonce: 0 }))).action).toBe("forward");
    g.chain.nonce = 2; // nonce 1 went out through some other RPC
    const c = await guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 2 }), { chainId: CHAIN });
    expect(c).toMatchObject({ action: "deny", code: "BYPASS_LOCKED" });
    expect(events).toHaveLength(1);
    expect((await guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 2 }), { chainId: CHAIN })).action).toBe("deny");
    await guard.unlock(CHAIN, agent.address);
    expect((await guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 2 }), { chainId: CHAIN })).action).toBe("forward");
  });
  it("a concurrent forward that is mined before settle is not a false alarm", async () => {
    const g = setup();
    const a = await g.guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 0 }), { chainId: CHAIN });
    g.chain.nonce = 1; // mined, settle not called yet
    const b = await g.guard.check(await sign({ to: ALLOWED, value: 1n, nonce: 1 }), { chainId: CHAIN });
    expect(a.action).toBe("forward");
    expect(b.action).toBe("forward");
  });
});

describe("guarded signer (binding against the key-holder)", () => {
  it("refuses to sign what the policy denies; the signature never exists", async () => {
    const { guard } = setup();
    const signer = createGuardedSigner(agent, guard, { chainId: CHAIN });
    const ok = await signer.signTransaction({ chainId: CHAIN, nonce: 0, to: ALLOWED, value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "eip1559" });
    expect(ok.startsWith("0x02")).toBe(true);
    await expect(
      signer.signTransaction({ chainId: CHAIN, nonce: 1, to: SPENDER_BAD, value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "eip1559" })
    ).rejects.toThrow(GuardDenied);
  });
  it("checks Permit2 typed data and 7702 authorizations before signing", async () => {
    const { guard } = setup();
    const signer = createGuardedSigner(agent, guard, { chainId: CHAIN });
    const permit = (spender: Address, amount: bigint) => ({
      domain: { name: "Permit2", chainId: CHAIN, verifyingContract: PERMIT2 },
      types: {
        PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
        PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
      },
      primaryType: "PermitSingle" as const,
      message: { details: { token: TOKEN, amount, expiration: 0, nonce: 0 }, spender, sigDeadline: 0n },
    });
    await expect(signer.signTypedData(permit(SPENDER_OK, 10n))).resolves.toMatch(/^0x/);
    await expect(signer.signTypedData(permit(SPENDER_BAD, 10n))).rejects.toThrow(/SPENDER_NOT_ALLOWED/);
    await expect(signer.signTypedData(permit(SPENDER_OK, (1n << 160n) - 1n))).rejects.toThrow(/APPROVAL_UNLIMITED/);
    await expect(signer.signAuthorization!({ address: "0x000000000000000000000000000000000000dEaD", chainId: CHAIN, nonce: 0 })).rejects.toThrow(/AUTHORIZATION_DENIED/);
  });
});
