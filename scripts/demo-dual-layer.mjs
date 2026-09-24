/**
 * Offline dual-layer demo — no public RPC, keys, or capital.
 * Shows BOTH:
 *   1) Layer 1 definite-revert abort → JSON-RPC -32080
 *   2) Layer 2 policy stop → JSON-RPC -32083 (never fail-open)
 *
 * Usage (after npm run build):
 *   node scripts/demo-dual-layer.mjs
 *   # or: npm run demo:dual-layer
 */
import http from "node:http";
import { createServer } from "../dist/proxy/server.js";
import { defaultSpendPolicy } from "../dist/policy/index.js";
import { encodeErrorResult } from "viem";

// Anvil #0 signed EIP-1559 tx (Arb Sepolia) — public test fixture only
// to = 0x0000…0001 (matches fixtures.ts)
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
          // Would succeed at sim — policy should have stopped first
          payload = { jsonrpc: "2.0", id, result: "0x" };
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

function baseConfig(upstreamUrl, policy) {
  return {
    listenHost: "127.0.0.1",
    listenPort: 0,
    guardMode: "open",
    failOpen: true,
    defaultChain: "arb-sepolia",
    policy,
    chains: {
      "arb-sepolia": {
        id: "arb-sepolia",
        name: "Arbitrum Sepolia",
        chainId: 421614,
        upstreamRpcUrl: upstreamUrl,
        preferSimulateV1: true,
        ecosystem: "arbitrum",
      },
    },
  };
}

async function runCase(label, { mode, policy }) {
  const upstream = await startMockUpstream(mode);
  const config = baseConfig(upstream.url, policy);
  const proxy = createServer(config);
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const addr = proxy.address();
  const proxyUrl = `http://127.0.0.1:${addr.port}`;

  const health = await fetch(`${proxyUrl}/health`).then((r) => r.json());
  const res = await rpc(proxyUrl, "eth_sendRawTransaction", [FAKE_RAW]);
  const forwarded = upstream.getForwarded();

  console.log(`\n=== ${label} ===`);
  console.log("health.policy:", JSON.stringify(health.policy));
  console.log(JSON.stringify(res, null, 2));
  console.log(`upstream eth_sendRawTransaction calls: ${forwarded}`);

  await new Promise((r) => proxy.close(r));
  await new Promise((r) => upstream.server.close(r));
  return { res, forwarded, health };
}

console.log(
  "L2 Send Guard — dual-layer offline demo (-32080 + -32083; no keys, no capital)"
);

// Case 1: Layer 1 definite revert (policy OFF)
const polOff = defaultSpendPolicy();
const abort = await runCase("1) Layer 1 definite-revert ABORT (-32080)", {
  mode: "definite-revert",
  policy: polOff,
});

// Case 2: Layer 2 policy deny — allowlist only a different address; FAKE_RAW goes to 0x…0001
const polOn = defaultSpendPolicy();
polOn.enabled = true;
polOn.destinations = new Map([
  ["0x1111111111111111111111111111111111111111", {}],
]);
const denied = await runCase("2) Layer 2 policy STOP (-32083)", {
  mode: "success",
  policy: polOn,
});

const abortOk =
  abort.res?.error?.code === -32080 &&
  abort.res?.error?.data?.aborted === true &&
  abort.res?.error?.data?.layer === 1 &&
  abort.forwarded === 0;

const denyOk =
  denied.res?.error?.code === -32083 &&
  denied.res?.error?.data?.decision === "policy_denied" &&
  denied.res?.error?.data?.layer === 2 &&
  denied.res?.error?.data?.failOpen === false &&
  denied.forwarded === 0 &&
  denied.health?.policy?.enabled === true;

console.log("\n--- summary ---");
console.log(`-32080 definite-revert abort: ${abortOk ? "PASS" : "FAIL"}`);
console.log(`-32083 policy_denied stop:    ${denyOk ? "PASS" : "FAIL"}`);

if (!abortOk || !denyOk) process.exit(1);
console.log(
  "\nDemo OK — Layer 1 aborts definite reverts; Layer 2 policy never fail-opens."
);
