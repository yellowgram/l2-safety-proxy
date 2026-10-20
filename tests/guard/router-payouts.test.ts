/**
 * Universal Router payouts are bound to the router that runs the command. A payout may go to the
 * sender, one of the agent's accounts, or a listed universalRouter recipient. Not to another contract
 * in the same transaction, such as the Multicall3 that called the router: anyone can take funds left
 * there. The router itself (ADDRESS_THIS) is only a step inside the plan: whatever the plan puts there
 * must leave again by the end of the same plan (ROUTER_OUTPUT_STRANDED), since anyone can sweep it.
 */
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { flattenCalls } from "../../src/guard/calls.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import { Guard } from "../../src/guard/guard.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { handleRequest } from "../../src/proxy/handler.js";
import type { GuardConfig } from "../../src/types/index.js";
import { AGENT, ALLOWED, ATTACKER, CHAIN, MULTICALL3, MULTICALL3_SELECTORS, RECIPIENT, ROUTER, ROUTER_SELECTORS, SAFE, TOKEN, basePolicy, sign } from "./helpers.js";

const MSG_SENDER = "0x0000000000000000000000000000000000000001" as Address;
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;
const ROUTER2 = "0x8888888888888888888888888888888888888888" as Address;
const MULTISEND = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D" as Address; // Safe MultiSendCallOnly 1.3.0
const mc3 = MULTICALL3.toLowerCase();
const router = ROUTER.toLowerCase();
const WETH = "0x4200000000000000000000000000000000000006" as Address; // the router's WETH on Base (CHAIN)
const NATIVE = "0x0000000000000000000000000000000000000000" as Address; // Universal Router's name for ETH
const CONTRACT_BALANCE = 1n << 255n;

const ur = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const enc = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values as never);
/** One Universal Router command paying `to`. */
const cmd = {
  V3_SWAP_EXACT_IN: (to: Address) => ["0x00", enc("address, uint256, uint256, bytes, bool", [to, 1n, 0n, encodePacked(["address", "uint24", "address"], [TOKEN, 500, WETH]), true])],
  V2_SWAP_EXACT_IN: (to: Address) => ["0x08", enc("address, uint256, uint256, address[], bool", [to, 1n, 0n, [TOKEN, WETH], true])],
  SWEEP: (to: Address) => ["0x04", enc("address, address, uint256", [TOKEN, to, 1n])],
  TRANSFER: (to: Address) => ["0x05", enc("address, address, uint256", [TOKEN, to, 1n])],
  PAY_PORTION: (to: Address) => ["0x06", enc("address, address, uint256", [TOKEN, to, 1n])],
  WRAP_ETH: (to: Address) => ["0x0b", enc("address, uint256", [to, 1n])],
  UNWRAP_WETH: (to: Address) => ["0x0c", enc("address, uint256", [to, 1n])],
} as const;
const execute = ([c, input]: readonly [string, Hex] | string[]) => encodeFunctionData({ abi: ur, args: [c as Hex, [input as Hex], 0n] });
/** A plan of several commands, run by execute. */
const plan = (cmds: readonly (readonly [string, Hex] | readonly string[])[]) =>
  encodeFunctionData({ abi: ur, args: [("0x" + cmds.map((c) => c[0]!.slice(2)).join("")) as Hex, cmds.map((c) => c[1] as Hex), 0n] });
const sub = (cmds: readonly (readonly [string, Hex] | readonly string[])[], flag = "0x21") =>
  [flag, enc("bytes, bytes[]", [("0x" + cmds.map((c) => c[0]!.slice(2)).join("")) as Hex, cmds.map((c) => c[1] as Hex)])] as const;
const v3Path = (from: Address, to: Address) => encodePacked(["address", "uint24", "address"], [from, 500, to]);
const V3_IN = (to: Address, amount = 10n ** 18n, payerIsUser = true, from: Address = TOKEN, out: Address = WETH) =>
  ["0x00", enc("address, uint256, uint256, bytes, bool", [to, amount, 0n, v3Path(from, out), payerIsUser])] as const;
/** Exact-output paths are reversed: output token first. */
const V3_OUT = (to: Address, amountInMax: bigint, payerIsUser: boolean, from: Address, out: Address, amountOut = 1n) =>
  ["0x01", enc("address, uint256, uint256, bytes, bool", [to, amountOut, amountInMax, v3Path(out, from), payerIsUser])] as const;
const V2_IN = (to: Address, amount: bigint, payerIsUser: boolean, route: Address[]) =>
  ["0x08", enc("address, uint256, uint256, address[], bool", [to, amount, 0n, route, payerIsUser])] as const;
const SWEEP = (token: Address, to: Address, flag = "0x04") => [flag, enc("address, address, uint256", [token, to, 0n])] as const;
const TRANSFER = (token: Address, to: Address, amount: bigint) => ["0x05", enc("address, address, uint256", [token, to, amount])] as const;
const PAY_PORTION = (token: Address, to: Address, bips: bigint) => ["0x06", enc("address, address, uint256", [token, to, bips])] as const;
const WRAP = (to: Address, amount: bigint) => ["0x0b", enc("address, uint256", [to, amount])] as const;
const UNWRAP = (to: Address) => ["0x0c", enc("address, uint256", [to, 0n])] as const;
const PULL = (token: Address, to: Address, amount: bigint) => ["0x02", enc("address, address, uint160", [token, to, amount])] as const;
const subPlan = ([c, input]: string[]) => encodeFunctionData({ abi: ur, args: ["0x21", [enc("bytes, bytes[]", [c, [input]])], 0n] });
const aggregate3 = (calls: { target: Address; callData: Hex }[]) =>
  encodeFunctionData({
    abi: parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls)"]),
    args: [calls.map((c) => ({ ...c, allowFailure: false }))],
  });
const routerMulticall = (items: Hex[]) => encodeFunctionData({ abi: parseAbi(["function multicall(bytes[])"]), args: [items] });
const execTx = (to: Address, data: Hex, op = 0) =>
  encodeFunctionData({
    abi: parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)"]),
    args: [to, 0n, data, op, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x"],
  });
const multiSend = (to: Address, data: Hex) =>
  encodeFunctionData({
    abi: parseAbi(["function multiSend(bytes)"]),
    args: [encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, to, 0n, BigInt((data.length - 2) / 2), data])],
  });
const batch7702 = (calls: { to: Address; value: bigint; data: Hex }[]) =>
  encodeFunctionData({ abi: parseAbi(["function execute((address to,uint256 value,bytes data)[] calls)"]), args: [calls] });

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
async function judge(policy: ReturnType<typeof basePolicy>, tx: Parameters<typeof sign>[0]) {
  return evaluateTx(policy, await parseSignedTx(await sign(tx)), { chainId: CHAIN, now: 1_000_000 });
}
const viaMulticall3 = (routerCall: Hex) => ({ to: MULTICALL3, data: aggregate3([{ target: ROUTER, callData: routerCall }]) });

describe("exploit: a payout to another contract in the transaction is denied", () => {
  it("Multicall3 → router, SWEEP to Multicall3: ROUTER_PAYOUT_TO_WRAPPER", async () => {
    const v = await judge(basePolicy(), viaMulticall3(execute(cmd.SWEEP(MULTICALL3))));
    expect(v).toMatchObject({ allow: false, code: "ROUTER_PAYOUT_TO_WRAPPER", path: "tx>aggregate3[0]>execute[0:0x04]" });
    expect(v.reason).toBe(`router ${router} pays out to ${mc3}, another contract in this transaction; funds left there can be taken by anyone. Pay the sender instead`);
  });
  it.each(Object.keys(cmd))("Multicall3 → router, %s to Multicall3 is denied", async (name) => {
    const v = await judge(basePolicy(), viaMulticall3(execute(cmd[name as keyof typeof cmd](MULTICALL3))));
    expect(v.code).toBe("ROUTER_PAYOUT_TO_WRAPPER");
  });
  it("Multicall3 → router with the MSG_SENDER constant: the router's msg.sender is Multicall3, so it is denied", async () => {
    const v = await judge(basePolicy(), viaMulticall3(execute(cmd.V3_SWAP_EXACT_IN(MSG_SENDER))));
    expect(v).toMatchObject({ allow: false, code: "ROUTER_PAYOUT_TO_WRAPPER", path: "tx>aggregate3[0]>execute[0:0x00]" });
  });
  it("Multicall3 → router.multicall([execute(MSG_SENDER)]): the entry keeps the router's caller, Multicall3", async () => {
    const v = await judge(basePolicy(), viaMulticall3(routerMulticall([execute(cmd.SWEEP(MSG_SENDER))])));
    expect(v).toMatchObject({ code: "ROUTER_PAYOUT_TO_WRAPPER", path: "tx>aggregate3[0]>multicall[0]>execute[0:0x04]" });
  });
  it("a sub-plan sweeping to Multicall3 is denied", async () => {
    const v = await judge(basePolicy(), viaMulticall3(subPlan([...cmd.SWEEP(MULTICALL3)])));
    expect(v).toMatchObject({ code: "ROUTER_PAYOUT_TO_WRAPPER", path: "tx>aggregate3[0]>execute[0:0x21]>subplan[0:0x04]" });
  });
  it("a sub-plan paying MSG_SENDER inside Multicall3 → router is denied (the sub-plan keeps the router's caller)", async () => {
    const v = await judge(basePolicy(), viaMulticall3(subPlan([...cmd.SWEEP(MSG_SENDER)])));
    expect(v).toMatchObject({ code: "ROUTER_PAYOUT_TO_WRAPPER", path: "tx>aggregate3[0]>execute[0:0x21]>subplan[0:0x04]" });
    expect((await judge(basePolicy(), { to: ROUTER, data: subPlan([...cmd.SWEEP(MSG_SENDER)]) })).allow).toBe(true);
  });
  it("one router paying a second router in the same transaction is denied", async () => {
    const p = basePolicy({
      destinations: { [MULTICALL3]: { selectors: MULTICALL3_SELECTORS }, [ROUTER]: { selectors: ROUTER_SELECTORS }, [ROUTER2]: { selectors: ROUTER_SELECTORS } },
    });
    const data = aggregate3([
      { target: ROUTER, callData: execute(cmd.SWEEP(ROUTER2)) },
      { target: ROUTER2, callData: execute(cmd.SWEEP(MSG_SENDER)) },
    ]);
    const v = await judge(p, { to: MULTICALL3, data });
    expect(v).toMatchObject({ code: "ROUTER_PAYOUT_TO_WRAPPER", path: "tx>aggregate3[0]>execute[0:0x04]" });
    expect(v.reason).toContain(`router ${router} pays out to ${ROUTER2.toLowerCase()}`);
  });
  it("MultiSend called directly → router with MSG_SENDER pays MultiSend: denied", async () => {
    const p = basePolicy({
      destinations: { [MULTISEND]: { selectors: ["multiSend(bytes)"] }, [ROUTER]: { selectors: ROUTER_SELECTORS } },
    });
    const v = await judge(p, { to: MULTISEND, data: multiSend(ROUTER, execute(cmd.SWEEP(MSG_SENDER))) });
    expect(v).toMatchObject({ code: "ROUTER_PAYOUT_TO_WRAPPER", path: "tx>multiSend[0]>execute[0:0x04]" });
  });
  it("a payout to an outsider (not in the transaction) keeps ROUTER_RECIPIENT_NOT_ALLOWED", async () => {
    const v = await judge(basePolicy(), viaMulticall3(execute(cmd.SWEEP(ATTACKER))));
    expect(v).toMatchObject({ code: "ROUTER_RECIPIENT_NOT_ALLOWED", path: "tx>aggregate3[0]>execute[0:0x04]" });
    expect(v.reason).toBe(`router ${router} pays out to ${ATTACKER}, which is not the sender or an allowed recipient`);
    expect((await judge(basePolicy(), { to: ROUTER, data: execute(cmd.SWEEP(MULTICALL3)) })).code).toBe("ROUTER_RECIPIENT_NOT_ALLOWED");
  });
});

describe("legitimate payouts still pass", () => {
  it("direct router call: MSG_SENDER and the explicit sender", async () => {
    for (const to of [MSG_SENDER, AGENT]) {
      const v = await judge(basePolicy(), { to: ROUTER, data: execute(cmd.V3_SWAP_EXACT_IN(to)) });
      expect(v.allow, `${to}: ${v.reason}`).toBe(true);
    }
  });
  it("direct router call: a swap to the router itself (ADDRESS_THIS or its address) followed by a sweep to the sender", async () => {
    for (const to of [ADDRESS_THIS, ROUTER]) {
      const v = await judge(basePolicy(), { to: ROUTER, data: plan([cmd.V3_SWAP_EXACT_IN(to), SWEEP(WETH, MSG_SENDER)]) });
      expect(v.allow, `${to}: ${v.reason}`).toBe(true);
    }
  });
  it("Multicall3 → router paying the explicit sender; a sweep to the router itself with nothing put there moves nothing", async () => {
    for (const to of [AGENT, ADDRESS_THIS, ROUTER]) {
      const v = await judge(basePolicy(), viaMulticall3(execute(cmd.SWEEP(to))));
      expect(v.allow, `${to}: ${v.reason}`).toBe(true);
    }
  });
  it("a sub-plan sweeping to the router itself, with nothing put there", async () => {
    expect((await judge(basePolicy(), viaMulticall3(subPlan([...cmd.SWEEP(ADDRESS_THIS)])))).allow).toBe(true);
  });
  it("router.multicall([execute(MSG_SENDER)]) sent directly pays the sender", async () => {
    expect((await judge(basePolicy(), { to: ROUTER, data: routerMulticall([execute(cmd.SWEEP(MSG_SENDER))]) })).allow).toBe(true);
  });
  it("a listed universalRouter recipient, also inside Multicall3", async () => {
    const p = basePolicy({ universalRouter: { recipients: [RECIPIENT] } });
    expect((await judge(p, viaMulticall3(execute(cmd.SWEEP(RECIPIENT))))).allow).toBe(true);
  });
  it("Multicall3 explicitly listed as a universalRouter recipient is the owner's call", async () => {
    const p = basePolicy({ universalRouter: { recipients: [MULTICALL3] } });
    expect((await judge(p, viaMulticall3(execute(cmd.SWEEP(MULTICALL3))))).allow).toBe(true);
  });
  it("the agent's Safe → router: MSG_SENDER is the Safe (one of accounts), allowed", async () => {
    const p = basePolicy({ accounts: [SAFE] });
    expect((await judge(p, { to: SAFE, data: execTx(ROUTER, execute(cmd.SWEEP(MSG_SENDER))) })).allow).toBe(true);
    // Through the Safe's DELEGATECALL to MultiSend the entries run as the Safe too.
    const v = await judge(p, { to: SAFE, data: execTx(MULTISEND, multiSend(ROUTER, execute(cmd.SWEEP(MSG_SENDER))), 1) });
    expect(v.allow, v.reason).toBe(true);
  });
  it("a direct swap paying the agent's Safe (one of accounts, not in the transaction)", async () => {
    expect((await judge(basePolicy({ accounts: [SAFE] }), { to: ROUTER, data: execute(cmd.SWEEP(SAFE)) })).allow).toBe(true);
    expect((await judge(basePolicy(), { to: ROUTER, data: execute(cmd.SWEEP(SAFE)) })).code).toBe("ROUTER_RECIPIENT_NOT_ALLOWED");
  });
  it("the agent's own 7702 batch → router with MSG_SENDER pays the agent", async () => {
    const v = await judge(basePolicy(), { to: AGENT, data: batch7702([{ to: ROUTER, value: 0n, data: execute(cmd.SWEEP(MSG_SENDER)) }]) });
    expect(v.allow, v.reason).toBe(true);
  });
});

describe("funds left in the router itself are denied (ROUTER_OUTPUT_STRANDED)", () => {
  const stranded = async (tx: Parameters<typeof sign>[0], path: string, policy = basePolicy()) => {
    const v = await judge(policy, tx);
    expect(v, show(v)).toMatchObject({ allow: false, code: "ROUTER_OUTPUT_STRANDED", path });
    return v;
  };
  it("direct: a swap to ADDRESS_THIS and nothing after it", async () => {
    const v = await stranded({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS)]) }, "tx>execute[0:0x00]");
    expect(v.reason).toBe(
      `the output of swap tx>execute[0:0x00] (WETH) is left in router ${ROUTER} when the plan ends, and anyone can take a balance left in the router. End the plan with SWEEP or UNWRAP_WETH to MSG_SENDER`
    );
  });
  it("direct: a swap to ADDRESS_THIS, then a sweep back to ADDRESS_THIS (moves nothing)", async () => {
    await stranded({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), SWEEP(WETH, ADDRESS_THIS)]) }, "tx>execute[0:0x00]");
    await stranded({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), SWEEP(WETH, ROUTER)]) }, "tx>execute[0:0x00]");
  });
  it("inside Multicall3: a swap to ADDRESS_THIS only", async () => {
    await stranded(viaMulticall3(plan([V3_IN(ADDRESS_THIS)])), "tx>aggregate3[0]>execute[0:0x00]");
  });
  it("a swap to the router's own address only", async () => {
    await stranded({ to: ROUTER, data: plan([V3_IN(ROUTER)]) }, "tx>execute[0:0x00]");
  });
  it("V2 and exact-output swaps to ADDRESS_THIS only", async () => {
    await stranded({ to: ROUTER, data: plan([V2_IN(ADDRESS_THIS, 1n, true, [TOKEN, WETH])]) }, "tx>execute[0:0x08]");
    await stranded({ to: ROUTER, data: plan([V3_OUT(ADDRESS_THIS, 5n, true, TOKEN, WETH)]) }, "tx>execute[0:0x01]");
    await stranded({ to: ROUTER, data: plan([["0x09", enc("address, uint256, uint256, address[], bool", [ADDRESS_THIS, 1n, 5n, [TOKEN, WETH], true])]]) }, "tx>execute[0:0x09]");
  });
  it("a sweep of a different token leaves the swap output there", async () => {
    await stranded({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), SWEEP(TOKEN, MSG_SENDER)]) }, "tx>execute[0:0x00]");
  });
  it("a sweep before the swap is too early", async () => {
    await stranded({ to: ROUTER, data: plan([SWEEP(WETH, MSG_SENDER), V3_IN(ADDRESS_THIS)]) }, "tx>execute[1:0x00]");
  });
  it("TRANSFER or PAY_PORTION of part of the output does not empty the router", async () => {
    await stranded({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), TRANSFER(WETH, AGENT, 1n)]) }, "tx>execute[0:0x00]");
    await stranded({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), PAY_PORTION(WETH, AGENT, 10_000n)]) }, "tx>execute[0:0x00]");
  });
  it("UNWRAP_WETH settles only WETH, not another token", async () => {
    await stranded({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS, 1n, true, WETH, TOKEN), UNWRAP(MSG_SENDER)]) }, "tx>execute[0:0x00]");
  });
  it("UNWRAP_WETH to ADDRESS_THIS leaves the ETH there", async () => {
    await stranded({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), UNWRAP(ADDRESS_THIS)]) }, "tx>execute[1:0x0c]");
  });
  it("WRAP_ETH to ADDRESS_THIS with nothing using the WETH", async () => {
    await stranded({ to: ROUTER, value: 5n, data: plan([WRAP(ADDRESS_THIS, 5n)]) }, "tx>execute[0:0x0b]");
  });
  it("ETH sent with the call and not used, or only partly wrapped", async () => {
    const v = await stranded({ to: ROUTER, value: 5n, data: plan([V3_IN(MSG_SENDER)]) }, "tx>execute");
    expect(v.reason).toContain("5 wei of ETH sent with the call (ETH)");
    await stranded({ to: ROUTER, value: 5n, data: plan([WRAP(MSG_SENDER, 4n)]) }, "tx>execute");
  });
  it("tokens pulled into the router with Permit2 and not used", async () => {
    await stranded({ to: ROUTER, data: plan([PULL(TOKEN, ADDRESS_THIS, 7n)]) }, "tx>execute[0:0x02]");
  });
  it("a router-paid swap of only part of the pulled tokens leaves the rest there", async () => {
    await stranded({ to: ROUTER, data: plan([PULL(TOKEN, ADDRESS_THIS, 7n), V3_IN(MSG_SENDER, 6n, false)]) }, "tx>execute[0:0x02]");
  });
  it("an exact-output swap the router pays for may leave input behind", async () => {
    // Whatever its amounts, an exact-output swap spends at most amountInMax, so it never counts as emptying the router.
    await stranded({ to: ROUTER, data: plan([PULL(TOKEN, ADDRESS_THIS, 7n), V3_OUT(MSG_SENDER, 7n, false, TOKEN, WETH)]) }, "tx>execute[0:0x02]");
    await stranded({ to: ROUTER, data: plan([PULL(TOKEN, ADDRESS_THIS, 7n), V3_OUT(MSG_SENDER, 7n, false, TOKEN, WETH, 7n)]) }, "tx>execute[0:0x02]");
    await stranded({ to: ROUTER, data: plan([PULL(TOKEN, ADDRESS_THIS, 7n), V3_OUT(MSG_SENDER, CONTRACT_BALANCE, false, TOKEN, WETH, CONTRACT_BALANCE)]) }, "tx>execute[0:0x02]");
  });
  it("a sweep flagged allow-revert, or inside an allow-revert sub-plan, may silently fail and does not count", async () => {
    await stranded({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), SWEEP(WETH, MSG_SENDER, "0x84")]) }, "tx>execute[0:0x00]");
    await stranded({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), sub([SWEEP(WETH, MSG_SENDER)], "0xa1")]) }, "tx>execute[0:0x00]");
  });
  it("a sweep in a second router call does not settle the first (each execute is checked on its own)", async () => {
    const p = basePolicy({ universalRouter: { recipients: [] } });
    const data = aggregate3([
      { target: ROUTER, callData: plan([V3_IN(ADDRESS_THIS)]) },
      { target: ROUTER, callData: plan([SWEEP(WETH, AGENT)]) },
    ]);
    await stranded({ to: MULTICALL3, data }, "tx>aggregate3[0]>execute[0:0x00]", p);
    await stranded({ to: ROUTER, data: routerMulticall([plan([V3_IN(ADDRESS_THIS)]), plan([SWEEP(WETH, MSG_SENDER)])]) }, "tx>multicall[0]>execute[0:0x00]");
  });
  it("ETH sent to router.multicall reaches each delegatecalled execute", async () => {
    await stranded({ to: ROUTER, value: 5n, data: routerMulticall([plan([V3_IN(MSG_SENDER)])]) }, "tx>multicall[0]>execute");
  });
  it("through the proxy: -32083 with a hint, nothing forwarded", async () => {
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xok" }));
    const config = {
      listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base",
      guard: new Guard({ policy: basePolicy(), store: new MemoryStore() }),
      chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } },
    } as unknown as GuardConfig;
    const raw = await sign({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS)]), nonce: 0 });
    const r = await handleRequest(config, { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] } as never, undefined, { simulate: vi.fn(), forward } as never);
    expect(r.error?.code).toBe(-32083);
    expect(r.error?.data).toMatchObject({
      policyCode: "ROUTER_OUTPUT_STRANDED",
      hint: "The swap plan leaves funds in the Universal Router, where anyone could take them. End the plan with SWEEP (or UNWRAP_WETH) to MSG_SENDER.",
    });
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("a V3 path the router reads differently can't mis-key the swap output", () => {
  // The router reads a path under 66 bytes as one pool (bytes 0..43) and ignores the rest, so the
  // last 20 bytes of a padded path name a token the swap never produces.
  const USDC = "0x8888888888888888888888888888888888888888" as Address;
  const swap = (cmdByte: string, route: Hex) => [cmdByte, enc("address, uint256, uint256, bytes, bool", [ADDRESS_THIS, 10n ** 18n, 0n, route, true])] as const;
  const junkPath = (tin: Address, tout: Address, decoy: Address) => (v3Path(tin, tout) + "0000" + decoy.slice(2)) as Hex; // 65 bytes
  const denied = async (data: Hex, code = "NON_CANONICAL_ABI") => {
    const v = await judge(basePolicy(), { to: ROUTER, data });
    expect(v, show(v)).toMatchObject({ allow: false, code });
    return v;
  };
  it("TOKEN|500|WETH|0000|USDC then SWEEP(USDC): denied (WETH would stay in the router)", async () => {
    const v = await denied(plan([swap("0x00", junkPath(TOKEN, WETH, USDC)), SWEEP(USDC, MSG_SENDER)]));
    expect(v.path).toBe("tx>execute[0:0x00]");
    expect(v.reason).toContain("V3 path of 65 bytes");
  });
  it("TOKEN|500|USDC|0000|WETH then UNWRAP_WETH: denied (USDC would stay in the router)", async () => {
    await denied(plan([swap("0x00", junkPath(TOKEN, USDC, WETH)), UNWRAP(MSG_SENDER)]));
  });
  it("the padded path with nothing after it is denied", async () => {
    await denied(plan([swap("0x00", junkPath(TOKEN, WETH, USDC))]));
  });
  it("a multi-hop path with one extra byte is denied", async () => {
    const p = (encodePacked(["address", "uint24", "address", "uint24", "address"], [TOKEN, 500, USDC, 500, WETH]) + "00") as Hex;
    await denied(plan([swap("0x00", p), UNWRAP(MSG_SENDER)]));
  });
  it("exact-output paths get the same check", async () => {
    await denied(plan([swap("0x01", junkPath(WETH, TOKEN, USDC)), SWEEP(WETH, MSG_SENDER)]));
  });
  it("the same plans with a well-formed path still settle", async () => {
    expect((await judge(basePolicy(), { to: ROUTER, data: plan([swap("0x00", v3Path(TOKEN, WETH)), SWEEP(WETH, MSG_SENDER)]) })).allow).toBe(true);
    const hops = encodePacked(["address", "uint24", "address", "uint24", "address"], [TOKEN, 500, USDC, 500, WETH]);
    expect((await judge(basePolicy(), { to: ROUTER, data: plan([swap("0x00", hops), UNWRAP(MSG_SENDER)]) })).allow).toBe(true);
    // The real output of TOKEN|500|WETH is WETH, so sweeping USDC leaves it stranded.
    await denied(plan([swap("0x00", v3Path(TOKEN, WETH)), SWEEP(USDC, MSG_SENDER)]), "ROUTER_OUTPUT_STRANDED");
  });
  it("exact output to ADDRESS_THIS credits the output (the path's first token): sweeping only the input is denied", async () => {
    // Exact-output paths are reversed: WETH|500|TOKEN buys WETH with TOKEN.
    await denied(plan([swap("0x01", v3Path(WETH, TOKEN)), SWEEP(TOKEN, MSG_SENDER)]), "ROUTER_OUTPUT_STRANDED");
    expect((await judge(basePolicy(), { to: ROUTER, data: plan([swap("0x01", v3Path(WETH, TOKEN)), SWEEP(WETH, MSG_SENDER)]) })).allow).toBe(true);
  });
});

describe("multi-step plans that empty the router still pass", () => {
  const allowed = async (tx: Parameters<typeof sign>[0], policy = basePolicy()) => {
    const v = await judge(policy, tx);
    expect(v.allow, show(v)).toBe(true);
  };
  it("swap to ADDRESS_THIS, then UNWRAP_WETH to MSG_SENDER (token → ETH)", async () => {
    await allowed({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), UNWRAP(MSG_SENDER)]) });
    await allowed({ to: ROUTER, data: plan([V2_IN(ADDRESS_THIS, 1n, true, [TOKEN, WETH]), UNWRAP(AGENT)]) });
  });
  it("swap to ADDRESS_THIS, then SWEEP to MSG_SENDER", async () => {
    await allowed({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), SWEEP(WETH, MSG_SENDER)]) });
  });
  it("fee then rest: PAY_PORTION to a listed recipient, then SWEEP to the sender", async () => {
    await allowed({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), PAY_PORTION(WETH, RECIPIENT, 25n), SWEEP(WETH, MSG_SENDER)]) }, basePolicy({ universalRouter: { recipients: [RECIPIENT] } }));
  });
  it("multi-hop across pools: swap to ADDRESS_THIS, then a router-paid swap of the whole balance to the sender", async () => {
    await allowed({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), V2_IN(MSG_SENDER, CONTRACT_BALANCE, false, [WETH, TOKEN])]) });
    await allowed({ to: ROUTER, data: plan([V2_IN(ADDRESS_THIS, 1n, true, [TOKEN, WETH]), V3_IN(MSG_SENDER, CONTRACT_BALANCE, false, WETH, TOKEN)]) });
  });
  it("ETH in: WRAP_ETH of the value sent to ADDRESS_THIS, then a router-paid swap of that amount", async () => {
    await allowed({ to: ROUTER, value: 5n, data: plan([WRAP(ADDRESS_THIS, 5n), V3_IN(MSG_SENDER, 5n, false, WETH, TOKEN)]) });
    await allowed({ to: ROUTER, value: 5n, data: plan([WRAP(ADDRESS_THIS, CONTRACT_BALANCE), V3_IN(MSG_SENDER, CONTRACT_BALANCE, false, WETH, TOKEN)]) });
  });
  it("ETH in, exact output: wrap the maximum, swap, then UNWRAP_WETH the rest back to the sender", async () => {
    await allowed({ to: ROUTER, value: 5n, data: plan([WRAP(ADDRESS_THIS, 5n), V3_OUT(MSG_SENDER, 5n, false, WETH, TOKEN), UNWRAP(MSG_SENDER)]) });
  });
  it("Permit2 pull into the router, then a router-paid swap of the whole balance", async () => {
    const p = basePolicy({ tokens: { [TOKEN]: { transfer: { recipients: [ROUTER], maxAmountRaw: "1000" } } } });
    await allowed({ to: ROUTER, data: plan([PULL(TOKEN, ADDRESS_THIS, 7n), V3_IN(MSG_SENDER, CONTRACT_BALANCE, false)]) }, p);
    await allowed({ to: ROUTER, data: plan([PULL(TOKEN, ADDRESS_THIS, 7n), V3_IN(MSG_SENDER, 7n, false)]) }, p);
  });
  it("UNWRAP_WETH to ADDRESS_THIS, then SWEEP of ETH to the sender", async () => {
    await allowed({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), UNWRAP(ADDRESS_THIS), SWEEP(NATIVE, MSG_SENDER)]) });
  });
  it("the sweep may sit in a sub-plan that can't revert silently", async () => {
    await allowed({ to: ROUTER, data: plan([V3_IN(ADDRESS_THIS), sub([SWEEP(WETH, MSG_SENDER)])]) });
    await allowed({ to: ROUTER, data: plan([sub([V3_IN(ADDRESS_THIS)]), SWEEP(WETH, MSG_SENDER)]) });
  });
  it("inside Multicall3, sweeping to the explicit sender", async () => {
    await allowed(viaMulticall3(plan([V3_IN(ADDRESS_THIS), SWEEP(WETH, AGENT)])));
  });
});

describe("flattenCalls binds each payout to its router and resolves MSG_SENDER to the router's caller", () => {
  it("records router and resolved recipient per payout", () => {
    const f = flattenCalls(
      { to: MULTICALL3, value: 0n, data: aggregate3([{ target: ROUTER, callData: execute(cmd.SWEEP(MSG_SENDER)) }, { target: ROUTER, callData: execute(cmd.SWEEP(ADDRESS_THIS)) }]) },
      { sender: ALLOWED, accounts: new Set(), permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3" }
    );
    const payouts = f.leaves
      .filter((l) => l.kind === "payout")
      .map((l) => (l.kind === "payout" ? { recipient: l.recipient.toLowerCase(), router: l.router.toLowerCase(), path: l.path } : l));
    expect(payouts).toEqual([
      { recipient: mc3, router, path: "tx>aggregate3[0]>execute[0:0x04]" },
      { recipient: router, router, path: "tx>aggregate3[1]>execute[0:0x04]" },
    ]);
  });
});

describe("through the proxy", () => {
  it("the Multicall3 sweep is a -32083 ROUTER_PAYOUT_TO_WRAPPER with a hint, and nothing is forwarded", async () => {
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xok" }));
    const simulate = vi.fn();
    const config = {
      listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base",
      guard: new Guard({ policy: basePolicy(), store: new MemoryStore() }),
      chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } },
    } as unknown as GuardConfig;
    const raw = await sign({ ...viaMulticall3(execute(cmd.SWEEP(MULTICALL3))), nonce: 0 });
    const r = await handleRequest(config, { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] } as never, undefined, { simulate, forward } as never);
    expect(r.error?.code).toBe(-32083);
    expect(r.error?.data).toMatchObject({
      policyCode: "ROUTER_PAYOUT_TO_WRAPPER",
      path: "tx>aggregate3[0]>execute[0:0x04]",
      hint: "A swap inside a batch pays another contract in the transaction, where anyone could take the funds. Pay the sender's address explicitly.",
    });
    expect(forward).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });
});
