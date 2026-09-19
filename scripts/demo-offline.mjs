/**
 * Offline integrator demo — no public RPC, keys, or capital.
 * Spins a mock upstream + real proxy; shows:
 *   1) definite-revert abort (-32080, not forwarded)
 *   2) uncertain sim → fail-open forward
 *
 * Usage (after npm run build):
 *   node scripts/demo-offline.mjs
 */
import http from "node:http";
import { createServer } from "../dist/proxy/server.js";
import { encodeErrorResult } from "viem";

// Anvil #0 signed EIP-1559 tx (Arb Sepolia chainId) — public test fixture only
const FAKE_RAW =
  "0x02f86d83066eee80843b9aca00843b9aca008252089400000000000000000000000000000000000000018080c001a07eade7c743ff2ea60f61c687ccca4b77553a14de08378371ac40c7d52a8f1d74a06fed4faa592ac84bae32b9311844176fc059eb70057c18450d4310072a880629";

const ERR_ABI = [
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }],
  },
];

function startMockUpstream(mode) {
  let forwardedSends = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { method, id } = body;
      let payload;

      if (method === "eth_chainId") {
        payload = { jsonrpc: "2.0", id, result: "0x66eee" };
      } else if (method === "eth_simulateV1") {
        // Force fallback path
        payload = {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        };
      } else if (method === "eth_call") {
        if (mode === "definite-revert") {
          const data = encodeErrorResult({
            abi: ERR_ABI,
            errorName: "Error",
            args: ["demo: definite revert"],
          });
          payload = {
            jsonrpc: "2.0",
            id,
            error: { code: 3, message: "execution reverted", data },
          };
        } else {
          // Uncertain: network-style failure without clear revert
          payload = {
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "temporary upstream glitch" },
          };
        }
      } else if (method === "eth_sendRawTransaction") {
        forwardedSends += 1;
        payload = {
          jsonrpc: "2.0",
          id,
          result: "0x" + "ab".repeat(32),
        };
      } else {
        payload = { jsonrpc: "2.0", id, result: null };
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        getForwarded: () => forwardedSends,
      });
    });
  });
}

async function rpc(url, method, params) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-l2sg-chain": "arb-sepolia",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
}

async function runCase(label, mode) {
  const upstream = await startMockUpstream(mode);
  const config = {
    listenHost: "127.0.0.1",
    listenPort: 0,
    failOpen: true,
    defaultChain: "arb-sepolia",
    chains: {
      "arb-sepolia": {
        id: "arb-sepolia",
        name: "Arbitrum Sepolia",
        chainId: 421614,
        upstreamRpcUrl: upstream.url,
        preferSimulateV1: true,
        ecosystem: "arbitrum",
      },
    },
  };
  const proxy = createServer(config);
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const addr = proxy.address();
  const proxyUrl = `http://127.0.0.1:${addr.port}`;

  const res = await rpc(proxyUrl, "eth_sendRawTransaction", [FAKE_RAW]);
  const forwarded = upstream.getForwarded();

  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(res, null, 2));
  console.log(`upstream eth_sendRawTransaction calls: ${forwarded}`);

  await new Promise((r) => proxy.close(r));
  await new Promise((r) => upstream.server.close(r));
  return { res, forwarded };
}

console.log("L2 Send Guard — offline demo (no keys, no capital, no public RPC)");

const abort = await runCase("1) Definite-revert ABORT", "definite-revert");
const open = await runCase("2) Uncertain → FAIL-OPEN", "uncertain");

const abortOk =
  abort.res?.error?.code === -32080 &&
  abort.res?.error?.data?.aborted === true &&
  abort.forwarded === 0;
const openOk =
  open.res?.result &&
  !open.res?.error &&
  open.forwarded === 1;

console.log("\n--- summary ---");
console.log(`definite-revert abort: ${abortOk ? "PASS" : "FAIL"}`);
console.log(`fail-open forward:     ${openOk ? "PASS" : "FAIL"}`);

if (!abortOk || !openOk) process.exit(1);
console.log("\nDemo OK — abort never forwards; fail-open does.");
