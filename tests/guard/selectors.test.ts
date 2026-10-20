/**
 * Contract destinations are fail-closed: a call with calldata needs its selector in the
 * destination's "selectors", or an explicit "allowAnySelector": true. Plain value transfers
 * need no list. These tests cover the load check, the runtime rule and every wrapper path.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, parseAbiParameters, toFunctionSelector, type Address, type Hex } from "viem";
import { migrateLegacyPolicy } from "../../src/config/migrate.js";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { parsePolicy, PolicyError, selectorWarnings } from "../../src/guard/policy/load.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import { Guard } from "../../src/guard/guard.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { handleRequest } from "../../src/proxy/handler.js";
import type { GuardConfig } from "../../src/types/index.js";
import { AGENT, ALLOWED, ATTACKER, CHAIN, DELEGATE_OK, ETH, MULTICALL3, RECIPIENT, SAFE, SPENDER_BAD, TOKEN, agent, basePolicy, sign } from "./helpers.js";

const DEX = "0x8888888888888888888888888888888888888888" as Address;
const dex = DEX.toLowerCase();
const SWAP_SIG = "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)";
const SWAP = toFunctionSelector(`function ${SWAP_SIG}`);
const swapData = (SWAP + "00".repeat(32)) as Hex;
const OTHER = "0xdeadbeef" as Hex; // e.g. an admin or sweep function on the same router
const MAX = (1n << 256n) - 1n;

const erc20 = parseAbi(["function approve(address,uint256)", "function transfer(address,uint256)"]);
const approveMax = encodeFunctionData({ abi: erc20, functionName: "approve", args: [SPENDER_BAD, MAX] });
const multicall = (items: Hex[]) => encodeFunctionData({ abi: parseAbi(["function multicall(bytes[])"]), args: [items] });
const aggregate3 = (calls: { target: Address; callData: Hex }[]) =>
  encodeFunctionData({
    abi: parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls)"]),
    args: [calls.map((c) => ({ ...c, allowFailure: false }))],
  });
const execTx = (to: Address, data: Hex) =>
  encodeFunctionData({
    abi: parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)"]),
    args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x"],
  });
const batch7702 = (calls: { to: Address; value: bigint; data: Hex }[]) =>
  encodeFunctionData({ abi: parseAbi(["function execute((address to,uint256 value,bytes data)[] calls)"]), args: [calls] });
const exec7579 = (callType: "00" | "01", exec: Hex) =>
  encodeFunctionData({ abi: parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]), args: [(`0x${callType}` + "00".repeat(31)) as Hex, exec] });
const ur = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const urSweepTo = (to: Address) =>
  encodeFunctionData({ abi: ur, args: ["0x04", [encodeAbiParameters(parseAbiParameters("address, address, uint256"), [TOKEN, to, 1n])], 0n] });

async function judge(policy: ReturnType<typeof basePolicy>, tx: Parameters<typeof sign>[0]) {
  return evaluateTx(policy, await parseSignedTx(await sign(tx)), { chainId: CHAIN, now: 1_000_000 });
}
/** A policy whose DEX entry has no function list at all. The loader refuses this; a hand-built Policy can still have it. */
function bareDex(extra: Record<string, unknown> = {}) {
  const p = basePolicy(extra);
  p.destinations.set(dex, {});
  return p;
}
const withDex = (rule: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  basePolicy({ ...extra, destinations: { [ALLOWED]: { type: "eoa" }, [MULTICALL3]: { selectors: ["aggregate3((address,bool,bytes)[])"] }, [DEX]: rule } });

describe("loading: every destination needs a function list or an explicit opt-in", () => {
  it("refuses a destination without selectors, with the address and the fixes", () => {
    expect(() => parsePolicy({ destinations: { [DEX]: {} } })).toThrow(PolicyError);
    expect(() => parsePolicy({ destinations: { [DEX]: {} } })).toThrow(
      new RegExp(`this destination has no "selectors" list: ${dex}\\. .*"type": "eoa".*"allowAnySelector": true`)
    );
  });
  it("names every destination lacking selectors in one error, and only those", () => {
    let msg = "";
    try {
      parsePolicy({ destinations: { [DEX]: {}, [ALLOWED]: { maxNativeWei: "1" }, [ATTACKER]: { type: "contract" }, [RECIPIENT]: { type: "eoa" }, [MULTICALL3]: { selectors: ["0x"] } } });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain(`these 3 destinations have no "selectors" list: ${dex}, ${ALLOWED.toLowerCase()}, ${ATTACKER.toLowerCase()}.`);
    expect(msg).not.toContain(RECIPIENT.toLowerCase());
    expect(msg).not.toContain(MULTICALL3.toLowerCase());
  });
  it("allowAnySelector: false is not an opt-in", () => {
    expect(() => parsePolicy({ destinations: { [DEX]: { allowAnySelector: false } } })).toThrow(/no "selectors" list/);
  });
  it("loads selectors lists, type eoa and allowAnySelector", () => {
    const p = parsePolicy({ destinations: { [DEX]: { selectors: [SWAP_SIG] }, [ALLOWED]: { type: "eoa" }, [ATTACKER]: { allowAnySelector: true }, [RECIPIENT]: { type: "contract", selectors: ["0x"] } } });
    expect(p.destinations.get(dex)).toEqual({ maxNativeWei: undefined, selectors: new Set([SWAP]) });
    expect(p.destinations.get(ALLOWED.toLowerCase())).toEqual({ maxNativeWei: undefined, eoa: true });
    expect(p.destinations.get(ATTACKER.toLowerCase())).toEqual({ maxNativeWei: undefined, anySelector: true });
    expect(p.destinations.get(RECIPIENT.toLowerCase())).toEqual({ maxNativeWei: undefined, selectors: new Set(["0x"]) });
  });
  it('refuses a "*" wildcard and points to allowAnySelector', () => {
    expect(() => parsePolicy({ destinations: { [DEX]: { selectors: "*" } } })).toThrow(/selectors: must be an array\. To allow every function .*"allowAnySelector": true/);
    expect(() => parsePolicy({ destinations: { [DEX]: { selectors: "0x12345678" } } })).toThrow(/selectors: must be an array$/);
  });
  it("refuses contradictory entries", () => {
    expect(() => parsePolicy({ destinations: { [DEX]: { selectors: [SWAP_SIG], allowAnySelector: true } } })).toThrow(/both "selectors" and "allowAnySelector"/);
    expect(() => parsePolicy({ destinations: { [DEX]: { type: "eoa", selectors: ["0x"] } } })).toThrow(/is "type": "eoa".*takes no "selectors"/);
    expect(() => parsePolicy({ destinations: { [DEX]: { type: "eoa", allowAnySelector: true } } })).toThrow(/is "type": "eoa"/);
    expect(() => parsePolicy({ destinations: { [DEX]: { type: "router", selectors: ["0x"] } } })).toThrow(/type: must be "eoa" or "contract"/);
    expect(() => parsePolicy({ destinations: { [DEX]: { allowAnySelector: "yes" } } })).toThrow(/allowAnySelector: must be a boolean/);
  });
  it("selectorWarnings: one loud warning per allowAnySelector destination, none otherwise", () => {
    const p = parsePolicy({ destinations: { [DEX]: { allowAnySelector: true }, [ALLOWED]: { type: "eoa" }, [ATTACKER]: { selectors: [SWAP_SIG] } } });
    const w = selectorWarnings(p);
    expect(w).toHaveLength(1);
    expect(w[0]).toBe(
      `destination ${dex} has "allowAnySelector": true. ANY function on it may be called, including ones that move or approve funds. List its functions in "selectors" instead unless you mean this`
    );
    expect(selectorWarnings(parsePolicy({ destinations: { [ATTACKER]: { selectors: [SWAP_SIG] } } }))).toEqual([]);
  });
});

describe("runtime: calldata to a destination without a function list is denied", () => {
  it("missing selectors: a contract call is denied with SELECTORS_REQUIRED", async () => {
    const v = await judge(bareDex(), { to: DEX, data: swapData });
    expect(v).toMatchObject({ allow: false, code: "SELECTORS_REQUIRED", path: "tx" });
    expect(v.reason).toBe(`${dex} has no "selectors" list, so function ${SWAP} on it is denied. List the functions it may be called with in "selectors", or set "allowAnySelector": true`);
  });
  it("missing selectors: a plain ETH transfer (empty calldata) is still allowed, within maxNativeWei", async () => {
    expect((await judge(bareDex(), { to: DEX, value: ETH / 100n })).allow).toBe(true);
    const p = bareDex();
    p.destinations.set(dex, { maxNativeWei: 5n });
    expect((await judge(p, { to: DEX, value: 6n })).code).toBe("OVER_CAP");
  });
  it("type eoa: plain ETH transfers work without selectors; any calldata is denied", async () => {
    const p = withDex({ type: "eoa", maxNativeWei: (ETH / 50n).toString() });
    expect((await judge(p, { to: DEX, value: ETH / 100n })).allow).toBe(true);
    expect((await judge(p, { to: DEX, value: ETH / 20n })).code).toBe("OVER_CAP");
    const v = await judge(p, { to: DEX, data: swapData });
    expect(v).toMatchObject({ allow: false, code: "SELECTOR_NOT_ALLOWED" });
    expect(v.reason).toBe(`${dex} is declared "type": "eoa" (plain ETH transfers only), so function ${SWAP} on it is denied`);
  });
  it("calldata shorter than a selector is not a plain transfer", async () => {
    // One to three bytes of calldata run the contract's fallback, so "0x" in the list does not cover them.
    const v = await judge(withDex({ selectors: ["0x"] }), { to: DEX, data: "0xabcdef" });
    expect(v).toMatchObject({ allow: false, code: "SELECTOR_NOT_ALLOWED" });
    expect(v.reason).toMatch(/shorter than a 4-byte selector/);
    expect((await judge(withDex({ type: "eoa" }), { to: DEX, data: "0xab" })).code).toBe("SELECTOR_NOT_ALLOWED");
    expect((await judge(bareDex(), { to: DEX, data: "0xab" })).code).toBe("SELECTORS_REQUIRED");
    expect((await judge(withDex({ selectors: ["0x"] }), { to: DEX, data: "0x" })).allow).toBe(true);
  });
  it("a selectors list allows exactly its functions", async () => {
    const p = withDex({ selectors: [SWAP_SIG] });
    expect((await judge(p, { to: DEX, data: swapData })).allow).toBe(true);
    expect((await judge(p, { to: DEX, data: OTHER })).code).toBe("SELECTOR_NOT_ALLOWED");
    expect((await judge(p, { to: DEX, value: 1n })).code).toBe("SELECTOR_NOT_ALLOWED");
  });
  it("allowAnySelector: any function is allowed, and maxNativeWei and native caps still apply", async () => {
    const p = withDex({ allowAnySelector: true, maxNativeWei: "10" });
    expect((await judge(p, { to: DEX, data: OTHER })).allow).toBe(true);
    expect((await judge(p, { to: DEX, data: swapData, value: 10n })).allow).toBe(true);
    expect((await judge(p, { to: DEX, data: OTHER, value: 11n })).code).toBe("OVER_CAP");
  });
});

describe("wrapped and nested calls can't get around a destination's function list", () => {
  it("a wrapper destination with no list is denied at the wrapper", async () => {
    const p = basePolicy();
    p.destinations.set(MULTICALL3.toLowerCase(), {});
    const v = await judge(p, { to: MULTICALL3, data: aggregate3([{ target: ALLOWED, callData: "0x" }]) });
    expect(v).toMatchObject({ allow: false, code: "SELECTORS_REQUIRED", path: "tx" });
    expect(v.reason).toBe(`0xca11bde05977b3631167028862be2a173976ca11 has no "selectors" list, so function 0x82ad56cb (aggregate3) on it is denied. List the functions it may be called with in "selectors", or set "allowAnySelector": true`);
  });
  it("the router's own multicall: every entry is checked against the router's list", async () => {
    const p = withDex({ selectors: ["multicall(bytes[])", SWAP_SIG] });
    expect((await judge(p, { to: DEX, data: multicall([swapData]) })).allow).toBe(true);
    const v = await judge(p, { to: DEX, data: multicall([swapData, OTHER]) });
    expect(v).toMatchObject({ allow: false, code: "SELECTOR_NOT_ALLOWED", path: "tx>multicall[1]" });
    // A router listed only for its swap can't be entered through multicall at all.
    expect((await judge(withDex({ selectors: [SWAP_SIG] }), { to: DEX, data: multicall([swapData]) })).code).toBe("SELECTOR_NOT_ALLOWED");
  });
  it("a router with allowAnySelector still has its multicall entries judged as calls", async () => {
    const p = withDex({ allowAnySelector: true });
    // approve(…, MAX) delegatecalled on the router is a token call on a contract that is not a listed token.
    expect((await judge(p, { to: DEX, data: multicall([approveMax]) })).code).toBe("TOKEN_NOT_ALLOWED");
    // Universal Router commands under it are still decoded: a sweep to an attacker is denied.
    expect((await judge(p, { to: DEX, data: urSweepTo(ATTACKER) })).code).toBe("ROUTER_RECIPIENT_NOT_ALLOWED");
  });
  it("Multicall3 → router: the inner call needs the router's list", async () => {
    const mc = (rule: Record<string, unknown>, callData: Hex) => judge(withDex(rule), { to: MULTICALL3, data: aggregate3([{ target: DEX, callData }]) });
    expect((await mc({ selectors: [SWAP_SIG] }, swapData)).allow).toBe(true);
    expect(await mc({ selectors: [SWAP_SIG] }, OTHER)).toMatchObject({ code: "SELECTOR_NOT_ALLOWED", path: "tx>aggregate3[0]" });
    expect(await mc({ type: "eoa" }, swapData)).toMatchObject({ code: "SELECTOR_NOT_ALLOWED", path: "tx>aggregate3[0]" });
    const p = bareDex();
    expect(await judge(p, { to: MULTICALL3, data: aggregate3([{ target: DEX, callData: swapData }]) })).toMatchObject({ code: "SELECTORS_REQUIRED", path: "tx>aggregate3[0]" });
  });
  it("Multicall3 → router multicall → entry: checked two levels down", async () => {
    const p = withDex({ selectors: ["multicall(bytes[])", SWAP_SIG] });
    const deep = aggregate3([{ target: DEX, callData: multicall([swapData, OTHER]) }]);
    expect(await judge(p, { to: MULTICALL3, data: deep })).toMatchObject({ allow: false, code: "SELECTOR_NOT_ALLOWED", path: "tx>aggregate3[0]>multicall[1]" });
  });
  it("the agent's Safe (execTransaction) → router: checked", async () => {
    const p = withDex({ selectors: [SWAP_SIG] }, { accounts: [SAFE] });
    expect((await judge(p, { to: SAFE, data: execTx(DEX, swapData) })).allow).toBe(true);
    expect(await judge(p, { to: SAFE, data: execTx(DEX, OTHER) })).toMatchObject({ code: "SELECTOR_NOT_ALLOWED", path: "tx>execTransaction[0]" });
  });
  it("ERC-7579 execute (single and batch) on the agent's account → router: checked", async () => {
    const p = withDex({ type: "eoa" }, { accounts: [SAFE] });
    const single = encodePacked(["address", "uint256", "bytes"], [DEX, 0n, swapData]);
    expect((await judge(p, { to: SAFE, data: exec7579("00", single) })).code).toBe("SELECTOR_NOT_ALLOWED");
    const b = encodeAbiParameters(parseAbiParameters("(address target, uint256 value, bytes callData)[]"), [[{ target: DEX, value: 0n, callData: swapData }]]);
    const bare = bareDex({ accounts: [SAFE] });
    expect((await judge(bare, { to: SAFE, data: exec7579("01", b) })).code).toBe("SELECTORS_REQUIRED");
  });
  it("EIP-7702: a self-batch through an allowed delegate still checks each call's destination list", async () => {
    const p = withDex({ selectors: [SWAP_SIG] }, { delegation: { mode: "allowlist", delegates: [DELEGATE_OK] } });
    const auth = await agent.signAuthorization({ contractAddress: DELEGATE_OK, chainId: CHAIN, nonce: 1 });
    const ok = batch7702([{ to: DEX, value: 0n, data: swapData }]);
    const bad = batch7702([{ to: DEX, value: 0n, data: swapData }, { to: DEX, value: 0n, data: OTHER }]);
    expect((await judge(p, { to: AGENT, data: ok, authorizationList: [auth] })).allow).toBe(true);
    expect(await judge(p, { to: AGENT, data: bad, authorizationList: [auth] })).toMatchObject({ code: "SELECTOR_NOT_ALLOWED", path: "tx>execute[1]" });
    // Without the authorization it is the same rule: the batch runs as the agent either way.
    expect(await judge(p, { to: AGENT, data: bad })).toMatchObject({ code: "SELECTOR_NOT_ALLOWED", path: "tx>execute[1]" });
  });
  it("EIP-7702: an address declared type eoa that has since been delegated still takes no calldata", async () => {
    // The guard is offline and never asks whether an address has code. Calldata alone decides.
    const p = withDex({ type: "eoa" }, { delegation: { mode: "allowlist", delegates: [DELEGATE_OK] } });
    const auth = await agent.signAuthorization({ contractAddress: DELEGATE_OK, chainId: CHAIN, nonce: 1 });
    expect((await judge(p, { to: DEX, data: batch7702([]), authorizationList: [auth] })).code).toBe("SELECTOR_NOT_ALLOWED");
    expect((await judge(p, { to: DEX, value: 1n, authorizationList: [auth] })).allow).toBe(true);
  });
});

describe("ETH sent along with a token call", () => {
  const transfer = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [RECIPIENT, 1n] });
  it("needs the token's destination entry to allow that function, and its maxNativeWei", async () => {
    const as = (rule: Record<string, unknown>) => basePolicy({ destinations: { [TOKEN]: rule } });
    expect((await judge(as({ selectors: ["transfer(address,uint256)"], maxNativeWei: "5" }), { to: TOKEN, data: transfer, value: 5n })).allow).toBe(true);
    expect((await judge(as({ selectors: ["transfer(address,uint256)"], maxNativeWei: "5" }), { to: TOKEN, data: transfer, value: 6n })).code).toBe("OVER_CAP");
    expect((await judge(as({ selectors: ["0x"] }), { to: TOKEN, data: transfer, value: 1n })).code).toBe("SELECTOR_NOT_ALLOWED");
    expect((await judge(as({ type: "eoa" }), { to: TOKEN, data: transfer, value: 1n })).code).toBe("SELECTOR_NOT_ALLOWED");
    // No value: the token rules alone decide, as before.
    expect((await judge(as({ type: "eoa" }), { to: TOKEN, data: transfer })).allow).toBe(true);
  });
});

describe("migrate-policy writes value-only destinations", () => {
  it("0.x destinations become type eoa, which refuses calldata, with a note", () => {
    const { policy, notes } = migrateLegacyPolicy({ destinations: { [DEX]: { maxNativeWei: "1000" } } });
    expect(policy.destinations).toEqual({ [dex]: { maxNativeWei: "1000", type: "eoa" } });
    expect(notes.join("\n")).toMatch(/"type": "eoa" \(plain ETH transfers only\)\. For a contract you call, replace it with a "selectors" list/);
    const p = parsePolicy(policy);
    const tx = { from: AGENT, to: DEX, value: 0n, data: swapData, authorizationList: [] };
    expect(evaluateTx(p, tx as never, { chainId: CHAIN }).code).toBe("SELECTOR_NOT_ALLOWED");
    expect(evaluateTx(p, { ...tx, value: 1000n, data: "0x" } as never, { chainId: CHAIN }).allow).toBe(true);
  });
  it("no note when there are no destinations", () => {
    expect(migrateLegacyPolicy({ erc20RecipientCheck: false }).notes.join("\n")).not.toMatch(/type/);
  });
});

/** Start `serve` with a policy file; resolve with its stderr once it logs `until` or exits. */
function serve(policy: unknown, until: RegExp): Promise<{ stderr: string; exited: number | null }> {
  const f = join(mkdtempSync(join(tmpdir(), "l2sg-sel-")), "policy.json");
  writeFileSync(f, JSON.stringify(policy));
  const child = spawn(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts", "serve"], {
    env: { ...process.env, L2SG_POLICY_FILE: f, L2SG_STORE: "memory", L2SG_PORT: "0", L2SG_CHAINS: "arb-sepolia", L2SG_RPC_ARB_SEPOLIA: "http://127.0.0.1:9", L2SG_BYPASS: "off" },
  });
  let stderr = "";
  let stdout = "";
  return new Promise((resolve) => {
    const done = (exited: number | null) => {
      child.kill();
      resolve({ stderr, exited });
    };
    child.stderr.on("data", (c) => {
      stderr += c;
      if (until.test(stderr)) done(null);
    });
    child.stdout.on("data", (c) => {
      stdout += c;
      if (/listening/.test(stdout)) setTimeout(() => done(null), 200);
    });
    child.on("exit", (code) => resolve({ stderr, exited: code }));
  });
}

describe("serve startup", () => {
  it("refuses to start when a destination has no selectors, naming it", async () => {
    const r = await serve({ destinations: { [DEX]: {} } }, /refusing to start/);
    expect(r.stderr).toContain(`refusing to start: `);
    expect(r.stderr).toContain(`this destination has no "selectors" list: ${dex}`);
  }, 30_000);
  it("starts with allowAnySelector and prints a loud WARNING for it", async () => {
    const r = await serve({ destinations: { [DEX]: { allowAnySelector: true }, [ALLOWED]: { type: "eoa" } } }, /WARNING/);
    expect(r.stderr).toContain(`[l2-send-guard] WARNING: destination ${dex} has "allowAnySelector": true. ANY function on it may be called`);
    expect(r.stderr).not.toContain(ALLOWED.toLowerCase());
  }, 30_000);
});

describe("through the proxy", () => {
  it("SELECTORS_REQUIRED is a -32083 with a hint, and nothing is forwarded", async () => {
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xok" }));
    const simulate = vi.fn();
    const config = {
      listenHost: "127.0.0.1", listenPort: 0, guardMode: "strict", failOpen: false, defaultChain: "base",
      guard: new Guard({ policy: bareDex(), store: new MemoryStore() }),
      chains: { base: { id: "base", name: "Base", chainId: CHAIN, upstreamRpcUrl: "http://up", preferSimulateV1: true, ecosystem: "op" } },
    } as unknown as GuardConfig;
    const raw = await sign({ to: DEX, data: swapData, nonce: 0 });
    const r = await handleRequest(config, { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] } as never, undefined, { simulate, forward } as never);
    expect(r.error?.code).toBe(-32083);
    expect(r.error?.data).toMatchObject({
      policyCode: "SELECTORS_REQUIRED",
      hint: 'This destination has no "selectors" list, so no function on it may be called. Add the function to its "selectors" in the policy.',
    });
    expect(forward).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });
});

describe("shipped examples are fail-closed", () => {
  const closed = (p: ReturnType<typeof parsePolicy>) => {
    expect(selectorWarnings(p)).toEqual([]);
    for (const r of p.destinations.values()) expect(r.anySelector || (!r.selectors && !r.eoa)).toBeFalsy();
  };
  it.each(["policy.example.json", "policy.agent.example.json"])("%s loads with a function list or type eoa on every destination", (f) => {
    const p = parsePolicy(JSON.parse(readFileSync(f, "utf8")), f);
    expect(p.destinations.size).toBeGreaterThan(0);
    closed(p);
  });
  it("the README quickstart policy loads (placeholders filled in)", () => {
    const readme = readFileSync("README.md", "utf8");
    const block = readme.slice(readme.indexOf("**2. Write your policy.**")).match(/```json\n([\s\S]*?)```/)![1]!;
    const load = () => parsePolicy(JSON.parse(block.replace(/0xYourPayee…/g, ALLOWED)), "README");
    expect(load).not.toThrow();
    const p = load();
    expect(p.destinations.get(ALLOWED.toLowerCase())).toMatchObject({ eoa: true });
    closed(p);
  });
});
