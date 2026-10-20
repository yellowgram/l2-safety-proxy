/**
 * The guard decodes every input it trusts exactly as the target contract does: it decodes, re-encodes
 * canonically and requires byte equality. Anything the target would read differently or ignore
 * (trailing bytes, non-standard offsets or lengths, dirty high bits, a V3 path that isn't
 * token + (fee + token) hops, a command bit the router masks off) is denied with NON_CANONICAL_ABI.
 *
 * Each decoder has a control that passes and malformed variants of the same bytes that must not.
 */
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeFunctionData, encodePacked, numberToHex, padHex, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { MAX_CALLDATA_BYTES, checkAbiLayout, decodeExact, decodeKnown, NonCanonicalAbi, sameBytes } from "../../src/guard/abi.js";
import { v3PathEnds } from "../../src/guard/calls.js";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { Guard } from "../../src/guard/guard.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { handleRequest } from "../../src/proxy/handler.js";
import type { GuardConfig } from "../../src/types/index.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import { AGENT, ALLOWED, CHAIN, MULTICALL3, PERMIT2, RECIPIENT, ROUTER, SAFE, SPENDER_OK, TOKEN, basePolicy, sign } from "./helpers.js";

const MSG_SENDER = "0x0000000000000000000000000000000000000001" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x8888888888888888888888888888888888888888" as Address;
const MULTISEND = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D" as Address;

const enc = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values as never);
const erc20 = parseAbi(["function transfer(address,uint256)", "function approve(address,uint256)"]);
const transfer = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [RECIPIENT, 5n] });
const approve = encodeFunctionData({ abi: erc20, functionName: "approve", args: [SPENDER_OK, 5n] });
const ur = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const plan = (cmds: (readonly [string, Hex])[]) =>
  encodeFunctionData({ abi: ur, args: [("0x" + cmds.map((c) => c[0].slice(2)).join("")) as Hex, cmds.map((c) => c[1]), 0n] });
const path = (...hops: (Address | number)[]) =>
  encodePacked(hops.map((h) => (typeof h === "number" ? "uint24" : "address")), hops as never) as Hex;
const v3In = (to: Address, route: Hex) => enc("address, uint256, uint256, bytes, bool", [to, 10n ** 18n, 0n, route, true]);
const v3Out = (to: Address, route: Hex) => enc("address, uint256, uint256, bytes, bool", [to, 1n, 10n ** 18n, route, true]);
const sweep = (token: Address, to: Address) => enc("address, address, uint256", [token, to, 0n]);
const unwrap = (to: Address) => enc("address, uint256", [to, 0n]);
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;
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
const packEntry = (to: Address, data: Hex) =>
  encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, to, 0n, BigInt((data.length - 2) / 2), data]);
const multiSend = (packed: Hex) => encodeFunctionData({ abi: parseAbi(["function multiSend(bytes)"]), args: [packed] });
const batch7702 = (calls: { to: Address; value: bigint; data: Hex }[]) =>
  encodeFunctionData({ abi: parseAbi(["function execute((address to,uint256 value,bytes data)[] calls)"]), args: [calls] });
const exec7579 = (mode: Hex, exec: Hex) =>
  encodeFunctionData({ abi: parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]), args: [mode, exec] });
const mode7579 = (callType: string) => (`0x${callType}` + "00".repeat(31)) as Hex;
const batch7579 = (calls: { target: Address; value: bigint; callData: Hex }[]) =>
  enc("(address target, uint256 value, bytes callData)[]", [calls]);
const p2approve = (s: Address, a: bigint, exp: bigint) =>
  encodeFunctionData({ abi: parseAbi(["function approve(address,address,uint160,uint48)"]), args: [TOKEN, s, a, Number(exp)] });

// ---- malformers: each keeps what a lenient decoder would read, but changes the bytes ----
const SEL = 10; // "0x" + 4-byte selector
/** Append one byte the target never reads. */
const trailing = (h: Hex) => (h + "00") as Hex;
/** Set the high byte of head word `w` (a dirty address or uint160 / out-of-range bool). */
const dirtyWord = (h: Hex, w: number, start = SEL) =>
  (h.slice(0, start + w * 64) + "ff" + h.slice(start + w * 64 + 2)) as Hex;
/** Set the low byte of head word `w` to `b` (e.g. a bool of 2). */
const lowByte = (h: Hex, w: number, b: string, start = SEL) =>
  (h.slice(0, start + w * 64 + 62) + b + h.slice(start + w * 64 + 64)) as Hex;
/**
 * Move the tail that head word `w` points to 32 bytes further on, padding the gap with zeros. A
 * decoder that follows offsets still reads the same value; the canonical encoding does not have the gap.
 * Use it on the last dynamic argument so no other offset needs fixing.
 */
const gapOffset = (h: Hex, w: number, start = SEL) => {
  const body = h.slice(start);
  const off = Number(BigInt("0x" + body.slice(w * 64, w * 64 + 64)));
  const word = (off + 32).toString(16).padStart(64, "0");
  const moved = body.slice(0, w * 64) + word + body.slice(w * 64 + 64, off * 2) + "00".repeat(32) + body.slice(off * 2);
  return (h.slice(0, start) + moved) as Hex;
};

async function judge(tx: Parameters<typeof sign>[0], policy = basePolicy({ accounts: [SAFE] })) {
  return evaluateTx(policy, await parseSignedTx(await sign(tx)), { chainId: CHAIN, now: 1_000_000 });
}
async function allowed(tx: Parameters<typeof sign>[0]) {
  const v = await judge(tx);
  expect(v, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))).toMatchObject({ allow: true });
}
async function nonCanonical(tx: Parameters<typeof sign>[0], code = "NON_CANONICAL_ABI") {
  // An exception escaping the evaluator is a failure too, not a denial.
  const v = await judge(tx).catch((err: unknown) => ({ threw: String(err) }));
  expect(v).toMatchObject({ allow: false, code });
  return v;
}

describe("decodeExact / sameBytes / decodeKnown round trip", () => {
  const good = enc("address, uint256", [RECIPIENT, 5n]);
  it("returns the values of a canonical encoding", () => {
    expect(decodeExact("address, uint256", good)).toEqual([RECIPIENT, 5n]);
  });
  it("refuses trailing bytes, a dirty address, and bytes that don't decode", () => {
    expect(() => decodeExact("address, uint256", trailing(good))).toThrow(NonCanonicalAbi);
    expect(() => decodeExact("address, uint256", dirtyWord(good, 0, 2))).toThrow(NonCanonicalAbi);
    expect(() => decodeExact("address, uint256", "0x1234")).toThrow(NonCanonicalAbi);
  });
  it("refuses a bool other than 0 or 1, and a gap before a dynamic tail", () => {
    const b = enc("bool, bytes", [true, "0xabcd"]);
    expect(decodeExact("bool, bytes", b)).toEqual([true, "0xabcd"]);
    expect(() => decodeExact("bool, bytes", lowByte(b, 0, "02", 2))).toThrow(NonCanonicalAbi);
    expect(() => decodeExact("bool, bytes", gapOffset(b, 1, 2))).toThrow(NonCanonicalAbi);
  });
  it("sameBytes ignores letter case only", () => {
    expect(sameBytes("0xABcd", "0xabCD")).toBe(true);
    expect(sameBytes("0xabcd", "0xabcd00")).toBe(false);
    expect(sameBytes("0xabcd00", "0xabcd")).toBe(false);
  });
  it("decodeKnown refuses trailing bytes on a known selector, and still ignores unknown selectors", () => {
    expect(decodeKnown(transfer)?.name).toBe("transfer");
    expect(() => decodeKnown(trailing(transfer))).toThrow(NonCanonicalAbi);
    expect(() => decodeKnown(dirtyWord(transfer, 0))).toThrow(NonCanonicalAbi);
    expect(decodeKnown(trailing("0x12345678"))).toBeUndefined();
  });
});

describe("V3 paths: only token + (fee + token)·k, k ≥ 1", () => {
  it("accepts 43, 66 and 89 bytes and returns the real ends", () => {
    expect(v3PathEnds(path(TOKEN, 500, WETH), "p")).toEqual({ first: TOKEN.toLowerCase(), last: WETH.toLowerCase() });
    expect(v3PathEnds(path(TOKEN, 500, USDC, 3000, WETH), "p")).toEqual({ first: TOKEN.toLowerCase(), last: WETH.toLowerCase() });
    expect(v3PathEnds(path(TOKEN, 500, USDC, 3000, WETH, 100, TOKEN), "p").last).toBe(TOKEN.toLowerCase());
  });
  it.each([0, 1, 20, 23, 42, 44, 45, 63, 65, 67, 88, 90])("refuses a %i-byte path", (n) => {
    const route = ("0x" + "11".repeat(n)) as Hex;
    expect(() => v3PathEnds(route, "p")).toThrow(expect.objectContaining({ code: "NON_CANONICAL_ABI" }));
  });
  it("a single-pool path with trailing bytes is refused even when the trailing bytes look like a token", () => {
    const junk = (path(TOKEN, 500, WETH) + "000000" + USDC.slice(2).toLowerCase()) as Hex; // 66 bytes
    expect(() => v3PathEnds(junk.slice(0, -6) as Hex, "p")).toThrow(expect.objectContaining({ code: "NON_CANONICAL_ABI" }));
  });
  it.each([
    ["exact-in to the sender", (r: Hex) => v3In(MSG_SENDER, r), "0x00"],
    ["exact-out to the sender", (r: Hex) => v3Out(MSG_SENDER, r), "0x01"],
  ] as const)("%s: a bad path length is denied wherever the swap pays", async (_n, input, c) => {
    await allowed({ to: ROUTER, data: plan([[c, input(path(TOKEN, 500, WETH))]]) });
    await allowed({ to: ROUTER, data: plan([[c, input(path(TOKEN, 500, USDC, 500, WETH))]]) });
    for (const bad of [
      "0x" as Hex,
      (path(TOKEN, 500, WETH) + "00") as Hex,
      (path(TOKEN, 500, USDC, 500, WETH) + "00") as Hex,
      path(TOKEN, 500, WETH).slice(0, -2) as Hex,
      (path(TOKEN, 500, WETH) + "0001f4") as Hex,
    ]) {
      await nonCanonical({ to: ROUTER, data: plan([[c, input(bad)]]) });
    }
  });
});

describe("Universal Router command inputs round-trip exactly", () => {
  const swap = v3In(MSG_SENDER, path(TOKEN, 500, WETH));
  it("control: the canonical swap passes", async () => {
    await allowed({ to: ROUTER, data: plan([["0x00", swap]]) });
  });
  it("a trailing byte, a dirty recipient, a bool of 2, or a gap before the path is denied", async () => {
    for (const bad of [trailing(swap), dirtyWord(swap, 0, 2), lowByte(swap, 4, "02", 2), gapOffset(swap, 3, 2)]) {
      await nonCanonical({ to: ROUTER, data: plan([["0x00", bad]]) });
    }
  });
  it("SWEEP, UNWRAP_WETH, PERMIT2_PERMIT and a sub-plan with extra bytes are denied", async () => {
    const swapIn = v3In(ADDRESS_THIS, path(TOKEN, 500, WETH));
    await allowed({ to: ROUTER, data: plan([["0x00", swapIn], ["0x04", sweep(WETH, MSG_SENDER)]]) });
    await nonCanonical({ to: ROUTER, data: plan([["0x00", swapIn], ["0x04", trailing(sweep(WETH, MSG_SENDER))]]) });
    await nonCanonical({ to: ROUTER, data: plan([["0x00", swapIn], ["0x04", dirtyWord(sweep(WETH, MSG_SENDER), 1, 2)]]) });
    await allowed({ to: ROUTER, data: plan([["0x00", swapIn], ["0x0c", unwrap(MSG_SENDER)]]) });
    await nonCanonical({ to: ROUTER, data: plan([["0x00", swapIn], ["0x0c", trailing(unwrap(MSG_SENDER))]]) });
    const permit = enc(
      "((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline), bytes",
      [{ details: { token: TOKEN, amount: 5n, expiration: 1_000_100, nonce: 0 }, spender: ROUTER, sigDeadline: 1_000_100n }, "0x"]
    );
    await nonCanonical({ to: ROUTER, data: plan([["0x0a", trailing(permit)]]) });
    await nonCanonical({ to: ROUTER, data: plan([["0x0a", gapOffset(permit, 6, 2)]]) });
    const subPlan = enc("bytes, bytes[]", ["0x00", [swap]]);
    await allowed({ to: ROUTER, data: plan([["0x21", subPlan]]) });
    await nonCanonical({ to: ROUTER, data: plan([["0x21", trailing(subPlan)]]) });
    await nonCanonical({ to: ROUTER, data: plan([["0x21", gapOffset(subPlan, 1, 2)]]) });
  });
  it("a command byte with bit 0x40 (unused before Universal Router 2.1) is denied", async () => {
    const swapIn = v3In(ADDRESS_THIS, path(TOKEN, 500, WETH));
    const v = await nonCanonical({ to: ROUTER, data: plan([["0x00", swapIn], ["0x44", sweep(WETH, MSG_SENDER)]]) });
    expect(v.reason).toContain("0x44");
    await nonCanonical({ to: ROUTER, data: plan([["0x40", swap]]) });
    await nonCanonical({ to: ROUTER, data: plan([["0xc0", swap]]) });
  });
  it("the execute call itself with a trailing byte, or a gap before an input, is denied", async () => {
    await nonCanonical({ to: ROUTER, data: trailing(plan([["0x00", swap]])) });
    await nonCanonical({ to: ROUTER, data: routerMulticall([trailing(plan([["0x00", swap]]))]) });
    await allowed({ to: ROUTER, data: routerMulticall([plan([["0x00", swap]])]) });
    await nonCanonical({ to: ROUTER, data: trailing(routerMulticall([plan([["0x00", swap]])])) });
  });
});

describe("wrappers and batches round-trip exactly", () => {
  it("Multicall3 aggregate3: trailing byte, dirty target, gap before the calls, or a trailing byte inside a call", async () => {
    const ok = aggregate3([{ target: TOKEN, callData: approve }]);
    await allowed({ to: MULTICALL3, data: ok });
    await nonCanonical({ to: MULTICALL3, data: trailing(ok) });
    await nonCanonical({ to: MULTICALL3, data: gapOffset(ok, 0) });
    await nonCanonical({ to: MULTICALL3, data: aggregate3([{ target: TOKEN, callData: trailing(approve) }]) });
  });
  it("Safe execTransaction: trailing byte, gap before the signatures, trailing byte on the inner call", async () => {
    const ok = execTx(TOKEN, transfer);
    await allowed({ to: SAFE, data: ok });
    await nonCanonical({ to: SAFE, data: trailing(ok) });
    await nonCanonical({ to: SAFE, data: gapOffset(ok, 9) });
    await nonCanonical({ to: SAFE, data: dirtyWord(ok, 0) });
    await nonCanonical({ to: SAFE, data: execTx(TOKEN, trailing(transfer)) });
  });
  it("MultiSend: trailing byte on the outer call or an entry's data; a partial trailing entry", async () => {
    const ok = multiSend(packEntry(TOKEN, approve));
    await allowed({ to: SAFE, data: execTx(MULTISEND, ok, 1) });
    await nonCanonical({ to: SAFE, data: execTx(MULTISEND, trailing(ok), 1) });
    await nonCanonical({ to: SAFE, data: execTx(MULTISEND, multiSend(packEntry(TOKEN, trailing(approve))), 1) });
    await nonCanonical({ to: SAFE, data: execTx(MULTISEND, multiSend(trailing(packEntry(TOKEN, approve))), 1) }, "MALFORMED_BATCH");
  });
  it("ERC-7579 execute: trailing byte, non-zero mode payload, non-canonical batch", async () => {
    const single = encodePacked(["address", "uint256", "bytes"], [TOKEN, 0n, approve]);
    await allowed({ to: SAFE, data: exec7579(mode7579("00"), single) });
    await nonCanonical({ to: SAFE, data: trailing(exec7579(mode7579("00"), single)) });
    await nonCanonical({ to: SAFE, data: exec7579(mode7579("00"), trailing(single)) });
    const payload = ("0x0000" + "00".repeat(8) + "00".repeat(21) + "01") as Hex;
    const v = await nonCanonical({ to: SAFE, data: exec7579(payload, single) });
    expect(v.reason).toContain("payload");
    const b = batch7579([{ target: TOKEN, value: 0n, callData: approve }]);
    await allowed({ to: SAFE, data: exec7579(mode7579("01"), b) });
    await nonCanonical({ to: SAFE, data: exec7579(mode7579("01"), trailing(b)) });
    await nonCanonical({ to: SAFE, data: exec7579(mode7579("01"), gapOffset(b, 0, 2)) });
    await nonCanonical({ to: SAFE, data: exec7579(mode7579("01"), dirtyWord(b, 3, 2)) });
  });
  it("7702 batch execute((to,value,data)[]): trailing byte, gap, inner trailing byte", async () => {
    const ok = batch7702([{ to: TOKEN, value: 0n, data: approve }]);
    await allowed({ to: AGENT, data: ok });
    await nonCanonical({ to: AGENT, data: trailing(ok) });
    await nonCanonical({ to: AGENT, data: gapOffset(ok, 0) });
    await nonCanonical({ to: AGENT, data: batch7702([{ to: TOKEN, value: 0n, data: trailing(approve) }]) });
  });
});

describe("token and Permit2 calls round-trip exactly", () => {
  it("ERC-20 transfer: trailing byte, dirty recipient", async () => {
    await allowed({ to: TOKEN, data: transfer });
    await nonCanonical({ to: TOKEN, data: trailing(transfer) });
    await nonCanonical({ to: TOKEN, data: dirtyWord(transfer, 0) });
  });
  it("Permit2 approve: trailing byte, uint160 amount with high bits, uint48 expiry with high bits", async () => {
    const ok = p2approve(SPENDER_OK, 100n, 1_000_000n + 3600n);
    await allowed({ to: PERMIT2, data: ok });
    await nonCanonical({ to: PERMIT2, data: trailing(ok) });
    await nonCanonical({ to: PERMIT2, data: dirtyWord(ok, 2) });
    await nonCanonical({ to: PERMIT2, data: dirtyWord(ok, 3) });
  });
});

describe("decoders: lengths, bounds and nesting", () => {
  it("a MultiSend entry whose data length runs past the payload is refused", async () => {
    const entry = packEntry(TOKEN, approve);
    // Claim 10 more bytes of data than the entry carries.
    const lenAt = 2 + 53 * 2;
    const claimed = BigInt((approve.length - 2) / 2 + 10);
    const long = (entry.slice(0, lenAt) + claimed.toString(16).padStart(64, "0") + entry.slice(lenAt + 64)) as Hex;
    await nonCanonical({ to: SAFE, data: execTx(MULTISEND, multiSend(long), 1) }, "MALFORMED_BATCH");
    const huge = (entry.slice(0, lenAt) + "ff".repeat(32) + entry.slice(lenAt + 64)) as Hex;
    await nonCanonical({ to: SAFE, data: execTx(MULTISEND, multiSend(huge), 1) }, "MALFORMED_BATCH");
  });
  it("an ERC-7579 single execution shorter than target + value (52 bytes) is refused", async () => {
    const short = encodePacked(["address", "uint256"], [TOKEN, 0n]).slice(0, -2) as Hex; // 51 bytes
    const v = await nonCanonical({ to: SAFE, data: exec7579(mode7579("00"), short) }, "MALFORMED_BATCH");
    expect(v.reason).toContain("too short");
    await allowed({ to: SAFE, data: exec7579(mode7579("00"), encodePacked(["address", "uint256"], [ALLOWED, 0n])) });
  });
  it("bit 0x40 is refused inside a sub-plan too", async () => {
    const swapIn = v3In(ADDRESS_THIS, path(TOKEN, 500, WETH));
    const inner = enc("bytes, bytes[]", ["0x44", [sweep(WETH, MSG_SENDER)]]);
    await nonCanonical({ to: ROUTER, data: plan([["0x00", swapIn], ["0x21", inner]]) });
    const fine = enc("bytes, bytes[]", ["0x04", [sweep(WETH, MSG_SENDER)]]);
    await allowed({ to: ROUTER, data: plan([["0x00", swapIn], ["0x21", fine]]) });
  });
  it("a V2 path with fewer than two tokens is refused", async () => {
    const v2 = (route: Address[]) => enc("address, uint256, uint256, address[], bool", [MSG_SENDER, 1n, 0n, route, true]);
    await allowed({ to: ROUTER, data: plan([["0x08", v2([TOKEN, WETH])]]) });
    const v = await nonCanonical({ to: ROUTER, data: plan([["0x08", v2([TOKEN])]]) });
    expect(v.reason).toContain("fewer than two tokens");
    await nonCanonical({ to: ROUTER, data: plan([["0x08", v2([])]]) });
  });
  it("a value out of range for its type (uint160 with high bits) is refused explicitly, not by accident", async () => {
    const pull = enc("address, address, uint160", [TOKEN, MSG_SENDER, 1n]);
    const dirty = dirtyWord(pull, 2, 2); // high byte of the uint160 word
    expect(() => decodeExact("address, address, uint160", dirty)).toThrow(/out of range/);
    await nonCanonical({ to: ROUTER, data: plan([["0x02", dirty]]) });
  });
  it("a Universal Router 2.1 swap (sixth argument minHopPriceX36) is refused: the guard reads the 2.0 layout", async () => {
    const six = enc("address, uint256, uint256, bytes, bool, uint256[]", [MSG_SENDER, 1n, 0n, path(TOKEN, 500, WETH), true, []]);
    await nonCanonical({ to: ROUTER, data: plan([["0x00", six]]) });
    const sixV2 = enc("address, uint256, uint256, address[], bool, uint256[]", [MSG_SENDER, 1n, 0n, [TOKEN, WETH], true, [1n]]);
    await nonCanonical({ to: ROUTER, data: plan([["0x08", sixV2]]) });
  });
});

describe("decode amplification: offsets are checked before anything is expanded", () => {
  const W = (n: number) => padHex(numberToHex(BigInt(n)), { size: 32 }).slice(2);
  /** aggregate3 whose N tuple offsets all point at one tuple carrying S bytes of callData. */
  const aliased = (n: number, s: number) => {
    const one = aggregate3([{ target: ALLOWED, callData: ("0x" + "11".repeat(s)) as Hex }]);
    const tuple = one.slice(10 + 3 * 64);
    return (one.slice(0, 10) + W(32) + W(n) + W(n * 32).repeat(n) + tuple) as Hex;
  };
  it("aliased offsets under the size cap are refused quickly, without expanding the shared value", { timeout: 60_000 }, async () => {
    const data = aliased(500, 30_000);
    expect((data.length - 2) / 2).toBeLessThan(MAX_CALLDATA_BYTES);
    const t0 = Date.now();
    const v = await nonCanonical({ to: MULTICALL3, data });
    expect(Date.now() - t0).toBeLessThan(5000); // milliseconds in practice; generous for loaded CI
    expect(v.reason).toContain("layout");
  });
  it("calldata over 128 KiB is refused before decoding (CALLDATA_TOO_LARGE); at the limit it is decoded", { timeout: 60_000 }, async () => {
    const big = aliased(4000, 120_000); // ~250 KB: crashed the proxy before
    const v = await nonCanonical({ to: MULTICALL3, data: big }, "CALLDATA_TOO_LARGE");
    expect(v.reason).toContain(`${MAX_CALLDATA_BYTES}`);
    const at = ("0x12345678" + "00".repeat(MAX_CALLDATA_BYTES - 4)) as Hex;
    expect((await judge({ to: ALLOWED, data: at })).code).toBe("SELECTOR_NOT_ALLOWED");
    const over = (at + "00") as Hex;
    expect((await judge({ to: ALLOWED, data: over })).code).toBe("CALLDATA_TOO_LARGE");
  });
  it("checkAbiLayout accepts canonical encodings of nested types", () => {
    const types = "(address target, bool f, bytes data)[], bytes[], uint256[2], (uint256, bytes)[2], string";
    const values = [[{ target: TOKEN, f: true, data: "0xabcd" }, { target: ALLOWED, f: false, data: "0x" }], ["0x01", "0x"], [1n, 2n], [[1n, "0x02"], [3n, "0x"]], "hi"];
    const ok = enc(types, values);
    expect(() => checkAbiLayout(parseAbiParameters(types), ok)).not.toThrow();
    expect(() => checkAbiLayout(parseAbiParameters("uint256[]"), enc("uint256[]", [[]]))).not.toThrow();
  });
  it("checkAbiLayout refuses aliased, gapped and out-of-range offsets, overlong lengths and leftovers", () => {
    const t = parseAbiParameters("bytes, bytes");
    const ok = enc("bytes, bytes", ["0xaa", "0xbb"]);
    const word = (h: Hex, w: number, v: string) => (h.slice(0, 2 + w * 64) + v + h.slice(2 + w * 64 + 64)) as Hex;
    expect(() => checkAbiLayout(t, ok)).not.toThrow();
    expect(() => checkAbiLayout(t, word(ok, 1, W(0x40)))).toThrow(/previous value ended/); // second aliases first
    expect(() => decodeExact("bytes, bytes", word(ok, 1, W(0x40)))).toThrow(/layout/); // checked before decoding
    expect(() => checkAbiLayout(t, gapOffset(ok, 1, 2))).toThrow(/previous value ended/);
    expect(() => checkAbiLayout(t, word(ok, 1, "01" + W(0x80).slice(2)))).toThrow(/out of range/);
    expect(() => checkAbiLayout(t, word(ok, 4, W(33)))).toThrow(/past the end/); // last length 33 > its 32-byte slot
    expect(() => checkAbiLayout(t, trailing(ok))).toThrow(/left over/);
    expect(() => checkAbiLayout(parseAbiParameters("uint256[]"), word(enc("uint256[]", [[1n]]), 1, W(1000)))).toThrow(/past the end/);
    expect(() => checkAbiLayout(t, ok.slice(0, 2 + 64) as Hex)).toThrow(/past the end/);
    expect(() => checkAbiLayout(parseAbiParameters("uint256, uint256"), `0x${W(1)}`)).toThrow(/head runs past/);
  });
});

describe("through the proxy", () => {
  it("a calldata suffix is a -32083 NON_CANONICAL_ABI with a hint, and nothing is forwarded", async () => {
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xok" }));
    const simulate = vi.fn();
    const config = {
      listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base",
      guard: new Guard({ policy: basePolicy(), store: new MemoryStore() }),
      chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } },
    } as unknown as GuardConfig;
    const raw = await sign({ to: TOKEN, data: (transfer + "c0ffee") as Hex, nonce: 0 });
    const r = await handleRequest(config, { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] } as never, undefined, { simulate, forward } as never);
    expect(r.error?.code).toBe(-32083);
    expect(r.error?.data).toMatchObject({
      policyCode: "NON_CANONICAL_ABI",
      hint: "The calldata isn't the exact standard ABI encoding the contract reads (extra trailing bytes, unusual offsets, dirty padding, or a malformed swap path). Re-encode it with a standard encoder and drop any suffix.",
    });
    expect(forward).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });
  it("oversized calldata is a -32083 CALLDATA_TOO_LARGE with a hint", async () => {
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xok" }));
    const config = {
      listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base",
      guard: new Guard({ policy: basePolicy(), store: new MemoryStore() }),
      chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } },
    } as unknown as GuardConfig;
    const raw = await sign({ to: TOKEN, data: ("0x12345678" + "00".repeat(MAX_CALLDATA_BYTES)) as Hex, nonce: 0 });
    const r = await handleRequest(config, { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] } as never, undefined, { simulate: vi.fn(), forward } as never);
    expect(r.error?.data).toMatchObject({
      policyCode: "CALLDATA_TOO_LARGE",
      hint: "The transaction's calldata is larger than the guard will decode (128 KiB). Split the batch into smaller transactions.",
    });
    expect(forward).not.toHaveBeenCalled();
  });
});
