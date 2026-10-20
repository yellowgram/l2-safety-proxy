import { describe, expect, it } from "vitest";
import { PostgresStore } from "../../src/guard/store/postgres.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("PostgresStore", () => {
  it("rolling caps hold under 20 concurrent reservations from two pools", async () => {
    const a = await PostgresStore.connect(url!);
    const b = await PostgresStore.connect(url!);
    const sender = `0x${Math.random().toString(16).slice(2).padEnd(40, "0")}`;
    const spend = { native: 10n, tokens: new Map([["0xtoken", 1n]]) };
    const limits = { native: 50n, tokens: new Map<string, bigint>() };
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).reserveSpend(1, sender, spend, limits, 3600, 1000)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    const ok = results.find((r) => r.ok)!;
    if (ok.ok) await a.releaseSpend(ok.id);
    expect((await a.reserveSpend(1, sender, spend, limits, 3600, 1000)).ok).toBe(true);
    expect((await a.reserveSpend(1, sender, spend, limits, 3600, 5000)).ok).toBe(true); // window rolled
    await a.close();
    await b.close();
  });
  it("idempotency claim is atomic and in-flight records never expire", async () => {
    const s = await PostgresStore.connect(url!);
    const key = `k-${Math.random()}`;
    const rec = { key, txHash: "0x1", status: "in_flight" as const, createdAt: 1, updatedAt: 1 };
    const claims = await Promise.all(Array.from({ length: 10 }, () => s.claimIdem(rec)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await s.expireIdem(10_000_000_000);
    expect(await s.getIdem(key)).toMatchObject({ status: "in_flight" });
    await s.putIdem({ ...rec, status: "sent", updatedAt: 2 });
    await s.expireIdem(10_000_000_000);
    expect(await s.getIdem(key)).toBeUndefined();
    await s.lock(1, "0xAbC", "test", 1);
    expect((await s.senderState(1, "0xabc")).locked?.reason).toBe("test");
    await s.unlock(1, "0xabc");
    expect((await s.senderState(1, "0xabc")).locked).toBeUndefined();
    await s.close();
  });
});
