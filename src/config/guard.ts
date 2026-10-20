import type { Address, Hex } from "viem";
import { Guard, type BypassEvent, type ChainReader } from "../guard/guard.js";
import { FileStore } from "../guard/store/file.js";
import { MemoryStore } from "../guard/store/memory.js";
import { PostgresStore } from "../guard/store/postgres.js";
import type { GuardStore } from "../guard/store/types.js";
import { watchInbound, type Finding } from "../guard/receive/index.js";
import { createRpcCaller } from "../sim/rpcClient.js";
import type { GuardConfig, GuardSpec } from "../types/index.js";

export async function openStore(spec: GuardSpec["store"]): Promise<GuardStore> {
  if (spec.kind === "memory") return new MemoryStore();
  if (spec.kind === "file") return new FileStore(spec.path);
  return PostgresStore.connect(spec.url);
}

/** Read-only chain access for bypass detection and in-flight recovery, over the chain's upstream RPC. */
export function rpcReader(url: string): ChainReader {
  const call = createRpcCaller(url);
  return {
    async getNonce(address: Address) {
      return Number(BigInt((await call("eth_getTransactionCount", [address, "latest"])) as string));
    },
    async hasTransaction(hash: Hex) {
      return (await call("eth_getTransactionByHash", [hash])) != null;
    },
  };
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

async function post(url: string | undefined, body: Record<string, unknown>): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`[l2-send-guard] alert webhook failed: ${(err as Error).message}`);
  }
}

async function alert(url: string | undefined, e: BypassEvent): Promise<void> {
  console.error(`[l2-send-guard] BYPASS: ${json(e)}`);
  await post(url, { event: "bypass_detected", ...e });
}

/** Findings worth a human's attention: anything not clear, and approvals the policy wouldn't grant. */
export function isAlarming(f: Finding): boolean {
  return f.kind === "inbound" ? f.asset.label !== "clear" : !f.expected;
}

/**
 * Start the receive-side watch on every configured chain (L2SG_WATCH_AGENTS).
 * Findings go to the same store the guard reads, so a poisoner's address is
 * refused as a destination from the next send on. Returns a stop function.
 */
export function startWatch(config: GuardConfig, log: (line: string) => void = (l) => console.error(l)): () => void {
  const spec = config.guardSpec;
  const store = config.guard?.store;
  if (!spec?.watch || !store) return () => {};
  const w = spec.watch;
  const stops = Object.values(config.chains).map((c) => {
    const call = createRpcCaller(c.upstreamRpcUrl);
    return watchInbound({
      provider: { request: ({ method, params }) => call(method, params ?? []) },
      store,
      policy: spec.policy,
      chainId: c.chainId,
      agents: w.agents as Address[],
      expectedSenders: w.expectedSenders as Address[],
      dustRaw: w.dustRaw,
      lockOnUnexpectedApproval: spec.bypass === "lock",
      intervalMs: w.intervalSeconds * 1000,
      onFinding: async (f) => {
        if (!isAlarming(f)) return;
        log(`[l2-send-guard] RECEIVE: ${json({ chainId: c.chainId, ...f })}`);
        await post(spec.alertWebhook, { event: "receive_finding", chainId: c.chainId, ...f });
      },
      onError: (e) => log(`[l2-send-guard] watch on ${c.id} failed this round: ${(e as Error).message}`),
    });
  });
  return () => stops.forEach((s) => s());
}

/** Open the store and build the Guard that loadConfig described. No-op in simulation-only mode. */
export async function createGuardFromConfig(config: GuardConfig): Promise<GuardConfig> {
  const spec = config.guardSpec;
  if (!spec || config.guard) return config;
  const store = await openStore(spec.store);
  const readers = new Map<number, ChainReader>();
  for (const c of Object.values(config.chains)) readers.set(c.chainId, rpcReader(c.upstreamRpcUrl));
  config.guard = new Guard({
    policy: spec.policy,
    store,
    readers,
    detectBypass: spec.bypass !== "off",
    lockOnBypass: spec.bypass === "lock",
    onBypass: (e) => alert(spec.alertWebhook, e),
    idempotencyTtlSeconds: spec.idempotencyTtlSeconds,
  });
  return config;
}
