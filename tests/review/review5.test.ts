// Regression tests for the 2026-10-19 independent review: the remaining fixes.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, encodePacked, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { parsePolicy } from "../../src/guard/policy/load.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import { Guard } from "../../src/guard/guard.js";
import { createGuardedSigner } from "../../src/guard/signer.js";
import { checkTypedData } from "../../src/guard/typed.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { handleRequest } from "../../src/proxy/handler.js";
import type { GuardConfig, SimResult } from "../../src/types/index.js";
import { AGENT, ALLOWED, ATTACKER, CHAIN, ETH, SAFE, TOKEN, agent, basePolicy, sign } from "../guard/helpers.js";

const run = promisify(execFile);
const judge = async (p: ReturnType<typeof basePolicy>, tx: Parameters<typeof sign>[0]) =>
  evaluateTx(p, await parseSignedTx(await sign(tx)), { chainId: CHAIN, now: 1_000_000 });
const execTx = (to: Address, data: Hex, op = 0) =>
  encodeFunctionData({
    abi: parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)"]),
    args: [to, 0n, data, op, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x"],
  });
const okSim = vi.fn(async (): Promise<SimResult> => ({ ok: true, method: "simulate_v1", confidence: "definite", logsInspected: true }) as SimResult);
const cfg = (guard: Guard) =>
  ({
    listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base", guard,
    chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } },
  }) as GuardConfig;

describe("L2-1: only the judged request is forwarded", () => {
  it("forwards exactly {jsonrpc,id,method,params}, dropping extra keys", async () => {
    let sent: Record<string, unknown> | undefined;
    const forward = vi.fn(async (_u: string, body: unknown) => ((sent = JSON.parse(JSON.stringify(body))), { jsonrpc: "2.0" as const, id: 1, result: "0x1" }));
    const g = new Guard({ policy: basePolicy(), store: new MemoryStore() });
    await handleRequest(cfg(g), { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [], extra: "x" } as never, undefined, { simulate: okSim, forward });
    expect(Object.keys(sent!).sort()).toEqual(["id", "jsonrpc", "method", "params"]);
  });
  it("refuses case-variant keys nested inside params (eth_sendPrivateTransaction {tx, Tx})", async () => {
    const forward = vi.fn();
    const g = new Guard({ policy: basePolicy(), store: new MemoryStore() });
    const good = await sign({ to: ALLOWED, value: 1n, nonce: 0 });
    const evil = await sign({ to: ATTACKER, value: ETH, nonce: 0 });
    const res = await handleRequest(cfg(g), { jsonrpc: "2.0", id: 1, method: "eth_sendPrivateTransaction", params: [{ tx: good, Tx: evil }] }, undefined, { simulate: okSim, forward });
    expect(res.error?.code).toBe(-32600);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("L2-2: guarded signer messages and typed data", () => {
  it("allows a message only through an explicit allowMessage predicate", async () => {
    const g = new Guard({ policy: basePolicy(), store: new MemoryStore() });
    const s = createGuardedSigner(agent, g, { chainId: CHAIN, allowMessage: (m) => m === "login to example.com" });
    await expect(s.signMessage({ message: "login to example.com" })).resolves.toMatch(/^0x/);
    await expect(s.signMessage({ message: "something else" })).rejects.toThrow(/MESSAGE_SIGNING_DENIED/);
    await expect(s.signMessage({ message: { raw: keccak256(toHex("x")) } })).rejects.toThrow(/MESSAGE_SIGNING_DENIED/);
  });
  it("refuses SafeTx and UserOperation typed data even with typedData.allowUnknown", () => {
    const p = basePolicy({ typedData: { allowUnknown: true } });
    for (const primaryType of ["SafeTx", "PackedUserOperation"]) {
      const v = checkTypedData(p, { domain: { chainId: CHAIN, verifyingContract: SAFE }, types: { [primaryType]: [] }, primaryType, message: {} } as never, { chainId: CHAIN });
      expect(v.code).toBe("TYPED_DATA_AUTHORIZES_TX");
    }
  });
  it("refuses a 7702 authorization for another chain", async () => {
    const g = new Guard({ policy: basePolicy({ delegation: { mode: "allowlist", delegates: ["0x7777777777777777777777777777777777777777"] } }), store: new MemoryStore() });
    const s = createGuardedSigner(agent, g, { chainId: CHAIN });
    await expect(s.signAuthorization!({ address: "0x7777777777777777777777777777777777777777", chainId: 10, nonce: 0 })).rejects.toThrow(/AUTHORIZATION_WRONG_CHAIN/);
  });
});

describe("L2-4: the agent's own account", () => {
  it("a policy listing an account as a destination does not load", () => {
    expect(() => parsePolicy({ accounts: [SAFE], destinations: { [SAFE]: { allowAnySelector: true } } })).toThrow(/also listed in accounts/);
  });
  it("account admin calls are denied, including a 7702 self-call", async () => {
    const enableModule = encodeFunctionData({ abi: parseAbi(["function enableModule(address)"]), args: [ATTACKER] });
    const p = basePolicy({ accounts: [SAFE] });
    expect((await judge(p, { to: SAFE, data: execTx(SAFE, enableModule) })).code).toBe("ACCOUNT_ADMIN_DENIED");
    const swap = encodeFunctionData({ abi: parseAbi(["function swapOwner(address,address,address)"]), args: [ALLOWED, AGENT as Address, ATTACKER] });
    expect((await judge(basePolicy(), { to: AGENT as Address, data: swap })).code).toBe("ACCOUNT_ADMIN_DENIED");
  });
});

describe("L2-7: reducing calls only on known contracts", () => {
  it("revoking an approval on a listed token is still allowed", async () => {
    const approve0 = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [ATTACKER, 0n] });
    expect((await judge(basePolicy(), { to: TOKEN, data: approve0 })).allow).toBe(true);
  });
});

describe("L2-11: fixes that had no test", () => {
  it("a MultiSend entry that uses DELEGATECALL is denied", async () => {
    const entry = encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [1, ALLOWED, 0n, 0n, "0x"]);
    const ms = encodeFunctionData({ abi: parseAbi(["function multiSend(bytes)"]), args: [entry] });
    const v = await judge(basePolicy({ accounts: [SAFE] }), { to: SAFE, data: execTx("0x40A2aCCbd92BCA938b02010E17A5b8929b49130D", ms, 1) });
    expect(v).toMatchObject({ code: "DELEGATECALL_DENIED", path: "tx>execTransaction>multiSend[0]" });
  });
  it("serve refuses to start without a policy", async () => {
    const env = { ...process.env, L2SG_POLICY_FILE: "", L2SG_POLICY: "", L2SG_CHAINS: "", L2SG_STORE: "memory" };
    delete (env as Record<string, string | undefined>).L2SG_POLICY_FILE;
    delete (env as Record<string, string | undefined>).L2SG_POLICY;
    const err = await run(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts", "serve"], { env, timeout: 20_000 }).catch((e: { code: number; stderr: string }) => e);
    expect((err as { code: number }).code).toBe(1);
    expect((err as { stderr: string }).stderr).toMatch(/refusing to start: no policy/);
  }, 30_000);
});

describe("cleanup: ERC-7579 mode and the unlimited threshold", () => {
  it("an ERC-7579 mode with an exec type or mode selector the guard can't read is denied", async () => {
    const abi = parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]);
    const single = encodePacked(["address", "uint256", "bytes"], [ALLOWED, 0n, "0x"]);
    const p = basePolicy({ accounts: [SAFE] });
    expect((await judge(p, { to: SAFE, data: encodeFunctionData({ abi, args: [("0x0002" + "00".repeat(30)) as Hex, single] }) })).code).toBe("MALFORMED_BATCH");
    expect((await judge(p, { to: SAFE, data: encodeFunctionData({ abi, args: [("0x0000" + "00".repeat(4) + "deadbeef" + "00".repeat(22)) as Hex, single] }) })).code).toBe("MALFORMED_BATCH");
    expect((await judge(p, { to: SAFE, data: encodeFunctionData({ abi, args: [("0x0001" + "00".repeat(30)) as Hex, single] }) })).allow).toBe(true);
  });
  it("an ERC-20 approval at 2^128 counts as unlimited", async () => {
    const p = basePolicy({ tokens: { [TOKEN]: { approve: { spenders: [ALLOWED], maxAmountRaw: (2n ** 200n).toString() } } } });
    const ap = (n: bigint) => encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [ALLOWED, n] });
    expect((await judge(p, { to: TOKEN, data: ap(2n ** 128n) })).code).toBe("APPROVAL_UNLIMITED");
    expect((await judge(p, { to: TOKEN, data: ap(2n ** 128n - 1n) })).allow).toBe(true);
  });
});
