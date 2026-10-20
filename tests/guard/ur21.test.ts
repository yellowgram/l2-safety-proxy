/**
 * Universal Router 2.1 (2.1.1 and 2.1.2; the contracts are identical, only the v4-periphery pin moved).
 * A router address listed in UR_V2_1 for the chain is read with the 2.1 layout: command mask 0x7f, a
 * sixth `uint256[] minHopPriceX36` on V2/V3 swaps, PAY_PORTION_FULL_PRECISION (0x07), V4_SWAP (0x10)
 * with the 2.1 V4 structs, executeSigned. Every other router keeps the 2.0 layout exactly.
 *
 * The first block replays real 2.1.2 transactions (tests/fixtures/ur21-onchain.json, built by
 * scripts/ur21-fixtures.mjs). Their expected payees and hooks come from an independent viem decode,
 * not from the guard.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { UR_V2_1, UR_WETH, flattenCalls, ur21Routers } from "../../src/guard/calls.js";
import { parsePolicy, PolicyError } from "../../src/guard/policy/load.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import { Guard } from "../../src/guard/guard.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { handleRequest } from "../../src/proxy/handler.js";
import type { GuardConfig } from "../../src/types/index.js";
import { AGENT, ALLOWED, ATTACKER, CHAIN, MULTICALL3, MULTICALL3_SELECTORS, PERMIT2, RECIPIENT, ROUTER, ROUTER_SELECTORS, TOKEN, sign } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// Real transactions
// ---------------------------------------------------------------------------------------------

interface Fixture {
  chainId: number; router: Address; block: number; hash: Hex; status: "0x1" | "0x0"; from: Address; value: Hex;
  commands: Hex; suffix: Hex; payees: string[]; hooks: string[]; permitTokens: string[]; input: Hex;
}
const FIXTURES: Fixture[] = JSON.parse(readFileSync(new URL("../fixtures/ur21-onchain.json", import.meta.url), "utf8"));
const EXEC = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const enc = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values as never);
const canonical = (f: Fixture) => f.input.slice(0, f.input.length - (f.suffix.length - 2)) as Hex;
// 2026-10-20T00:00Z, around the capture. Permit2 permits in the capture expire about 30 days later.
const NOW = 1_792_454_400;

/** A policy that allows exactly what the transaction pays out to, judged by the independent decode. */
function fixturePolicy(f: Fixture, o: { hooks?: string[]; payees?: string[]; router?: Address } = {}) {
  const router = o.router ?? f.router;
  const from = f.from.toLowerCase();
  const tokens: Record<string, unknown> = {};
  for (const t of f.permitTokens) tokens[t] = { approve: { spenders: [router] } };
  return parsePolicy({
    destinations: { [router]: { selectors: ["execute(bytes,bytes[],uint256)"] }, [MULTICALL3]: { selectors: MULTICALL3_SELECTORS } },
    tokens,
    universalRouter: { recipients: (o.payees ?? f.payees).filter((a) => a !== from && a !== router.toLowerCase()), v4Hooks: o.hooks ?? f.hooks },
    permit2: { maxExpirySeconds: 365 * 86400 },
  });
}
const judgeFixture = (f: Fixture, data: Hex, policy = fixturePolicy(f), to: Address = f.router) =>
  evaluateTx(policy, { from: f.from, to, value: BigInt(f.value), data }, { chainId: f.chainId, now: NOW });
/** Permit2 permits in the capture are for 2^160-1, which the guard always refuses as unlimited. */
const unlimitedPermit = (f: Fixture) => f.permitTokens.length > 0;

describe("real Universal Router 2.1.2 transactions (tests/fixtures/ur21-onchain.json)", () => {
  it("the capture covers all four chains, V4 and V2/V3 plans, hooks, Permit2 and ETH input", () => {
    expect(FIXTURES).toHaveLength(96);
    expect(new Set(FIXTURES.map((f) => f.chainId))).toEqual(new Set([1, 10, 8453, 42161]));
    for (const f of FIXTURES) expect(UR_V2_1[f.chainId]).toContain(f.router.toLowerCase());
    const has = (c: string) => FIXTURES.filter((f) => f.commands.slice(2).match(/../g)!.includes(c)).length;
    expect(has("10")).toBeGreaterThan(40);
    expect(has("00")).toBeGreaterThan(20);
    expect(has("08") + has("09")).toBeGreaterThan(3);
    expect(FIXTURES.filter((f) => f.hooks.length > 0)).toHaveLength(10);
    expect(FIXTURES.filter((f) => f.permitTokens.length > 0)).toHaveLength(17);
    expect(FIXTURES.filter((f) => BigInt(f.value) > 0n).length).toBeGreaterThan(20);
    expect(FIXTURES.filter((f) => f.status === "0x1")).toHaveLength(90);
  });

  it("94 of 96 carry bytes after the ABI encoding of execute(); those are refused as NON_CANONICAL_ABI", () => {
    const suffixed = FIXTURES.filter((f) => f.suffix !== "0x");
    expect(suffixed).toHaveLength(94);
    for (const f of suffixed) {
      // The suffix starts with the ASCII bytes "unix" in every one.
      expect(f.suffix.slice(0, 10)).toBe("0x756e6978");
      const v = judgeFixture(f, f.input);
      expect(v, f.hash).toMatchObject({ allow: false, code: "NON_CANONICAL_ABI" });
    }
  });

  it.each(FIXTURES.map((f) => [f.hash, f] as const))("%s: the guard finds exactly the payees an independent decode finds", (_h, f) => {
    const flat = flattenCalls({ to: f.router, value: BigInt(f.value), data: canonical(f) }, { sender: f.from, accounts: new Set(), permit2: PERMIT2.toLowerCase(), weth: UR_WETH[f.chainId], ur21: ur21Routers(f.chainId), v4Hooks: new Set(f.hooks) });
    const payees = new Set(flat.leaves.filter((l) => l.kind === "payout").map((l) => (l as { recipient: string }).recipient.toLowerCase()));
    expect([...payees].sort()).toEqual(f.payees);
  });

  it.each(FIXTURES.map((f) => [f.hash, f] as const))("%s: allowed once its payees and hooks are listed", (_h, f) => {
    const v = judgeFixture(f, canonical(f));
    if (unlimitedPermit(f)) expect(v, v.reason).toMatchObject({ allow: false, code: "APPROVAL_UNLIMITED", path: "tx>execute[0:0x0a]" });
    else expect(v.allow, `${f.hash}: ${v.code} ${v.reason}`).toBe(true);
  });

  it("with no hooks listed, every transaction through a hooked pool is ROUTER_V4_HOOK_NOT_ALLOWED", () => {
    for (const f of FIXTURES.filter((x) => x.hooks.length > 0 && !unlimitedPermit(x))) {
      const v = judgeFixture(f, canonical(f), fixturePolicy(f, { hooks: [] }));
      expect(v, f.hash).toMatchObject({ allow: false, code: "ROUTER_V4_HOOK_NOT_ALLOWED" });
      expect(v.path).toMatch(/^tx>execute\[\d+:0x10\]>v4\[\d+:0x0[6-9]\]$/);
    }
  });

  it("dropping any listed third-party payee gives ROUTER_RECIPIENT_NOT_ALLOWED", () => {
    let n = 0;
    for (const f of FIXTURES.filter((x) => !unlimitedPermit(x))) {
      for (const p of f.payees.filter((a) => a !== f.from.toLowerCase() && a !== f.router.toLowerCase())) {
        const v = judgeFixture(f, canonical(f), fixturePolicy(f, { payees: f.payees.filter((a) => a !== p) }));
        expect(v, `${f.hash} without ${p}`).toMatchObject({ allow: false, code: "ROUTER_RECIPIENT_NOT_ALLOWED" });
        n++;
      }
    }
    expect(n).toBe(3);
  });

  it("the same calldata sent to a router the guard reads as 2.0 is never allowed", () => {
    const other = "0x6ff5693b99212da76ad316178a184ab56d299b43" as Address; // Base Universal Router 2.0
    for (const f of FIXTURES.filter((x) => x.chainId === 8453 && !unlimitedPermit(x))) {
      const v = judgeFixture(f, canonical(f), fixturePolicy(f, { router: other }), other);
      expect(v.allow, f.hash).toBe(false);
      expect(["NON_CANONICAL_ABI", "ROUTER_COMMAND_UNCHECKED"]).toContain(v.code);
    }
  });

  it("one real V4 plan with its TAKE recipient swapped for an attacker is refused", () => {
    // Mainnet 0xafef685c…: V4_SWAP [SETTLE, SWAP_EXACT_IN_SINGLE, SWAP_EXACT_IN_SINGLE, TAKE], then SWEEP.
    const f = FIXTURES.find((x) => x.hash.startsWith("0xafef685c"))!;
    expect(judgeFixture(f, canonical(f)).allow).toBe(true);
    const [commands, inputs, deadline] = decodeFunctionData({ abi: EXEC, data: canonical(f) }).args;
    const at = commands.slice(2).match(/../g)!.indexOf("10");
    const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), inputs[at]!);
    const take = actions.slice(2).match(/../g)!.indexOf("0e");
    expect(take).toBeGreaterThan(0);
    const [currency, , amount] = decodeAbiParameters(parseAbiParameters("address, address, uint256"), params[take]!);
    const forgedParams = params.map((x, j) => (j === take ? enc("address, address, uint256", [currency, ATTACKER, amount]) : x));
    const forgedInputs = inputs.map((x, j) => (j === at ? enc("bytes, bytes[]", [actions, forgedParams]) : x));
    const forged = encodeFunctionData({ abi: EXEC, args: [commands, forgedInputs, deadline] });
    expect(judgeFixture(f, forged)).toMatchObject({ allow: false, code: "ROUTER_RECIPIENT_NOT_ALLOWED", path: `tx>execute[${at}:0x10]>v4[${take}:0x0e]` });
  });

  it("the part before the suffix is exactly the canonical encoding of execute()", () => {
    for (const f of FIXTURES) {
      const re = encodeFunctionData({ abi: EXEC, functionName: "execute", args: decodeFunctionData({ abi: EXEC, data: f.input }).args });
      expect(re.toLowerCase()).toBe(canonical(f).toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Synthetic plans
// ---------------------------------------------------------------------------------------------

const UR21 = "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40" as Address; // Base 2.1.2 (CHAIN is Base)
const UR211 = "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7" as Address; // Base 2.1.1
const UR20 = ROUTER; // not a 2.1 router on Base: read with the 2.0 layout
const MSG_SENDER = "0x0000000000000000000000000000000000000001" as Address;
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;
const ETH_C = "0x0000000000000000000000000000000000000000" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const HOOK = "0x0000000000000000000000000000000000004444" as Address;
const CONTRACT_BALANCE = 1n << 255n;
const OPEN = 0n;
const EXEC_SIGNED = "executeSigned(bytes,bytes[],bytes32,bytes32,bool,bytes32,bytes,uint256)";
const SIGNED_ABI = parseAbi(["function executeSigned(bytes commands, bytes[] inputs, bytes32 intent, bytes32 data, bool verifySender, bytes32 nonce, bytes signature, uint256 deadline)"]);

function policy(extra: Record<string, unknown> = {}, routerSelectors = [...ROUTER_SELECTORS, EXEC_SIGNED]) {
  return parsePolicy({
    window: { seconds: 3600 },
    native: { maxPerTxWei: (10n ** 17n).toString(), windowMaxWei: (10n ** 18n).toString() },
    destinations: {
      [ALLOWED]: { type: "eoa" },
      [MULTICALL3]: { selectors: MULTICALL3_SELECTORS },
      [UR21]: { selectors: routerSelectors },
      [UR211]: { selectors: routerSelectors },
      [UR20]: { selectors: routerSelectors },
    },
    ...extra,
  });
}
type Cmd = readonly [string, Hex];
const plan = (cmds: readonly Cmd[]) =>
  encodeFunctionData({ abi: EXEC, args: [("0x" + cmds.map((c) => c[0].slice(2)).join("")) as Hex, cmds.map((c) => c[1]), 0n] });
async function judge(p: ReturnType<typeof policy>, tx: Parameters<typeof sign>[0], chainId = CHAIN) {
  return evaluateTx(p, await parseSignedTx(await sign({ ...tx, chainId })), { chainId, now: 1_000_000 });
}
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const v3Path = (...hops: Address[]) =>
  encodePacked(hops.flatMap((_, i) => (i === 0 ? ["address"] : ["uint24", "address"])), hops.flatMap((a, i) => (i === 0 ? [a] : [500, a])) as never);

// 2.1 V2/V3 swaps: six arguments.
const V3_IN6 = (to: Address, minHop: bigint[] = [], path = v3Path(TOKEN, WETH), amount = 1n, payerIsUser = true) =>
  ["0x00", enc("address, uint256, uint256, bytes, bool, uint256[]", [to, amount, 0n, path, payerIsUser, minHop])] as const;
const V3_OUT6 = (to: Address, minHop: bigint[] = []) => ["0x01", enc("address, uint256, uint256, bytes, bool, uint256[]", [to, 1n, 5n, v3Path(WETH, TOKEN), true, minHop])] as const;
const V2_IN6 = (to: Address, minHop: bigint[] = [], route: Address[] = [TOKEN, WETH]) =>
  ["0x08", enc("address, uint256, uint256, address[], bool, uint256[]", [to, 1n, 0n, route, true, minHop])] as const;
const V2_OUT6 = (to: Address, minHop: bigint[] = []) => ["0x09", enc("address, uint256, uint256, address[], bool, uint256[]", [to, 1n, 5n, [TOKEN, WETH], true, minHop])] as const;
// 2.0 layout: five arguments.
const V3_IN5 = (to: Address) => ["0x00", enc("address, uint256, uint256, bytes, bool", [to, 1n, 0n, v3Path(TOKEN, WETH), true])] as const;
const V2_IN5 = (to: Address) => ["0x08", enc("address, uint256, uint256, address[], bool", [to, 1n, 0n, [TOKEN, WETH], true])] as const;
const SWEEP = (token: Address, to: Address) => ["0x04", enc("address, address, uint256", [token, to, 0n])] as const;
const PAY_FULL = (to: Address, flag = "0x07") => [flag, enc("address, address, uint256", [TOKEN, to, 10n ** 16n])] as const;
const WRAP = (to: Address, amount: bigint) => ["0x0b", enc("address, uint256", [to, amount])] as const;

// V4 actions (v4-periphery Actions.sol) and their 2.1 params (IV4Router.sol with minHopPriceX36).
const PK = "(address,address,uint24,int24,address)";
const PATHK = "(address,uint24,int24,address,bytes)";
type Act = readonly [number, Hex];
const poolKey = (a: Address, b: Address, hooks: Address = ETH_C) => {
  const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return [c0, c1, 500, 10, hooks] as const;
};
const A = {
  IN_SINGLE: (cin: Address, cout: Address, amountIn: bigint, hooks: Address = ETH_C, minHop = 0n): Act => {
    const k = poolKey(cin, cout, hooks);
    return [0x06, enc(`(${PK},bool,uint128,uint128,uint256,bytes)`, [[k, k[0] === cin, amountIn, 0n, minHop, "0x"]])];
  },
  OUT_SINGLE: (cin: Address, cout: Address, amountOut: bigint, hooks: Address = ETH_C): Act => {
    const k = poolKey(cin, cout, hooks);
    return [0x08, enc(`(${PK},bool,uint128,uint128,uint256,bytes)`, [[k, k[0] === cin, amountOut, 10n ** 18n, 0n, "0x"]])];
  },
  IN: (cin: Address, hops: Address[], amountIn: bigint, minHop: bigint[] = [], hooks: Address = ETH_C): Act => [
    0x07,
    enc(`(address,${PATHK}[],uint256[],uint128,uint128)`, [[cin, hops.map((h) => [h, 500, 10, hooks, "0x"]), minHop, amountIn, 0n]]),
  ],
  OUT: (cout: Address, hops: Address[], amountOut: bigint, minHop: bigint[] = []): Act => [
    0x09,
    enc(`(address,${PATHK}[],uint256[],uint128,uint128)`, [[cout, hops.map((h) => [h, 500, 10, ETH_C, "0x"]), minHop, amountOut, 10n ** 18n]]),
  ],
  SETTLE: (c: Address, amount: bigint, payerIsUser: boolean): Act => [0x0b, enc("address, uint256, bool", [c, amount, payerIsUser])],
  SETTLE_ALL: (c: Address, max = 10n ** 18n): Act => [0x0c, enc("address, uint256", [c, max])],
  TAKE: (c: Address, to: Address, amount = OPEN): Act => [0x0e, enc("address, address, uint256", [c, to, amount])],
  TAKE_ALL: (c: Address): Act => [0x0f, enc("address, uint256", [c, 0n])],
  TAKE_PORTION: (c: Address, to: Address): Act => [0x10, enc("address, address, uint256", [c, to, 25n])],
};
const v4 = (acts: readonly Act[], flag = "0x10"): Cmd => [flag, enc("bytes, bytes[]", [("0x" + acts.map((a) => a[0].toString(16).padStart(2, "0")).join("")) as Hex, acts.map((a) => a[1])])];
/** A plain user-paid V4 exact-in swap: Permit2 pays the debt, the output goes to msgSender(). */
const userSwap = (extra: readonly Act[] = []) => v4([A.IN_SINGLE(TOKEN, WETH, 100n), A.SETTLE_ALL(TOKEN), A.TAKE_ALL(WETH), ...extra]);
const aggregate3 = (target: Address, callData: Hex) =>
  encodeFunctionData({ abi: parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls)"]), args: [[{ target, allowFailure: false, callData }]] });

describe("router version is chosen by address and chain", () => {
  it("UR_V2_1 lists the 2.1.1 and 2.1.2 deployments for every template chain with a Universal Router", () => {
    expect(UR_V2_1[8453]).toEqual([UR211.toLowerCase(), UR21.toLowerCase()]);
    expect(Object.keys(UR_V2_1).map(Number).sort((a, b) => a - b)).toEqual([1, 10, 8453, 42161, 84532, 11155111]);
    expect(ur21Routers(CHAIN).has(UR21.toLowerCase())).toBe(true);
    expect(ur21Routers(11155420).size).toBe(0); // OP Sepolia: no Universal Router
    expect(ur21Routers(undefined).size).toBe(0);
  });
  it("2.1 routers (2.1.2 and 2.1.1) take the six-argument V2/V3 swaps", async () => {
    for (const to of [UR21, UR211]) {
      for (const c of [V3_IN6(MSG_SENDER), V3_OUT6(AGENT), V2_IN6(MSG_SENDER), V2_OUT6(AGENT)]) {
        const v = await judge(policy(), { to, data: plan([c]) });
        expect(v.allow, `${to} ${c[0]}: ${v.reason}`).toBe(true);
      }
    }
  });
  it("a 2.0-layout (five-argument) swap sent to a 2.1 router is NON_CANONICAL_ABI", async () => {
    for (const c of [V3_IN5(MSG_SENDER), V2_IN5(MSG_SENDER)]) {
      expect(await judge(policy(), { to: UR21, data: plan([c]) })).toMatchObject({ allow: false, code: "NON_CANONICAL_ABI", path: `tx>execute[0:${c[0]}]` });
    }
  });
  it("a six-argument swap sent to a 2.0 router is NON_CANONICAL_ABI, and the five-argument one still passes there", async () => {
    for (const c of [V3_IN6(MSG_SENDER), V2_IN6(MSG_SENDER)]) {
      expect(await judge(policy(), { to: UR20, data: plan([c]) })).toMatchObject({ allow: false, code: "NON_CANONICAL_ABI" });
    }
    for (const c of [V3_IN5(MSG_SENDER), V2_IN5(MSG_SENDER)]) expect((await judge(policy(), { to: UR20, data: plan([c]) })).allow).toBe(true);
  });
  it("the 2.1 address on a chain where it isn't a 2.1 router is read as 2.0", async () => {
    // Base's 2.1.2 address means nothing on Ethereum mainnet (its 2.1.2 is 0x23617e59…).
    expect(await judge(policy(), { to: UR21, data: plan([V3_IN6(MSG_SENDER)]) }, 1)).toMatchObject({ allow: false, code: "NON_CANONICAL_ABI" });
    expect((await judge(policy(), { to: UR21, data: plan([V3_IN5(MSG_SENDER)]) }, 1)).allow).toBe(true);
  });
  it("a recipient swap in a six-argument swap is still judged", async () => {
    for (const c of [V3_IN6(ATTACKER), V3_OUT6(ATTACKER), V2_IN6(ATTACKER), V2_OUT6(ATTACKER)]) {
      expect(await judge(policy(), { to: UR21, data: plan([c]) })).toMatchObject({ allow: false, code: "ROUTER_RECIPIENT_NOT_ALLOWED", path: `tx>execute[0:${c[0]}]` });
    }
    expect((await judge(policy({ universalRouter: { recipients: [RECIPIENT] } }), { to: UR21, data: plan([V3_IN6(RECIPIENT)]) })).allow).toBe(true);
  });
});

describe("2.1 minHopPriceX36 on V2/V3 swaps", () => {
  it("empty or one entry per hop is accepted", async () => {
    const two = v3Path(TOKEN, RECIPIENT, WETH);
    for (const c of [V3_IN6(MSG_SENDER, [1n]), V3_IN6(MSG_SENDER, [1n, 2n], two), V3_IN6(MSG_SENDER, [], two), V2_IN6(MSG_SENDER, [1n]), V2_IN6(MSG_SENDER, [1n, 2n], [TOKEN, RECIPIENT, WETH])]) {
      const v = await judge(policy(), { to: UR21, data: plan([c]) });
      expect(v.allow, v.reason).toBe(true);
    }
  });
  it("any other length is NON_CANONICAL_ABI (the router would revert)", async () => {
    const cases = [
      [V3_IN6(MSG_SENDER, [1n, 2n]), "minHopPriceX36 has 2 entries for a 1-hop path; it must be empty or have one per hop"],
      [V3_IN6(MSG_SENDER, [1n], v3Path(TOKEN, RECIPIENT, WETH)), "minHopPriceX36 has 1 entries for a 2-hop path; it must be empty or have one per hop"],
      [V3_OUT6(MSG_SENDER, [1n, 2n, 3n]), "minHopPriceX36 has 3 entries for a 1-hop path; it must be empty or have one per hop"],
      [V2_IN6(MSG_SENDER, [1n, 2n]), "minHopPriceX36 has 2 entries for a 1-hop path; it must be empty or have one per hop"],
      [V2_OUT6(MSG_SENDER, [1n, 1n]), "minHopPriceX36 has 2 entries for a 1-hop path; it must be empty or have one per hop"],
    ] as const;
    for (const [c, reason] of cases) {
      expect(await judge(policy(), { to: UR21, data: plan([c]) })).toMatchObject({ allow: false, code: "NON_CANONICAL_ABI", path: `tx>execute[0:${c[0]}]`, reason });
    }
  });
  it("2.0's path rules still hold on 2.1: a V2 route under two tokens and a malformed V3 path", async () => {
    expect(await judge(policy(), { to: UR21, data: plan([V2_IN6(MSG_SENDER, [], [TOKEN])]) })).toMatchObject({ code: "NON_CANONICAL_ABI", reason: "Universal Router V2 path has fewer than two tokens" });
    const bad = (v3Path(TOKEN, WETH) + "00") as Hex;
    expect(await judge(policy(), { to: UR21, data: plan([V3_IN6(MSG_SENDER, [], bad)]) })).toMatchObject({ code: "NON_CANONICAL_ABI" });
  });
  it("a swap into the router on 2.1 must still leave it (ROUTER_OUTPUT_STRANDED)", async () => {
    expect(await judge(policy(), { to: UR21, data: plan([V3_IN6(ADDRESS_THIS)]) })).toMatchObject({ code: "ROUTER_OUTPUT_STRANDED", path: "tx>execute[0:0x00]" });
    expect((await judge(policy(), { to: UR21, data: plan([V3_IN6(ADDRESS_THIS), SWEEP(WETH, MSG_SENDER)]) })).allow).toBe(true);
  });
  it("padding the six-argument input with a trailing word is NON_CANONICAL_ABI", async () => {
    const [c, input] = V3_IN6(MSG_SENDER);
    expect(await judge(policy(), { to: UR21, data: plan([[c, (input + "00".repeat(32)) as Hex]]) })).toMatchObject({ code: "NON_CANONICAL_ABI", path: "tx>execute[0:0x00]" });
  });
});

describe("2.1 commands outside V4", () => {
  it("PAY_PORTION_FULL_PRECISION (0x07) is a payout bound like PAY_PORTION", async () => {
    expect((await judge(policy(), { to: UR21, data: plan([PAY_FULL(MSG_SENDER)]) })).allow).toBe(true);
    expect(await judge(policy(), { to: UR21, data: plan([PAY_FULL(ATTACKER)]) })).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED", path: "tx>execute[0:0x07]" });
    expect(await judge(policy(), { to: MULTICALL3, data: aggregate3(UR21, plan([PAY_FULL(MULTICALL3)])) })).toMatchObject({ code: "ROUTER_PAYOUT_TO_WRAPPER", path: "tx>aggregate3[0]>execute[0:0x07]" });
    expect(await judge(policy(), { to: UR21, data: plan([PAY_FULL(ATTACKER, "0x87")]) })).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED" });
    expect((await judge(policy({ universalRouter: { recipients: [RECIPIENT] } }), { to: UR21, data: plan([PAY_FULL(RECIPIENT)]) })).allow).toBe(true);
  });
  it("PAY_PORTION_FULL_PRECISION on a 2.0 router (where it doesn't exist) stays ROUTER_COMMAND_UNCHECKED", async () => {
    expect(await judge(policy(), { to: UR20, data: plan([PAY_FULL(MSG_SENDER)]) })).toMatchObject({ code: "ROUTER_COMMAND_UNCHECKED", path: "tx>execute[0:0x07]", reason: "Universal Router command 0x07 can't be checked by the guard" });
  });
  it("ACROSS_V4_DEPOSIT_V3 (0x40) is refused on 2.1: it bridges to a recipient on another chain", async () => {
    for (const flag of ["0x40", "0xc0"]) {
      expect(await judge(policy(), { to: UR21, data: plan([[flag, "0x"]]) })).toMatchObject({
        allow: false,
        code: "ROUTER_COMMAND_UNCHECKED",
        path: "tx>execute[0:0x40]",
        reason: "Universal Router command 0x40 (ACROSS_V4_DEPOSIT_V3) bridges funds to a recipient on another chain, which the guard can't check",
      });
    }
  });
  it("other command types in 0x41-0x7f are ROUTER_COMMAND_UNCHECKED on 2.1", async () => {
    for (const c of [0x41, 0x5f, 0x60, 0x7f, 0xff]) {
      const v = await judge(policy(), { to: UR21, data: plan([[`0x${c.toString(16)}`, "0x"]]) });
      expect(v, show(v)).toMatchObject({ code: "ROUTER_COMMAND_UNCHECKED", path: `tx>execute[0:0x${(c & 0x7f).toString(16)}]` });
    }
  });
  it("bit 0x40 is still NON_CANONICAL_ABI on a 2.0 router (where the mask is 0x3f)", async () => {
    for (const c of ["0x40", "0x44", "0xc4", "0x7f"]) {
      const v = await judge(policy(), { to: UR20, data: plan([[c, SWEEP(WETH, MSG_SENDER)[1]]]) });
      expect(v.code, c).toBe("NON_CANONICAL_ABI");
      // As in 2.0.0, the path names the command type under the 2.0 mask.
      expect(v.path).toBe(`tx>execute[0:0x${(parseInt(c, 16) & 0x3f).toString(16).padStart(2, "0")}]`);
      expect(v.reason).toContain("which this router version doesn't use");
    }
  });
  it("on 2.1 a SWEEP sent as 0x44 is a different command (0x44), not a SWEEP", async () => {
    expect(await judge(policy(), { to: UR21, data: plan([["0x44", SWEEP(WETH, MSG_SENDER)[1]]]) })).toMatchObject({ code: "ROUTER_COMMAND_UNCHECKED", path: "tx>execute[0:0x44]" });
  });
  it("V4_SWAP (0x10) stays ROUTER_COMMAND_UNCHECKED on a 2.0 router", async () => {
    expect(await judge(policy(), { to: UR20, data: plan([userSwap()]) })).toMatchObject({ code: "ROUTER_COMMAND_UNCHECKED", path: "tx>execute[0:0x10]" });
  });
  it("commands 2.1 doesn't change (sub-plans, Permit2 transfers, wraps) behave as on 2.0", async () => {
    const sub = (cmds: readonly Cmd[]): Cmd => ["0x21", enc("bytes, bytes[]", [("0x" + cmds.map((c) => c[0].slice(2)).join("")) as Hex, cmds.map((c) => c[1])])];
    expect(await judge(policy(), { to: UR21, data: plan([sub([V3_IN6(ATTACKER)])]) })).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED", path: "tx>execute[0:0x21]>subplan[0:0x00]" });
    expect(await judge(policy(), { to: UR21, data: plan([sub([v4([A.TAKE(WETH, ATTACKER)])])]) })).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED", path: "tx>execute[0:0x21]>subplan[0:0x10]>v4[0:0x0e]" });
    expect(await judge(policy(), { to: UR21, value: 5n, data: plan([WRAP(ADDRESS_THIS, 5n)]) })).toMatchObject({ code: "ROUTER_OUTPUT_STRANDED" });
  });
});

describe("executeSigned (2.1)", () => {
  const signed = (cmds: readonly Cmd[], verifySender = true) =>
    encodeFunctionData({
      abi: SIGNED_ABI,
      args: [("0x" + cmds.map((c) => c[0].slice(2)).join("")) as Hex, cmds.map((c) => c[1]), `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, verifySender, `0x${"33".repeat(32)}`, `0x${"44".repeat(65)}`, 0n],
    });
  it("its commands are decoded and judged like execute()", async () => {
    expect((await judge(policy(), { to: UR21, data: signed([V3_IN6(MSG_SENDER)]) })).allow).toBe(true);
    expect(await judge(policy(), { to: UR21, data: signed([V3_IN6(ATTACKER)]) })).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED", path: "tx>execute[0:0x00]" });
    expect(await judge(policy(), { to: UR21, data: signed([v4([A.TAKE(WETH, ATTACKER)])], false) })).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED", path: "tx>execute[0:0x10]>v4[0:0x0e]" });
    expect(await judge(policy(), { to: MULTICALL3, data: aggregate3(UR21, signed([SWEEP(WETH, MSG_SENDER)])) })).toMatchObject({ code: "ROUTER_PAYOUT_TO_WRAPPER" });
  });
  it("needs its own selector in the router's list", async () => {
    expect(await judge(policy({}, ROUTER_SELECTORS), { to: UR21, data: signed([V3_IN6(MSG_SENDER)]) })).toMatchObject({ code: "SELECTOR_NOT_ALLOWED" });
  });
  it("with allowAnySelector on the router its commands are still opened and judged", async () => {
    const p = parsePolicy({ destinations: { [UR21]: { allowAnySelector: true } } });
    expect(await judge(p, { to: UR21, data: signed([V3_IN6(ATTACKER)]) })).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED" });
    expect((await judge(p, { to: UR21, data: signed([V3_IN6(MSG_SENDER)]) })).allow).toBe(true);
  });
  it("trailing bytes after executeSigned are NON_CANONICAL_ABI", async () => {
    expect(await judge(policy(), { to: UR21, data: (signed([V3_IN6(MSG_SENDER)]) + "00") as Hex })).toMatchObject({ code: "NON_CANONICAL_ABI" });
  });
  it("on a 2.0 router the commands inside are read with the 2.0 layout", async () => {
    expect(await judge(policy(), { to: UR20, data: signed([V3_IN6(MSG_SENDER)]) })).toMatchObject({ code: "NON_CANONICAL_ABI" });
  });
});

describe("V4_SWAP on 2.1: payouts", () => {
  it("a user-paid exact-in swap paying msgSender() is allowed, directly and with MSG_SENDER / the sender", async () => {
    for (const take of [A.TAKE_ALL(WETH), A.TAKE(WETH, MSG_SENDER), A.TAKE(WETH, AGENT), A.TAKE(WETH, MSG_SENDER, 7n)]) {
      const v = await judge(policy(), { to: UR21, data: plan([v4([A.IN_SINGLE(TOKEN, WETH, 100n), A.SETTLE_ALL(TOKEN), take])]) });
      expect(v.allow, v.reason).toBe(true);
    }
    for (const swap of [A.IN(TOKEN, [WETH], 100n), A.OUT_SINGLE(TOKEN, WETH, 5n), A.OUT(WETH, [TOKEN], 5n), A.IN(TOKEN, [RECIPIENT, WETH], 100n, [1n, 2n])]) {
      const v = await judge(policy(), { to: UR21, data: plan([v4([swap, A.SETTLE(TOKEN, OPEN, true), A.TAKE_ALL(WETH)])]) });
      expect(v.allow, v.reason).toBe(true);
    }
  });
  it("TAKE and TAKE_PORTION to anyone else are ROUTER_RECIPIENT_NOT_ALLOWED, unless listed", async () => {
    const bad = [A.TAKE(WETH, ATTACKER), A.TAKE_PORTION(WETH, ATTACKER), A.TAKE(WETH, ATTACKER, 3n)];
    for (const a of bad) {
      expect(await judge(policy(), { to: UR21, data: plan([userSwap([a])]) })).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED", path: `tx>execute[0:0x10]>v4[3:0x${a[0].toString(16).padStart(2, "0")}]` });
    }
    const p = policy({ universalRouter: { recipients: [RECIPIENT] } });
    expect((await judge(p, { to: UR21, data: plan([userSwap([A.TAKE_PORTION(WETH, RECIPIENT)])]) })).allow).toBe(true);
  });
  it("through Multicall3, TAKE_ALL and MSG_SENDER pay Multicall3: ROUTER_PAYOUT_TO_WRAPPER", async () => {
    for (const take of [A.TAKE_ALL(WETH), A.TAKE(WETH, MSG_SENDER), A.TAKE(WETH, MULTICALL3), A.TAKE_PORTION(WETH, MSG_SENDER)]) {
      const v = await judge(policy(), { to: MULTICALL3, data: aggregate3(UR21, plan([v4([A.IN_SINGLE(TOKEN, WETH, 100n), A.SETTLE_ALL(TOKEN), take])])) });
      expect(v, show(v)).toMatchObject({ code: "ROUTER_PAYOUT_TO_WRAPPER", path: `tx>aggregate3[0]>execute[0:0x10]>v4[2:0x${take[0].toString(16).padStart(2, "0")}]` });
    }
    // The explicit sender is fine through Multicall3.
    const v = await judge(policy(), { to: MULTICALL3, data: aggregate3(UR21, plan([v4([A.IN_SINGLE(TOKEN, WETH, 100n), A.SETTLE_ALL(TOKEN), A.TAKE(WETH, AGENT)])])) });
    expect(v.allow, show(v)).toBe(true);
  });
  it("a payout in an allow-revert V4_SWAP (0x90) is still judged", async () => {
    expect(await judge(policy(), { to: UR21, data: plan([v4([A.TAKE(WETH, ATTACKER)], "0x90")]) })).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED", path: "tx>execute[0:0x10]>v4[0:0x0e]" });
  });
});

describe("V4_SWAP on 2.1: funds taken into the router or paid from it", () => {
  const stranded = async (tx: Parameters<typeof sign>[0], path: string) => {
    const v = await judge(policy(), tx);
    expect(v, show(v)).toMatchObject({ allow: false, code: "ROUTER_OUTPUT_STRANDED", path });
  };
  it("TAKE to ADDRESS_THIS (or the router's address) must be swept out", async () => {
    for (const to of [ADDRESS_THIS, UR21]) {
      await stranded({ to: UR21, data: plan([userSwap([A.TAKE(TOKEN, to)])]) }, "tx>execute[0:0x10]>v4[3:0x0e]");
      await stranded({ to: UR21, data: plan([userSwap([A.TAKE_PORTION(TOKEN, to)])]) }, "tx>execute[0:0x10]>v4[3:0x10]");
      expect((await judge(policy(), { to: UR21, data: plan([userSwap([A.TAKE(TOKEN, to)]), SWEEP(TOKEN, MSG_SENDER)]) })).allow).toBe(true);
    }
  });
  it("a known amount taken into the router can be paid out by a later router-paid settle of that amount", async () => {
    const data = plan([v4([A.TAKE(WETH, ADDRESS_THIS, 9n)]), v4([A.IN_SINGLE(WETH, TOKEN, 9n), A.SETTLE(WETH, 9n, false), A.TAKE_ALL(TOKEN)])]);
    const v = await judge(policy(), { to: UR21, data });
    expect(v.allow, v.reason).toBe(true);
    await stranded({ to: UR21, data: plan([v4([A.TAKE(WETH, ADDRESS_THIS, 9n)]), v4([A.IN_SINGLE(WETH, TOKEN, 8n), A.SETTLE(WETH, 8n, false), A.TAKE_ALL(TOKEN)])]) }, "tx>execute[0:0x10]>v4[0:0x0e]");
  });
  it("ETH sent with the call is spent by an ETH settle of the open delta when exact-in amounts cover it", async () => {
    // As the 2.1.2 SDK and app encode it: SETTLE(ETH, OPEN_DELTA, payerIsUser=true). Native ETH is paid
    // from the router's balance whatever payerIsUser says.
    for (const payerIsUser of [true, false]) {
      const data = plan([v4([A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.SETTLE(ETH_C, OPEN, payerIsUser), A.TAKE_ALL(TOKEN)])]);
      const v = await judge(policy(), { to: UR21, value: 1000n, data });
      expect(v.allow, v.reason).toBe(true);
    }
    const viaAll = plan([v4([A.IN(ETH_C, [TOKEN], 1000n), A.SETTLE_ALL(ETH_C), A.TAKE_ALL(TOKEN)])]);
    expect((await judge(policy(), { to: UR21, value: 1000n, data: viaAll })).allow).toBe(true);
    for (const settle of [A.SETTLE(ETH_C, CONTRACT_BALANCE, true), A.SETTLE(ETH_C, 1000n, true)]) {
      const v = await judge(policy(), { to: UR21, value: 1000n, data: plan([v4([A.IN_SINGLE(ETH_C, TOKEN, OPEN), settle, A.TAKE_ALL(TOKEN)])]) });
      expect(v.allow, v.reason).toBe(true);
    }
  });
  it("the open delta is the sum of every exact-in amount in that currency", async () => {
    const two = (b: bigint) => plan([v4([A.IN_SINGLE(ETH_C, TOKEN, 600n), A.IN(ETH_C, [WETH], b), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN), A.TAKE_ALL(WETH)])]);
    const v = await judge(policy(), { to: UR21, value: 1000n, data: two(400n) });
    expect(v.allow, v.reason).toBe(true);
    await stranded({ to: UR21, value: 1000n, data: two(399n) }, "tx>execute");
  });
  it("ETH left over after the settle is ROUTER_OUTPUT_STRANDED unless swept", async () => {
    const data = (amt: bigint) => plan([v4([A.IN_SINGLE(ETH_C, TOKEN, amt), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)])]);
    await stranded({ to: UR21, value: 1000n, data: data(999n) }, "tx>execute");
    await stranded({ to: UR21, value: 1000n, data: plan([v4([A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.SETTLE(ETH_C, 999n, true), A.TAKE_ALL(TOKEN)])]) }, "tx>execute");
    const swept = plan([v4([A.IN_SINGLE(ETH_C, TOKEN, 999n), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)]), SWEEP(ETH_C, MSG_SENDER)]);
    expect((await judge(policy(), { to: UR21, value: 1000n, data: swept })).allow).toBe(true);
  });
  it("an open-delta settle doesn't count when a credit in the same currency could net against it", async () => {
    // Each is a plan where the router would pay less than the exact-in amounts, keeping the rest.
    const cases: Act[][] = [
      // ETH is also a swap output: the second swap's ETH credit nets against the first's debt.
      [A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.IN_SINGLE(TOKEN, ETH_C, 50n), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)],
      // ETH is an intermediate hop of a path.
      [A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.IN(TOKEN, [ETH_C, WETH], 50n), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN), A.TAKE_ALL(WETH)],
      // A multi-hop exact-out swap whose output is ETH.
      [A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.OUT(ETH_C, [WETH], 1n), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN), A.SETTLE_ALL(WETH)],
      // An exact-out swap in ETH: its debt isn't known.
      [A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.OUT_SINGLE(ETH_C, WETH, 1n), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)],
      // A take of ETH out of the pool manager.
      [A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.TAKE(ETH_C, MSG_SENDER, 1n), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)],
      // Two settles of ETH: an explicit one and the open delta.
      [A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.SETTLE(ETH_C, 1n, true), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)],
      // Two open-delta settles.
      [A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.SETTLE(ETH_C, OPEN, true), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)],
      // An exact-in swap with amountIn OPEN_DELTA uses the open delta: its amount isn't known.
      [A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.IN_SINGLE(ETH_C, WETH, OPEN), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)],
      [A.IN(ETH_C, [TOKEN], OPEN), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)],
    ];
    for (const acts of cases) await stranded({ to: UR21, value: 1000n, data: plan([v4(acts)]) }, "tx>execute");
  });
  it("a user-paid settle never empties what the router holds", async () => {
    // WETH from a V3 swap into the router, then a V4 swap the user pays for: the WETH is still there.
    await stranded({ to: UR21, data: plan([V3_IN6(ADDRESS_THIS), v4([A.IN_SINGLE(WETH, TOKEN, 5n), A.SETTLE(WETH, OPEN, true), A.TAKE_ALL(TOKEN)])]) }, "tx>execute[0:0x00]");
    await stranded({ to: UR21, data: plan([V3_IN6(ADDRESS_THIS), v4([A.IN_SINGLE(WETH, TOKEN, 5n), A.SETTLE_ALL(WETH), A.TAKE_ALL(TOKEN)])]) }, "tx>execute[0:0x00]");
  });
  it("router-paid settles of an ERC-20 held in an unknown amount: only CONTRACT_BALANCE empties it", async () => {
    const ok = plan([V3_IN6(ADDRESS_THIS), v4([A.IN_SINGLE(WETH, TOKEN, OPEN), A.SETTLE(WETH, CONTRACT_BALANCE, false), A.TAKE_ALL(TOKEN)])]);
    expect((await judge(policy(), { to: UR21, data: ok })).allow).toBe(true);
    for (const settle of [A.SETTLE(WETH, OPEN, false), A.SETTLE(WETH, 5n, false)]) {
      await stranded({ to: UR21, data: plan([V3_IN6(ADDRESS_THIS), v4([A.IN_SINGLE(WETH, TOKEN, 5n), settle, A.TAKE_ALL(TOKEN)])]) }, "tx>execute[0:0x00]");
    }
  });
  it("an allow-revert V4_SWAP (0x90) can't count as spending the ETH sent", async () => {
    await stranded({ to: UR21, value: 1000n, data: plan([v4([A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)], "0x90")]) }, "tx>execute");
    const v = await judge(policy(), { to: UR21, value: 1000n, data: plan([v4([A.IN_SINGLE(ETH_C, TOKEN, 1000n), A.SETTLE(ETH_C, OPEN, true), A.TAKE_ALL(TOKEN)])]) });
    expect(v.allow, v.reason).toBe(true);
  });
});

describe("V4_SWAP on 2.1: hooks", () => {
  it("a pool key or path hop with a hook is ROUTER_V4_HOOK_NOT_ALLOWED", async () => {
    const cases: [Act, number][] = [
      [A.IN_SINGLE(TOKEN, WETH, 100n, HOOK), 0x06],
      [A.OUT_SINGLE(TOKEN, WETH, 1n, HOOK), 0x08],
      [A.IN(TOKEN, [WETH], 100n, [], HOOK), 0x07],
    ];
    for (const [swap, a] of cases) {
      const v = await judge(policy(), { to: UR21, data: plan([v4([swap, A.SETTLE_ALL(TOKEN), A.TAKE_ALL(WETH)])]) });
      expect(v).toMatchObject({
        allow: false,
        code: "ROUTER_V4_HOOK_NOT_ALLOWED",
        path: `tx>execute[0:0x10]>v4[0:0x0${a}]`,
        reason: `V4 pool uses hook ${HOOK}, which is not in universalRouter.v4Hooks; a hook runs its own code inside the swap and can change the amounts`,
      });
    }
  });
  it("a hook listed in universalRouter.v4Hooks is allowed, and only that one", async () => {
    const p = policy({ universalRouter: { v4Hooks: [HOOK] } });
    expect((await judge(p, { to: UR21, data: plan([v4([A.IN_SINGLE(TOKEN, WETH, 100n, HOOK), A.SETTLE_ALL(TOKEN), A.TAKE_ALL(WETH)])]) })).allow).toBe(true);
    expect((await judge(p, { to: UR21, data: plan([v4([A.IN(TOKEN, [WETH], 100n, [], HOOK), A.SETTLE_ALL(TOKEN), A.TAKE_ALL(WETH)])]) })).allow).toBe(true);
    const other = "0x0000000000000000000000000000000000005555" as Address;
    expect(await judge(p, { to: UR21, data: plan([v4([A.IN_SINGLE(TOKEN, WETH, 100n, other), A.SETTLE_ALL(TOKEN), A.TAKE_ALL(WETH)])]) })).toMatchObject({ code: "ROUTER_V4_HOOK_NOT_ALLOWED" });
  });
  it("a listed hook doesn't excuse a bad payout", async () => {
    const p = policy({ universalRouter: { v4Hooks: [HOOK] } });
    expect(await judge(p, { to: UR21, data: plan([v4([A.IN_SINGLE(TOKEN, WETH, 100n, HOOK), A.SETTLE_ALL(TOKEN), A.TAKE(WETH, ATTACKER)])]) })).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED" });
  });
  it("the policy loader checks universalRouter.v4Hooks", () => {
    expect(parsePolicy({ universalRouter: { v4Hooks: [HOOK] } }).universalRouter.v4Hooks).toEqual(new Set([HOOK.toLowerCase()]));
    expect(parsePolicy({}).universalRouter.v4Hooks).toEqual(new Set());
    expect(() => parsePolicy({ universalRouter: { v4Hooks: [ETH_C] } })).toThrow(PolicyError);
    expect(() => parsePolicy({ universalRouter: { v4Hooks: [ETH_C] } })).toThrow(/is "no hook", which is always allowed/);
    expect(() => parsePolicy({ universalRouter: { v4Hooks: ["0x1234"] } })).toThrow(PolicyError);
    expect(() => parsePolicy({ universalRouter: { v4Hooks: HOOK } })).toThrow(PolicyError);
    expect(() => parsePolicy({ universalRouter: { v4hooks: [HOOK] } })).toThrow(PolicyError);
  });
});

describe("V4_SWAP on 2.1: encodings and actions the guard can't check", () => {
  const swapWith = (acts: readonly Act[]) => plan([v4(acts)]);
  it("an action the 2.1 router doesn't run in V4_SWAP is ROUTER_COMMAND_UNCHECKED", async () => {
    // INCREASE_LIQUIDITY, MINT_POSITION, SETTLE_PAIR, CLOSE_CURRENCY, SWEEP, WRAP, UNWRAP, and others.
    for (const a of [0x00, 0x02, 0x0d, 0x11, 0x12, 0x14, 0x15, 0x16, 0xff]) {
      const v = await judge(policy(), { to: UR21, data: swapWith([[a, "0x"]]) });
      expect(v, show(v)).toMatchObject({ code: "ROUTER_COMMAND_UNCHECKED", path: `tx>execute[0:0x10]>v4[0:0x${a.toString(16).padStart(2, "0")}]`, reason: `V4 action 0x${a.toString(16).padStart(2, "0")} can't be checked by the guard` });
    }
  });
  it("actions and params of different lengths are MALFORMED_BATCH", async () => {
    const [, settle] = A.SETTLE_ALL(TOKEN);
    expect(await judge(policy(), { to: UR21, data: plan([["0x10", enc("bytes, bytes[]", ["0x0c0f", [settle]])]]) })).toMatchObject({ code: "MALFORMED_BATCH", path: "tx>execute[0:0x10]" });
    expect(await judge(policy(), { to: UR21, data: plan([["0x10", enc("bytes, bytes[]", ["0x0c", [settle, settle]])]]) })).toMatchObject({ code: "MALFORMED_BATCH" });
  });
  it("padded params, dirty words and trailing bytes are NON_CANONICAL_ABI", async () => {
    const [a, params] = A.TAKE_ALL(WETH);
    const word = (x: string) => x.padStart(64, "0");
    const cases: Act[] = [
      [a, (params + "00".repeat(32)) as Hex], // an extra word
      [a, (params + "00") as Hex], // one trailing byte
      [0x0e, `0x${word("ff" + "00".repeat(19) + WETH.slice(2).toLowerCase().slice(2))}${word(AGENT.slice(2))}${word("0")}`], // dirty address
      [0x0b, `0x${word(TOKEN.slice(2))}${word("0")}${word("2")}`], // a bool that is 2
      [0x06, (A.IN_SINGLE(TOKEN, WETH, 100n)[1] + "00".repeat(32)) as Hex], // swap struct with a trailing word
    ];
    for (const act of cases) {
      const v = await judge(policy(), { to: UR21, data: swapWith([act]) });
      expect(v, show(v)).toMatchObject({ code: "NON_CANONICAL_ABI", path: `tx>execute[0:0x10]>v4[0:0x${act[0].toString(16).padStart(2, "0")}]` });
    }
    // Trailing bytes after the V4_SWAP input itself.
    const [c, input] = userSwap();
    expect(await judge(policy(), { to: UR21, data: plan([[c, (input + "00".repeat(32)) as Hex]]) })).toMatchObject({ code: "NON_CANONICAL_ABI", path: "tx>execute[0:0x10]" });
  });
  it("the 2.0 V4 struct (no minHopPriceX36) is NON_CANONICAL_ABI on 2.1", async () => {
    const k = poolKey(TOKEN, WETH);
    const old = enc(`(${PK},bool,uint128,uint128,bytes)`, [[k, true, 100n, 0n, "0x"]]);
    expect(await judge(policy(), { to: UR21, data: swapWith([[0x06, old], A.SETTLE_ALL(TOKEN), A.TAKE_ALL(WETH)]) })).toMatchObject({ code: "NON_CANONICAL_ABI", path: "tx>execute[0:0x10]>v4[0:0x06]" });
  });
  it("an empty V4 path, or minHopPriceX36 of the wrong length, is NON_CANONICAL_ABI", async () => {
    expect(await judge(policy(), { to: UR21, data: swapWith([A.IN(TOKEN, [], 5n), A.SETTLE_ALL(TOKEN)]) })).toMatchObject({ code: "NON_CANONICAL_ABI", reason: "V4 swap path is empty", path: "tx>execute[0:0x10]>v4[0:0x07]" });
    expect(await judge(policy(), { to: UR21, data: swapWith([A.OUT(WETH, [], 5n), A.SETTLE_ALL(TOKEN)]) })).toMatchObject({ code: "NON_CANONICAL_ABI", reason: "V4 swap path is empty" });
    expect(await judge(policy(), { to: UR21, data: swapWith([A.IN(TOKEN, [WETH], 5n, [1n, 2n]), A.SETTLE_ALL(TOKEN), A.TAKE_ALL(WETH)]) })).toMatchObject({
      code: "NON_CANONICAL_ABI",
      reason: "minHopPriceX36 has 2 entries for a 1-hop path; it must be empty or have one per hop",
    });
    expect(await judge(policy(), { to: UR21, data: swapWith([A.OUT(WETH, [TOKEN, RECIPIENT], 5n, [1n]), A.SETTLE_ALL(RECIPIENT), A.TAKE_ALL(WETH)]) })).toMatchObject({ code: "NON_CANONICAL_ABI" });
  });
  it("an empty V4_SWAP (no actions) moves nothing", async () => {
    expect((await judge(policy(), { to: UR21, data: swapWith([]) })).allow).toBe(true);
  });
});

describe("through the proxy", () => {
  it("a hooked V4 pool is a -32083 ROUTER_V4_HOOK_NOT_ALLOWED with a hint, and nothing is forwarded", async () => {
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xok" }));
    const config = {
      listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base",
      guard: new Guard({ policy: policy(), store: new MemoryStore() }),
      chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } },
    } as unknown as GuardConfig;
    const raw = await sign({ to: UR21, data: plan([v4([A.IN_SINGLE(TOKEN, WETH, 100n, HOOK), A.SETTLE_ALL(TOKEN), A.TAKE_ALL(WETH)])]), nonce: 0 });
    const r = await handleRequest(config, { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] } as never, undefined, { simulate: vi.fn(), forward } as never);
    expect(r.error?.code).toBe(-32083);
    expect(r.error?.data).toMatchObject({
      policyCode: "ROUTER_V4_HOOK_NOT_ALLOWED",
      hint: 'The swap routes through a Uniswap V4 pool with a hook the policy doesn\'t list. Route through pools without hooks, or add the hook to "universalRouter.v4Hooks" if you trust its code.',
    });
    expect(forward).not.toHaveBeenCalled();
  });
});
