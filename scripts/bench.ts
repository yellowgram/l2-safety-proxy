/**
 * Mocked latency bench: raw send vs guarded send.
 * No capital, no mainnet, no live RPC — local HTTP mocks only.
 *
 * Usage: npm run bench
 * See BENCH.md for methodology.
 */
import http from "node:http";
import { performance } from "node:perf_hooks";
import { createServer } from "../src/proxy/server.js";
import type { GuardConfig } from "../src/types/index.js";
import { clearSimulateV1CapabilityCache } from "../src/sim/capabilityCache.js";
import { FAKE_RAW } from "../tests/fixtures.js";

const ITERATIONS = Number(process.env.L2SG_BENCH_ITERS ?? 40);
const WARMUP = Number(process.env.L2SG_BENCH_WARMUP ?? 5);

type Stats = { samples: number[]; mean: number; p50: number; p95: number };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx]!;
}

function summarize(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / (samples.length || 1);
  return {
    samples,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

function startMockUpstream(opts: {
  simulateV1Unsupported?: boolean;
  callLatencyMs?: number;
  sendLatencyMs?: number;
}): Promise<{ server: http.Server; url: string; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  const callLag = opts.callLatencyMs ?? 2;
  const sendLag = opts.sendLatencyMs ?? 2;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const method = body.method as string;
      counts[method] = (counts[method] ?? 0) + 1;

      const respond = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      const delay = (ms: number) =>
        new Promise<void>((r) => setTimeout(r, ms));

      void (async () => {
        if (method === "eth_simulateV1") {
          await delay(callLag);
          if (opts.simulateV1Unsupported) {
            respond({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32602, message: "Invalid params" },
            });
            return;
          }
          respond({
            jsonrpc: "2.0",
            id: body.id,
            result: [{ calls: [{ status: "0x1", returnData: "0x" }] }],
          });
          return;
        }
        if (method === "eth_call") {
          await delay(callLag);
          respond({ jsonrpc: "2.0", id: body.id, result: "0x" });
          return;
        }
        if (method === "eth_sendRawTransaction") {
          await delay(sendLag);
          respond({
            jsonrpc: "2.0",
            id: body.id,
            result:
              "0x" + "ab".repeat(32),
          });
          return;
        }
        respond({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: `unexpected ${method}` },
        });
      })();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, counts });
    });
  });
}

async function rpc(
  url: string,
  method: string,
  params: unknown[],
  headers?: Record<string, string>
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function measure(
  label: string,
  fn: () => Promise<void>
): Promise<Stats> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  const stats = summarize(samples);
  console.log(
    `${label}: n=${ITERATIONS} mean=${stats.mean.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`
  );
  return stats;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function main() {
  console.log("L2 Send Guard — mocked latency bench");
  console.log(`iterations=${ITERATIONS} warmup=${WARMUP} (local mocks only)\n`);

  // --- A: raw send directly to upstream (no guard) ---
  const rawUp = await startMockUpstream({ sendLatencyMs: 3 });
  const rawStats = await measure("raw send (direct upstream)", async () => {
    const res = (await rpc(rawUp.url, "eth_sendRawTransaction", [FAKE_RAW])) as {
      result?: string;
      error?: unknown;
    };
    if (!res.result) throw new Error("raw send failed");
  });
  await close(rawUp.server);

  // --- B: guarded send, preferSimulateV1=false (eth_call only) ---
  clearSimulateV1CapabilityCache();
  const callUp = await startMockUpstream({
    callLatencyMs: 3,
    sendLatencyMs: 3,
  });
  const callProxy = createServer({
    listenHost: "127.0.0.1",
    listenPort: 0,
    failOpen: true,
    defaultChain: "arb-sepolia",
    chains: {
      "arb-sepolia": {
        id: "arb-sepolia",
        name: "Arbitrum Sepolia",
        chainId: 421614,
        upstreamRpcUrl: callUp.url,
        preferSimulateV1: false,
        ecosystem: "arbitrum",
      },
    },
  } satisfies GuardConfig);
  await new Promise<void>((r) => callProxy.listen(0, "127.0.0.1", () => r()));
  const callAddr = callProxy.address();
  if (!callAddr || typeof callAddr === "string") throw new Error("no addr");
  const callUrl = `http://127.0.0.1:${callAddr.port}`;
  const guardedCallStats = await measure(
    "guarded send (eth_call only)",
    async () => {
      const res = (await rpc(callUrl, "eth_sendRawTransaction", [FAKE_RAW])) as {
        result?: string;
      };
      if (!res.result) throw new Error("guarded eth_call path failed");
    }
  );
  await close(callProxy);
  await close(callUp.server);

  // --- C: guarded send with V1 unsupported → cache → eth_call ---
  clearSimulateV1CapabilityCache();
  const v1Up = await startMockUpstream({
    simulateV1Unsupported: true,
    callLatencyMs: 3,
    sendLatencyMs: 3,
  });
  const v1Proxy = createServer({
    listenHost: "127.0.0.1",
    listenPort: 0,
    failOpen: true,
    defaultChain: "base-sepolia",
    chains: {
      "base-sepolia": {
        id: "base-sepolia",
        name: "Base Sepolia",
        chainId: 84532,
        upstreamRpcUrl: v1Up.url,
        preferSimulateV1: true,
        ecosystem: "base",
      },
    },
  } satisfies GuardConfig);
  await new Promise<void>((r) => v1Proxy.listen(0, "127.0.0.1", () => r()));
  const v1Addr = v1Proxy.address();
  if (!v1Addr || typeof v1Addr === "string") throw new Error("no addr");
  const v1Url = `http://127.0.0.1:${v1Addr.port}`;

  // First request populates capability cache (V1 + eth_call + send)
  await rpc(v1Url, "eth_sendRawTransaction", [FAKE_RAW]);
  const v1Before = { ...v1Up.counts };

  const cachedStats = await measure(
    "guarded send (after V1 capability-cache)",
    async () => {
      const res = (await rpc(v1Url, "eth_sendRawTransaction", [FAKE_RAW])) as {
        result?: string;
      };
      if (!res.result) throw new Error("cached path failed");
    }
  );

  const v1HitsDuringBench =
    (v1Up.counts["eth_simulateV1"] ?? 0) - (v1Before["eth_simulateV1"] ?? 0);
  console.log(
    `\ncapability-cache check: eth_simulateV1 hits during cached bench = ${v1HitsDuringBench} (expect 0)`
  );
  console.log(
    `upstream method counts (full process): ${JSON.stringify(v1Up.counts)}`
  );

  await close(v1Proxy);
  await close(v1Up.server);

  // --- Summary ---
  const overheadCall = guardedCallStats.mean - rawStats.mean;
  const overheadCached = cachedStats.mean - rawStats.mean;
  console.log("\n--- summary ---");
  console.log(
    `overhead eth_call-only vs raw: +${overheadCall.toFixed(2)}ms mean`
  );
  console.log(
    `overhead cached-guard vs raw:  +${overheadCached.toFixed(2)}ms mean`
  );
  console.log(
    "Note: absolute ms reflect local mock delays, not public RPC RTT. Compare relatives."
  );

  if (v1HitsDuringBench !== 0) {
    console.error("FAIL: capability cache did not skip eth_simulateV1");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
