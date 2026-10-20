/**
 * Universal Router payouts are bound to the router that runs the command. A payout may go to the
 * sender, one of the agent's accounts, a listed universalRouter recipient, or that router itself
 * (ADDRESS_THIS), and nowhere else. In particular not to another contract in the same transaction,
 * such as the Multicall3 that called the router: anyone can take funds left there.
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

const ur = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const enc = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values as never);
/** One Universal Router command paying `to`. */
const cmd = {
  V3_SWAP_EXACT_IN: (to: Address) => ["0x00", enc("address, uint256, uint256, bytes, bool", [to, 1n, 0n, "0x", true])],
  V2_SWAP_EXACT_IN: (to: Address) => ["0x08", enc("address, uint256, uint256, address[], bool", [to, 1n, 0n, [], true])],
  SWEEP: (to: Address) => ["0x04", enc("address, address, uint256", [TOKEN, to, 1n])],
  TRANSFER: (to: Address) => ["0x05", enc("address, address, uint256", [TOKEN, to, 1n])],
  PAY_PORTION: (to: Address) => ["0x06", enc("address, address, uint256", [TOKEN, to, 1n])],
  WRAP_ETH: (to: Address) => ["0x0b", enc("address, uint256", [to, 1n])],
  UNWRAP_WETH: (to: Address) => ["0x0c", enc("address, uint256", [to, 1n])],
} as const;
const execute = ([c, input]: readonly [string, Hex] | string[]) => encodeFunctionData({ abi: ur, args: [c as Hex, [input as Hex], 0n] });
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
  it("direct router call: MSG_SENDER, the explicit sender, and ADDRESS_THIS (the router itself)", async () => {
    for (const to of [MSG_SENDER, AGENT, ADDRESS_THIS, ROUTER]) {
      const v = await judge(basePolicy(), { to: ROUTER, data: execute(cmd.V3_SWAP_EXACT_IN(to)) });
      expect(v.allow, `${to}: ${v.reason}`).toBe(true);
    }
  });
  it("Multicall3 → router paying the explicit sender, or the router itself (ADDRESS_THIS)", async () => {
    for (const to of [AGENT, ADDRESS_THIS, ROUTER]) {
      const v = await judge(basePolicy(), viaMulticall3(execute(cmd.SWEEP(to))));
      expect(v.allow, `${to}: ${v.reason}`).toBe(true);
    }
  });
  it("a sub-plan paying the router itself", async () => {
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
