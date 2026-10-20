import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { handleRequest } from "../src/proxy/handler.js";
import { simulateRawTransaction } from "../src/sim/simulator.js";
import { clearAllCapabilityCaches } from "../src/sim/capabilityCache.js";
import type { ChainReader } from "../src/guard/guard.js";
import type { GuardConfig, JsonRpcRequest, SimResult } from "../src/types/index.js";
import { guardWith } from "./support/guard.js";

const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const CHAIN_ID = 421614;
const OK = "0x1111111111111111111111111111111111111111" as const;
const BAD = "0x2222222222222222222222222222222222222222" as const;
const DELEGATE = "0x7777777777777777777777777777777777777777" as const;
const ETH = 10n ** 18n;

const chain = {
  id: "arb-sepolia",
  name: "Arbitrum Sepolia",
  chainId: CHAIN_ID,
  upstreamRpcUrl: "http://up",
  preferSimulateV1: true,
  ecosystem: "arbitrum" as const,
};

function config(policy: unknown = { destinations: { [OK]: {} } }, extra: Partial<GuardConfig> = {}, guardOpts = {}): GuardConfig {
  return {
    listenHost: "127.0.0.1",
    listenPort: 0,
    guardMode: "strict",
    failOpen: false,
    defaultChain: "arb-sepolia",
    chains: { "arb-sepolia": chain },
    guard: guardWith(policy, guardOpts),
    ...extra,
  };
}

function sign(to: `0x${string}`, nonce: number, value = 1n) {
  return acct.signTransaction({ chainId: CHAIN_ID, nonce, to, value, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
}

const okSim = vi.fn(async (): Promise<SimResult> => ({ ok: true, method: "eth_simulateV1", confidence: "definite" }));
const req = (method: string, params: unknown[], id = 1): JsonRpcRequest => ({ jsonrpc: "2.0", id, method, params });

beforeEach(() => {
  okSim.mockClear();
  clearAllCapabilityCaches();
});

describe("1.0 proxy gate", () => {
  it("denies a 7702 authorization to a delegate the policy doesn't list, without simulating", async () => {
    const auth = await acct.signAuthorization({ contractAddress: "0x000000000000000000000000000000000000dEaD", chainId: CHAIN_ID, nonce: 1 });
    const raw = await acct.signTransaction({ type: "eip7702", chainId: CHAIN_ID, nonce: 0, to: OK, value: 0n, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, authorizationList: [auth] });
    const forward = vi.fn();
    const res = await handleRequest(config(), req("eth_sendRawTransaction", [raw]), undefined, { simulate: okSim, forward });
    expect(forward).not.toHaveBeenCalled();
    expect(okSim).not.toHaveBeenCalled();
    expect(res.error?.code).toBe(-32083);
    expect((res.error?.data as { policyCode: string }).policyCode).toBe("AUTHORIZATION_DENIED");
  });

  it.each([
    ["eth_sendRawTransactionConditional", (raw: string) => [raw, { knownAccounts: {} }]],
    ["eth_sendPrivateRawTransaction", (raw: string) => [raw]],
    ["eth_sendPrivateTransaction", (raw: string) => [{ tx: raw, maxBlockNumber: "0x10" }]],
    ["eth_sendBundle", (raw: string) => [{ txs: [raw], blockNumber: "0x10" }]],
    ["mev_sendBundle", (raw: string) => [{ version: "v0.1", inclusion: { block: "0x10" }, body: [{ hash: "0x" + "ab".repeat(32) }, { bundle: { body: [{ tx: raw }] } }] }]],
  ])("gates %s like eth_sendRawTransaction", async (method, params) => {
    const raw = await sign(BAD, 0);
    const forward = vi.fn();
    const res = await handleRequest(config(), req(method, params(raw)), undefined, { simulate: okSim, forward });
    expect(forward).not.toHaveBeenCalled();
    expect(res.error?.code).toBe(-32083);
    expect((res.error?.data as { policyCode: string }).policyCode).toBe("DESTINATION_NOT_ALLOWED");
  });

  it("denies a whole bundle when one tx fails and gives back what the others reserved", async () => {
    const policy = { window: { seconds: 3600 }, native: { windowMaxWei: (2n * ETH).toString() }, destinations: { [OK]: {} } };
    const cfg = config(policy);
    const good = await sign(OK, 0, 2n * ETH);
    const bad = await sign(BAD, 1, 1n);
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xbundle" }));
    const denied = await handleRequest(cfg, req("eth_sendBundle", [{ txs: [good, bad] }]), undefined, { simulate: okSim, forward });
    expect(denied.error?.code).toBe(-32083);
    expect((denied.error?.data as { index: number }).index).toBe(1);
    expect(forward).not.toHaveBeenCalled();
    // The 2 ETH reserved for tx 0 was released, so it fits the window again.
    const alone = await handleRequest(cfg, req("eth_sendBundle", [{ txs: [good] }]), undefined, { simulate: okSim, forward });
    expect(alone.error).toBeUndefined();
    expect(alone.l2sg?.simMethod).toBe("unavailable");
    expect(okSim).not.toHaveBeenCalled();
  });

  it.each(["eth_signTransaction", "eth_sign", "personal_sign", "eth_signTypedData_v4", "wallet_sendCalls"])("refuses %s: the guard holds no keys", async (method) => {
    const forward = vi.fn();
    const res = await handleRequest(config(), req(method, [{}]), undefined, { simulate: okSim, forward });
    expect(res.error?.code).toBe(-32081);
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses submit-like methods it can't check, and passes reads through", async () => {
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0x1" }));
    const op = await handleRequest(config(), req("eth_sendUserOperation", [{}, OK]), undefined, { forward });
    expect(op.error?.code).toBe(-32083);
    expect((op.error?.data as { policyCode: string }).policyCode).toBe("METHOD_NOT_GATED");
    const read = await handleRequest(config(), req("eth_getTransactionBySenderAndNonce", [OK, "0x0"]), undefined, { forward });
    expect(read.result).toBe("0x1");
  });

  it("Idempotency-Key: same bytes are answered with the hash; a different nonce is a conflict", async () => {
    const cfg = config();
    const first = await sign(OK, 7);
    const headers = new Headers({ "idempotency-key": "order-42" });
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xhash" }));
    expect((await handleRequest(cfg, req("eth_sendRawTransaction", [first]), headers, { simulate: okSim, forward })).result).toBe("0xhash");

    const known = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, error: { code: -32000, message: "already known" } }));
    const again = await handleRequest(cfg, req("eth_sendRawTransaction", [first]), headers, { simulate: okSim, forward: known });
    expect(again.error).toBeUndefined();
    expect(again.result).toMatch(/^0x[0-9a-f]{64}$/);
    expect(again.l2sg?.replay).toBe(true);

    const other = await sign(OK, 8);
    const conflict = await handleRequest(cfg, req("eth_sendRawTransaction", [other]), headers, { simulate: okSim, forward });
    expect(conflict.error?.code).toBe(-32087);
    expect((conflict.error?.data as { priorTxHash: string }).priorTxHash).toBe(again.result);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("an idempotent retry of a sent transaction returns its hash without simulating or sending again", async () => {
    const cfg = config({ destinations: { [OK]: {} } });
    const headers = new Headers({ "idempotency-key": "pay-1" });
    const raw = await sign(OK, 0, ETH);
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xupstream" }));
    expect((await handleRequest(cfg, req("eth_sendRawTransaction", [raw]), headers, { simulate: okSim, forward })).result).toBe("0xupstream");
    // Mined now: a fresh simulation would fail on the used nonce.
    const nonceUsed = vi.fn(async (): Promise<SimResult> => ({ ok: false, method: "eth_call", confidence: "definite", reason: "nonce too low", code: "DEFINITE_REVERT" }));
    const again = await handleRequest(cfg, req("eth_sendRawTransaction", [raw]), headers, { simulate: nonceUsed, forward });
    expect(again.error).toBeUndefined();
    expect(again.result).toMatch(/^0x[0-9a-f]{64}$/);
    expect(nonceUsed).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("an idempotent retry after an unknown outcome rebroadcasts the same bytes without simulating", async () => {
    const cfg = config({ destinations: { [OK]: {} } });
    const headers = new Headers({ "idempotency-key": "pay-2" });
    const raw = await sign(OK, 0, ETH);
    const flaky = vi.fn(async () => { throw new Error("socket hang up"); });
    await expect(handleRequest(cfg, req("eth_sendRawTransaction", [raw]), headers, { simulate: okSim, forward: flaky })).rejects.toThrow();
    const sim = vi.fn(okSim);
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xupstream" }));
    const again = await handleRequest(cfg, req("eth_sendRawTransaction", [raw]), headers, { simulate: sim, forward });
    expect(again.result).toBe("0xupstream");
    expect(sim).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("a definite revert gives back the reserved cap and frees the idempotency key", async () => {
    const policy = { window: { seconds: 3600 }, native: { windowMaxWei: ETH.toString() }, destinations: { [OK]: {} } };
    const cfg = config(policy);
    const headers = new Headers({ "idempotency-key": "k1" });
    const revert = vi.fn(async (): Promise<SimResult> => ({ ok: false, method: "eth_call", confidence: "definite", reason: "nope", code: "DEFINITE_REVERT" }));
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xhash" }));
    const a = await handleRequest(cfg, req("eth_sendRawTransaction", [await sign(OK, 0, ETH)]), headers, { simulate: revert, forward });
    expect(a.error?.code).toBe(-32080);
    const b = await handleRequest(cfg, req("eth_sendRawTransaction", [await sign(OK, 1, ETH)]), headers, { simulate: okSim, forward });
    expect(b.result).toBe("0xhash");
  });

  it("a send after an unseen transaction from the same sender is locked (-32088)", async () => {
    const reader: ChainReader = { getNonce: async () => 5, hasTransaction: async () => false };
    const cfg = config(undefined, {}, { readers: new Map([[CHAIN_ID, reader]]) });
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xhash" }));
    // First sight records the baseline; the chain then moves past it without the guard.
    expect((await handleRequest(cfg, req("eth_sendRawTransaction", [await sign(OK, 5)]), undefined, { simulate: okSim, forward })).result).toBe("0xhash");
    reader.getNonce = async () => 8;
    const res = await handleRequest(cfg, req("eth_sendRawTransaction", [await sign(OK, 8)]), undefined, { simulate: okSim, forward });
    expect(res.error?.code).toBe(-32088);
  });

  it("an RPC failure during the bypass check is reported as CHAIN_READ_FAILED, not a store outage", async () => {
    const reader: ChainReader = { getNonce: async () => { throw new Error("ECONNRESET"); }, hasTransaction: async () => false };
    const cfg = config(undefined, {}, { readers: new Map([[CHAIN_ID, reader]]) });
    const forward = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: "0xhash" }));
    const res = await handleRequest(cfg, req("eth_sendRawTransaction", [await sign(OK, 0)]), undefined, { simulate: okSim, forward });
    expect(res.error?.code).toBe(-32087);
    expect((res.error?.data as { policyCode: string }).policyCode).toBe("CHAIN_READ_FAILED");
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("7702 simulation", () => {
  async function delegatedTx(authNonce: number) {
    const auth = await acct.signAuthorization({ contractAddress: DELEGATE, chainId: CHAIN_ID, nonce: authNonce });
    return acct.signTransaction({ type: "eip7702", chainId: CHAIN_ID, nonce: 3, to: acct.address, value: 0n, data: "0x", gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, authorizationList: [auth] });
  }

  it("runs eth_simulateV1 with the delegation installed on the authority", async () => {
    const raw = await delegatedTx(4); // self-sponsored: the tx uses nonce 3, the authorization 4
    const calls: { method: string; params: unknown[] }[] = [];
    const call = async (method: string, params: unknown[] = []) => {
      calls.push({ method, params });
      if (method === "eth_getTransactionCount") return "0x3";
      if (method === "eth_simulateV1") return [{ calls: [{ status: "0x1", returnData: "0x", logs: [] }] }];
      throw new Error(`unexpected ${method}`);
    };
    const r = await simulateRawTransaction(chain, raw as Hex, { call });
    expect(r.ok).toBe(true);
    const sim = calls.find((c) => c.method === "eth_simulateV1")!;
    const block = (sim.params[0] as { blockStateCalls: { stateOverrides?: Record<string, { code: string }> }[] }[])[0]!.blockStateCalls[0]!;
    expect(block.stateOverrides?.[acct.address.toLowerCase()]?.code).toBe(`0xef0100${DELEGATE.slice(2)}`);
  });

  it("skips an authorization the chain would skip (nonce mismatch)", async () => {
    const raw = await delegatedTx(9);
    const calls: { method: string; params: unknown[] }[] = [];
    const call = async (method: string, params: unknown[] = []) => {
      calls.push({ method, params });
      if (method === "eth_getTransactionCount") return "0x3";
      return [{ calls: [{ status: "0x1", returnData: "0x", logs: [] }] }];
    };
    await simulateRawTransaction(chain, raw as Hex, { call });
    const block = (calls.find((c) => c.method === "eth_simulateV1")!.params[0] as { blockStateCalls: { stateOverrides?: object }[] }[])[0]!.blockStateCalls[0]!;
    expect(block.stateOverrides).toBeUndefined();
  });

  it("is uncertain on an RPC that ignores eth_call state overrides", async () => {
    const raw = await delegatedTx(4);
    const call = async (method: string, params: unknown[] = []) => {
      if (method === "eth_getTransactionCount") return "0x3";
      if (method === "eth_simulateV1") throw Object.assign(new Error("method not found"), { code: -32601 });
      if (method === "eth_call") return params.length === 3 && (params[0] as { to: string }).to.endsWith("ff7a2") ? "0x" : "0x";
      throw new Error(method);
    };
    const r = await simulateRawTransaction(chain, raw as Hex, { call });
    expect(r.ok).toBe(false);
    expect(r.confidence).toBe("uncertain");
  });

  it("passes overrides to eth_call when the RPC honours them", async () => {
    const raw = await delegatedTx(4);
    const seen: unknown[][] = [];
    const call = async (method: string, params: unknown[] = []) => {
      if (method === "eth_getTransactionCount") return "0x3";
      if (method === "eth_simulateV1") throw Object.assign(new Error("method not found"), { code: -32601 });
      if (method === "eth_call") {
        seen.push(params);
        return (params[0] as { to: string }).to.endsWith("ff7a2") ? "0x" + "0".repeat(63) + "1" : "0x";
      }
      throw new Error(method);
    };
    const r = await simulateRawTransaction(chain, raw as Hex, { call });
    expect(r.ok).toBe(true);
    const real = seen.find((p) => !(p[0] as { to: string }).to.endsWith("ff7a2"))!;
    expect((real[2] as Record<string, { code: string }>)[acct.address.toLowerCase()]?.code).toBe(`0xef0100${DELEGATE.slice(2)}`);
  });
});
