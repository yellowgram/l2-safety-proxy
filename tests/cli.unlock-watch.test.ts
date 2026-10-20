import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, pad } from "viem";
import { FileStore, Guard, MemoryStore, parsePolicy, TOPICS } from "../src/guard/index.js";
import { startWatch } from "../src/config/guard.js";
import type { GuardConfig } from "../src/types/index.js";

const run = promisify(execFile);
const SENDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PAYEE = "0x1111111111111111111111111111111111111111";

type Handler = (method: string, params: unknown[]) => unknown;
const servers: http.Server[] = [];
async function mockRpc(handler: Handler): Promise<string> {
  const s = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(b);
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: handler(method, params) }));
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

describe("l2-send-guard unlock", () => {
  it("resets the baseline to the on-chain nonce, so the next check is not re-locked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "l2sg-unlock-"));
    const path = join(dir, "state.jsonl");
    const s1 = new FileStore(path);
    await s1.setBaseline(421614, SENDER, 0);
    await s1.lock(421614, SENDER, "test bypass", 1);
    await s1.close();

    const url = await mockRpc((m) => (m === "eth_getTransactionCount" ? "0x5" : null));
    await run(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts", "unlock", SENDER, "--chain", "421614"], {
      env: { ...process.env, L2SG_STORE: `file:${path}`, L2SG_CHAINS: "arb-sepolia", L2SG_RPC_ARB_SEPOLIA: url },
    });

    const s2 = new FileStore(path);
    const st = await s2.senderState(421614, SENDER);
    expect(st.locked).toBeUndefined();
    expect(st.baseline).toBe(5);
    await s2.close();
  }, 30_000);
});

describe("receive watch in serve", () => {
  it("marks a look-alike sender as poisoned in the guard's store and reports it", async () => {
    const lookalike = PAYEE.slice(0, 10) + "9".repeat(24) + PAYEE.slice(-8);
    const log = {
      address: "0x3333333333333333333333333333333333333333",
      topics: [TOPICS.Transfer, pad(lookalike as `0x${string}`, { size: 32 }), pad(SENDER as `0x${string}`, { size: 32 })],
      data: encodeAbiParameters([{ type: "uint256" }], [0n]),
      transactionHash: "0x" + "cd".repeat(32),
      logIndex: "0x0",
      blockNumber: "0x10",
    };
    const url = await mockRpc((m, p) => {
      if (m === "eth_blockNumber") return "0x12";
      if (m === "eth_getLogs") {
        const topics = (p[0] as { topics: unknown[] }).topics;
        return topics[0] === TOPICS.Transfer && topics[1] === null ? [log] : [];
      }
      return null;
    });
    const policy = parsePolicy({ destinations: { [PAYEE]: {} } });
    const store = new MemoryStore();
    const config = {
      chains: { "arb-sepolia": { id: "arb-sepolia", name: "Arbitrum Sepolia", chainId: 421614, upstreamRpcUrl: url, preferSimulateV1: true, ecosystem: "arbitrum" } },
      guard: new Guard({ policy, store }),
      guardSpec: { policy, store: { kind: "memory" }, idempotencyTtlSeconds: 60, bypass: "lock", watch: { agents: [SENDER], expectedSenders: [], dustRaw: 0n, intervalSeconds: 3600 } },
    } as unknown as GuardConfig;
    const lines: string[] = [];
    const stop = startWatch(config, (l) => lines.push(l));
    for (let i = 0; i < 50 && (await store.poisoned()).size === 0; i++) await new Promise((r) => setTimeout(r, 20));
    stop();
    expect([...(await store.poisoned())]).toContain(lookalike.toLowerCase());
    expect(lines.join("\n")).toMatch(/RECEIVE: .*lookalike_sender/);
  });

  it("is off without L2SG_WATCH_AGENTS", () => {
    const stop = startWatch({ chains: {}, guardSpec: { policy: parsePolicy({}) } } as unknown as GuardConfig);
    expect(typeof stop).toBe("function");
  });
});
