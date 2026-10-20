// LaunchGate re-review (2026-10-20) P3 items, fixed in round 2b:
//  - self-calls on the agent's own account that are not wrappers (ACCOUNT_ADMIN list gap);
//  - a killing test for mutant R5-acctonly (calls.ts: account-only wrappers unpacked only on the agent's account);
//  - a killing test for mutant R6-kinds (handler.ts: exactly one of tx / hash / bundle per mev body item);
//  - INTERNAL_ERROR (guard.ts) and the check-policy "no selectors" warning had no test.
import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import { Guard } from "../../src/guard/guard.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { handleRequest } from "../../src/proxy/handler.js";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GuardConfig, SimResult } from "../../src/types/index.js";
import { AGENT, ALLOWED, ATTACKER, CHAIN, ETH, MULTICALL3, SAFE, TOKEN, basePolicy, sign } from "../guard/helpers.js";

const judge = async (p: ReturnType<typeof basePolicy>, tx: Parameters<typeof sign>[0]) =>
  evaluateTx(p, await parseSignedTx(await sign(tx)), { chainId: CHAIN, now: 1_000_000 });
const IMPL = "0x8888888888888888888888888888888888888888" as Address;
const abi = parseAbi([
  "function upgradeToAndCall(address newImplementation, bytes data)",
  "function addOwnerAddress(address owner)",
  "function execute(address target, uint256 value, bytes data)",
  "function transfer(address to, uint256 amount)",
]);
const upgrade = encodeFunctionData({ abi, functionName: "upgradeToAndCall", args: [IMPL, "0x"] });
const addOwner = encodeFunctionData({ abi, functionName: "addOwnerAddress", args: [ATTACKER] });
const exec = (target: Address, value: bigint, data: Hex) => encodeFunctionData({ abi, functionName: "execute", args: [target, value, data] });
// The agent lists its own 7702 EOA as a destination. The load check refuses an accounts[] entry that is
// also a destination, but it can't know the sender, so this policy loads.
const selfListed = () => basePolicy({ destinations: { [ALLOWED]: {}, [MULTICALL3]: {}, [AGENT]: {} }, accounts: [SAFE] });

describe("own-account calls that are not wrappers are denied, even when the account is a listed destination", () => {
  it("upgradeToAndCall on the sender's own (7702) account", async () => {
    const v = await judge(selfListed(), { to: AGENT, data: upgrade });
    expect(v.allow).toBe(false);
    expect(v.code).toBe("ACCOUNT_ADMIN_DENIED");
  });
  it("Coinbase-style addOwnerAddress on the sender", async () => {
    expect((await judge(selfListed(), { to: AGENT, data: addOwner })).code).toBe("ACCOUNT_ADMIN_DENIED");
  });
  it("the same self-call hidden inside the account's own execute wrapper", async () => {
    expect((await judge(selfListed(), { to: AGENT, data: exec(AGENT, 0n, upgrade) })).code).toBe("ACCOUNT_ADMIN_DENIED");
  });
  it("an unknown function on a smart account in accounts[] (not a destination)", async () => {
    expect((await judge(selfListed(), { to: SAFE, data: addOwner })).code).toBe("ACCOUNT_ADMIN_DENIED");
  });
  it("controls: the plain nonce cancel and a wrapped allowed send still pass", async () => {
    expect((await judge(selfListed(), { to: AGENT, data: "0x" })).allow).toBe(true);
    expect((await judge(selfListed(), { to: AGENT, data: exec(ALLOWED, 1n, "0x") })).allow).toBe(true);
  });
});

describe("R5-acctonly: execute(...) on someone else's contract is one ordinary call on that contract", () => {
  it("execute(target, value, data) on a listed non-account destination is judged as a call on that destination, not unpacked", async () => {
    // Unpacking it would judge ATTACKER as if the agent called it (it does not: the contract does).
    const v = await judge(basePolicy(), { to: ALLOWED, data: exec(ATTACKER, 0n, "0x") });
    expect(v.allow, v.reason).toBe(true);
  });
  it("the same execute on the agent's own account is unpacked, so its inner call is judged", async () => {
    expect((await judge(basePolicy(), { to: AGENT, data: exec(ATTACKER, 0n, "0x") })).code).toBe("DESTINATION_NOT_ALLOWED");
  });
});

const okSim = vi.fn(async (): Promise<SimResult> => ({ ok: true, method: "simulate_v1", confidence: "definite", logsInspected: true }) as SimResult);
const cfg = (guard: Guard) =>
  ({ listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base", guard,
    chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } } }) as GuardConfig;
const H = ("0x" + "ab".repeat(32)) as Hex;

describe("R6-kinds: each mev_sendBundle body item carries exactly one of tx, hash or bundle", () => {
  it("{hash, bundle:{body:[{tx: EVIL}]}} is refused: the nested bundle can't hide behind a valid hash", async () => {
    const evil = await sign({ to: ATTACKER, value: ETH, nonce: 0 });
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xok" }));
    const params = [{ version: "v0.1", inclusion: { block: "0x1" }, body: [{ hash: H, bundle: { version: "v0.1", inclusion: { block: "0x1" }, body: [{ tx: evil }] } }] }];
    const r = await handleRequest(cfg(new Guard({ policy: basePolicy(), store: new MemoryStore() })), { jsonrpc: "2.0", id: 1, method: "mev_sendBundle", params } as never, undefined, { simulate: okSim, forward });
    expect(r.error?.code).toBe(-32602);
    expect(forward).not.toHaveBeenCalled();
  });
  it("{tx: GOOD, hash} is refused too (ambiguous item)", async () => {
    const good = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xok" }));
    const params = [{ version: "v0.1", inclusion: { block: "0x1" }, body: [{ tx: good, hash: H }] }];
    const r = await handleRequest(cfg(new Guard({ policy: basePolicy(), store: new MemoryStore() })), { jsonrpc: "2.0", id: 1, method: "mev_sendBundle", params } as never, undefined, { simulate: okSim, forward });
    expect(r.error?.code).toBe(-32602);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("INTERNAL_ERROR: a policy check that throws refuses the send", () => {
  it("returns deny INTERNAL_ERROR, never allow", async () => {
    const policy = basePolicy();
    // Corrupt the policy so evaluateTx throws something that is not a Deny.
    (policy as unknown as { destinations: unknown }).destinations = { get() { throw new Error("boom"); }, has() { throw new Error("boom"); } };
    const g = new Guard({ policy, store: new MemoryStore() });
    const v = await g.check(await sign({ to: ALLOWED, value: 1n, nonce: 0 }), { chainId: CHAIN });
    expect(v.action).toBe("deny");
    if (v.action !== "deny") return;
    expect(v.code).toBe("INTERNAL_ERROR");
    expect(v.reason).toMatch(/failed unexpectedly, refusing to send: boom/);
  });
});

const run = promisify(execFile);
async function checkPolicy(policy: unknown): Promise<string> {
  const f = join(mkdtempSync(join(tmpdir(), "l2sg-cp-")), "policy.json");
  writeFileSync(f, JSON.stringify(policy));
  const { stdout } = await run(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts", "check-policy", f], { timeout: 20_000 });
  return stdout;
}
const minimal = (destinations: Record<string, unknown>) => ({
  window: { seconds: 3600 }, native: { maxPerTxWei: "1", windowMaxWei: "2" }, destinations,
  tokens: { [TOKEN]: { transfer: { recipients: [ALLOWED], maxAmountRaw: "1" } } },
});

describe("check-policy warnings", () => {
  it("warns about a destination with no selectors, and a token that is also an unrestricted destination", async () => {
    const out = await checkPolicy(minimal({ [ALLOWED]: {}, [TOKEN]: {} }));
    expect(out).toContain(`warning: destination ${ALLOWED.toLowerCase()}: any function may be called on it (set selectors to restrict)`);
    expect(out).toContain(`warning: token ${TOKEN.toLowerCase()} is also a destination with no selectors`);
  }, 30_000);
  it("no such warning once selectors are set", async () => {
    const out = await checkPolicy(minimal({ [ALLOWED]: { selectors: ["0xa9059cbb"] } }));
    expect(out).toContain("valid");
    expect(out).not.toContain(`warning: destination ${ALLOWED.toLowerCase()}`);
  }, 30_000);
});
