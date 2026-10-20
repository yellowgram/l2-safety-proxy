import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { parsePolicy, PolicyError } from "../../src/guard/policy/load.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import {
  AGENT, ALLOWED, ATTACKER, CHAIN, DELEGATE_OK, ETH, MULTICALL3, PERMIT2, RECIPIENT, ROUTER, SAFE, SPENDER_BAD, SPENDER_OK, TOKEN,
  agent, basePolicy, sign,
} from "./helpers.js";

const erc20 = parseAbi([
  "function transfer(address,uint256)",
  "function approve(address,uint256)",
  "function increaseAllowance(address,uint256)",
  "function setApprovalForAll(address,bool)",
]);
const MAX = (1n << 256n) - 1n;
const approve = (s: Address, a: bigint) => encodeFunctionData({ abi: erc20, functionName: "approve", args: [s, a] });
const p2approve = (s: Address, a: bigint, exp = 0n) =>
  encodeFunctionData({ abi: parseAbi(["function approve(address,address,uint160,uint48)"]), args: [TOKEN, s, a, Number(exp)] });
const aggregate3 = (calls: { target: Address; callData: Hex }[]) =>
  encodeFunctionData({
    abi: parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls)"]),
    args: [calls.map((c) => ({ ...c, allowFailure: false }))],
  });
const execTx = (to: Address, data: Hex, op = 0) =>
  encodeFunctionData({
    abi: parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)"]),
    args: [to, 0n, data, op, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x"],
  });
const batch7702 = (calls: { to: Address; value: bigint; data: Hex }[]) =>
  encodeFunctionData({ abi: parseAbi(["function execute((address to,uint256 value,bytes data)[] calls)"]), args: [calls] });

async function judge(policy: ReturnType<typeof basePolicy>, tx: Parameters<typeof sign>[0]) {
  return evaluateTx(policy, await parseSignedTx(await sign(tx)), { chainId: CHAIN, now: 1_000_000 });
}

describe("destinations and native value", () => {
  it("allows a small transfer to an allowed address", async () => {
    expect((await judge(basePolicy(), { to: ALLOWED, value: ETH / 100n })).allow).toBe(true);
  });
  it("denies an unknown destination", async () => {
    const v = await judge(basePolicy(), { to: ATTACKER, value: 1n });
    expect(v).toMatchObject({ allow: false, code: "DESTINATION_NOT_ALLOWED" });
  });
  it("denies over the per-tx native cap", async () => {
    expect((await judge(basePolicy(), { to: ALLOWED, value: ETH })).code).toBe("OVER_CAP");
  });
  it("enforces destination selectors", async () => {
    const p = basePolicy({ destinations: { [ALLOWED]: { selectors: ["deposit()"] } } });
    expect((await judge(p, { to: ALLOWED, data: "0xd0e30db0" })).allow).toBe(true);
    expect((await judge(p, { to: ALLOWED, data: "0x12345678" })).code).toBe("SELECTOR_NOT_ALLOWED");
  });
  it("allows the 0-value self-call used to cancel a stuck nonce", async () => {
    expect((await judge(basePolicy(), { to: AGENT })).allow).toBe(true);
  });
  it("denies contract creation by default", async () => {
    expect((await judge(basePolicy(), { data: "0x6080" })).code).toBe("CONTRACT_CREATION_DENIED");
  });
});

describe("ERC-20 calldata on an allowed contract (audit 1d)", () => {
  it("denies transfer(attacker, 2^255) even when the token contract is an allowed destination", async () => {
    const p = basePolicy({ destinations: { [TOKEN]: { allowAnySelector: true } }, tokens: {} });
    const data = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [ATTACKER, 2n ** 255n] });
    expect((await judge(p, { to: TOKEN, data })).code).toBe("TOKEN_NOT_ALLOWED");
  });
  it("checks recipient and amount for listed tokens", async () => {
    const p = basePolicy();
    const ok = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [RECIPIENT, 500n] });
    const bad = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [ATTACKER, 5n] });
    const big = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [RECIPIENT, 5000n] });
    expect((await judge(p, { to: TOKEN, data: ok })).allow).toBe(true);
    expect((await judge(p, { to: TOKEN, data: bad })).code).toBe("RECIPIENT_NOT_ALLOWED");
    expect((await judge(p, { to: TOKEN, data: big })).code).toBe("TRANSFER_OVER_CAP");
  });
  it("rejects non-canonical ABI (dirty address high bits)", async () => {
    const clean = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [RECIPIENT, 5n] });
    const dirty = (clean.slice(0, 10) + "ff" + clean.slice(12)) as Hex;
    expect((await judge(basePolicy(), { to: TOKEN, data: dirty })).code).toBe("NON_CANONICAL_ABI");
  });
});

describe("approvals", () => {
  it("denies unlimited, unknown spender, over cap; allows bounded and revoke", async () => {
    const p = basePolicy();
    expect((await judge(p, { to: TOKEN, data: approve(SPENDER_OK, MAX) })).code).toBe("APPROVAL_UNLIMITED");
    expect((await judge(p, { to: TOKEN, data: approve(SPENDER_BAD, 10n) })).code).toBe("SPENDER_NOT_ALLOWED");
    expect((await judge(p, { to: TOKEN, data: approve(SPENDER_OK, 1001n) })).code).toBe("APPROVAL_OVER_CAP");
    expect((await judge(p, { to: TOKEN, data: approve(SPENDER_OK, 1000n) })).allow).toBe(true);
    expect((await judge(p, { to: TOKEN, data: approve(SPENDER_BAD, 0n) })).allow).toBe(true);
  });
  it("denies setApprovalForAll(true) unless the operator is listed", async () => {
    const data = encodeFunctionData({ abi: erc20, functionName: "setApprovalForAll", args: [SPENDER_OK, true] });
    expect((await judge(basePolicy(), { to: TOKEN, data })).code).toBe("OPERATOR_APPROVAL_DENIED");
  });
});

describe("nested calls (audit claim 2)", () => {
  const inner = approve(SPENDER_BAD, MAX);
  it("Multicall3.aggregate3 wrapping approve(BAD, MAX) is denied, with a path", async () => {
    const v = await judge(basePolicy(), { to: MULTICALL3, data: aggregate3([{ target: TOKEN, callData: inner }]) });
    expect(v).toMatchObject({ allow: false, code: "APPROVAL_UNLIMITED", path: "tx>aggregate3[0]" });
  });
  it("Safe execTransaction wrapping approve(BAD, MAX) is denied", async () => {
    const p = basePolicy({ accounts: [SAFE] });
    expect((await judge(p, { to: SAFE, data: execTx(TOKEN, inner) })).code).toBe("APPROVAL_UNLIMITED");
    // Someone else's Safe isn't an allowed destination at all.
    expect((await judge(basePolicy(), { to: SAFE, data: execTx(TOKEN, approve(SPENDER_OK, 1n)) })).code).toBe("DESTINATION_NOT_ALLOWED");
  });
  it("Safe DELEGATECALL is denied except to MultiSend, whose entries are judged", async () => {
    const p = basePolicy({ accounts: [SAFE] });
    expect((await judge(p, { to: SAFE, data: execTx(ATTACKER, "0x", 1) })).code).toBe("DELEGATECALL_DENIED");
    const entry = (to: Address, data: Hex) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, to, 0n, BigInt((data.length - 2) / 2), data]);
    const packed = (entry(TOKEN, approve(SPENDER_OK, 5n)) + entry(TOKEN, inner).slice(2)) as Hex;
    const ms = encodeFunctionData({ abi: parseAbi(["function multiSend(bytes)"]), args: [packed] });
    const v = await judge(p, { to: SAFE, data: execTx("0x40A2aCCbd92BCA938b02010E17A5b8929b49130D", ms, 1) });
    expect(v).toMatchObject({ code: "APPROVAL_UNLIMITED", path: "tx>execTransaction>multiSend[1]" });
  });
  it("7702 self-batch execute((to,value,data)[]) wrapping approve(BAD, MAX) is denied", async () => {
    const v = await judge(basePolicy(), { to: AGENT, data: batch7702([{ to: TOKEN, value: 0n, data: inner }]) });
    expect(v.code).toBe("APPROVAL_UNLIMITED");
    // Same calldata to a stranger's contract: the stranger isn't an allowed destination.
    expect((await judge(basePolicy(), { to: DELEGATE_OK, data: batch7702([]) })).code).toBe("DESTINATION_NOT_ALLOWED");
  });
  it("counts native value moved by account batches against the per-tx cap", async () => {
    const calls = Array.from({ length: 3 }, () => ({ to: ALLOWED, value: ETH / 20n, data: "0x" as Hex }));
    expect((await judge(basePolicy(), { to: AGENT, data: batch7702(calls) })).code).toBe("OVER_CAP");
  });
  it("ERC-7579 execute: single and batch are judged; delegatecall mode is denied", async () => {
    const abi = parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]);
    const single = encodePacked(["address", "uint256", "bytes"], [TOKEN, 0n, inner]);
    const mode = (t: string) => (`0x${t}` + "00".repeat(31)) as Hex;
    const p = basePolicy({ accounts: [SAFE] });
    expect((await judge(p, { to: SAFE, data: encodeFunctionData({ abi, args: [mode("00"), single] }) })).code).toBe("APPROVAL_UNLIMITED");
    const b = encodeAbiParameters(parseAbiParameters("(address target, uint256 value, bytes callData)[]"), [[{ target: TOKEN, value: 0n, callData: inner }]]);
    expect((await judge(p, { to: SAFE, data: encodeFunctionData({ abi, args: [mode("01"), b] }) })).code).toBe("APPROVAL_UNLIMITED");
    expect((await judge(p, { to: SAFE, data: encodeFunctionData({ abi, args: [mode("ff"), single] }) })).code).toBe("DELEGATECALL_DENIED");
  });
  it("router multicall(bytes[]) entries are judged on the router", async () => {
    const p = basePolicy({ destinations: { [ROUTER]: { selectors: ["0x12345678"] } } });
    const data = encodeFunctionData({ abi: parseAbi(["function multicall(bytes[])"]), args: [["0x12345678", "0xdeadbeef"]] });
    expect((await judge(p, { to: ROUTER, data })).code).toBe("SELECTOR_NOT_ALLOWED");
  });
  it("stops at depth 4", async () => {
    let data: Hex = approve(SPENDER_OK, 1n);
    for (let i = 0; i < 6; i++) data = aggregate3([{ target: MULTICALL3, callData: data }]);
    expect((await judge(basePolicy(), { to: MULTICALL3, data })).code).toBe("TOO_DEEP");
  });
  it("increaseAllowance inside a batch counts toward the window spend", async () => {
    const inc = encodeFunctionData({ abi: erc20, functionName: "increaseAllowance", args: [SPENDER_OK, 1000n] });
    const v = await judge(basePolicy(), { to: MULTICALL3, data: aggregate3([{ target: TOKEN, callData: inc }, { target: TOKEN, callData: inc }]) });
    expect(v.allow).toBe(true);
    expect(v.spend.tokens.get(TOKEN.toLowerCase())).toBe(2000n);
  });
});

describe("Permit2", () => {
  const p2inner = p2approve(SPENDER_BAD, (1n << 160n) - 1n, 2n ** 47n);
  it("top-level and wrapped Permit2.approve(BAD, uint160 max) are denied", async () => {
    const p = basePolicy({ accounts: [SAFE] });
    expect((await judge(p, { to: PERMIT2, data: p2inner })).allow).toBe(false);
    expect((await judge(p, { to: MULTICALL3, data: aggregate3([{ target: PERMIT2, callData: p2inner }]) })).allow).toBe(false);
    expect((await judge(p, { to: SAFE, data: execTx(PERMIT2, p2inner) })).allow).toBe(false);
    expect((await judge(p, { to: AGENT, data: batch7702([{ to: PERMIT2, value: 0n, data: p2inner }]) })).allow).toBe(false);
  });
  it("uses the token's approve rules and the expiry limit", async () => {
    const p = basePolicy();
    expect((await judge(p, { to: PERMIT2, data: p2approve(SPENDER_OK, 100n, 1_000_000n + 3600n) })).allow).toBe(true);
    expect((await judge(p, { to: PERMIT2, data: p2approve(SPENDER_OK, 100n, 1_000_000n + 365n * 86400n) })).code).toBe("PERMIT2_EXPIRY_TOO_LONG");
  });
});

describe("Universal Router", () => {
  const ur = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
  const v3 = (recipient: Address) =>
    encodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), [
      recipient,
      1n,
      0n,
      encodePacked(["address", "uint24", "address"], [TOKEN, 500, "0x4200000000000000000000000000000000000006"]),
      true,
    ]);
  it("allows a swap paid to the sender (MSG_SENDER constant)", async () => {
    const data = encodeFunctionData({ abi: ur, args: ["0x00", [v3("0x0000000000000000000000000000000000000001")], 0n] });
    expect((await judge(basePolicy(), { to: ROUTER, data })).allow).toBe(true);
  });
  it("denies a swap that pays an attacker", async () => {
    const data = encodeFunctionData({ abi: ur, args: ["0x00", [v3(ATTACKER)], 0n] });
    expect((await judge(basePolicy(), { to: ROUTER, data })).code).toBe("ROUTER_RECIPIENT_NOT_ALLOWED");
  });
  it("judges PERMIT2_PERMIT inside the router like a Permit2 call", async () => {
    const permit = encodeAbiParameters(
      parseAbiParameters("((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline), bytes"),
      [{ details: { token: TOKEN, amount: (1n << 160n) - 1n, expiration: 0, nonce: 0 }, spender: SPENDER_BAD, sigDeadline: 0n }, "0x"]
    );
    const data = encodeFunctionData({ abi: ur, args: ["0x0a", [permit], 0n] });
    expect((await judge(basePolicy(), { to: ROUTER, data })).code).toBe("APPROVAL_UNLIMITED");
  });
  it("denies commands it can't check (v4 swap)", async () => {
    const data = encodeFunctionData({ abi: ur, args: ["0x10", ["0x"], 0n] });
    expect((await judge(basePolicy(), { to: ROUTER, data })).code).toBe("ROUTER_COMMAND_UNCHECKED");
  });
});

describe("7702 authorizations (audit 1a, 4)", () => {
  it("denies a type-4 tx delegating to an unknown contract, even to an allowed `to`", async () => {
    const auth = await agent.signAuthorization({ contractAddress: "0x000000000000000000000000000000000000dEaD", chainId: CHAIN, nonce: 1 });
    expect((await judge(basePolicy(), { to: ALLOWED, authorizationList: [auth] })).code).toBe("AUTHORIZATION_DENIED");
  });
  it("allows listed delegates, always allows removal, denies chainId 0", async () => {
    const p = basePolicy({ delegation: { mode: "allowlist", delegates: [DELEGATE_OK] } });
    const ok = await agent.signAuthorization({ contractAddress: DELEGATE_OK, chainId: CHAIN, nonce: 1 });
    const anyChain = await agent.signAuthorization({ contractAddress: DELEGATE_OK, chainId: 0, nonce: 1 });
    const removal = await agent.signAuthorization({ contractAddress: "0x0000000000000000000000000000000000000000", chainId: CHAIN, nonce: 1 });
    expect((await judge(p, { to: ALLOWED, authorizationList: [ok] })).allow).toBe(true);
    expect((await judge(basePolicy(), { to: ALLOWED, authorizationList: [removal] })).allow).toBe(true);
    expect((await judge(p, { to: ALLOWED, authorizationList: [anyChain] })).code).toBe("AUTHORIZATION_ANY_CHAIN");
  });
});

describe("policy file validation", () => {
  it("refuses unknown keys, float amounts and bad addresses with a precise location", () => {
    expect(() => parsePolicy({ destinatons: {} })).toThrow(/unknown key "destinatons"/);
    expect(() => parsePolicy({ native: { maxPerTxWei: 0.1 } })).toThrow(PolicyError);
    expect(() => parsePolicy({ destinations: { "0x12": {} } })).toThrow(/destinations\.0x12/);
    expect(() => parsePolicy({ destinations: { [MULTICALL3]: {}, [MULTICALL3.toLowerCase()]: {} } })).toThrow(/listed twice/);
  });
});
