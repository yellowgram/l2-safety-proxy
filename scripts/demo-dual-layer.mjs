/**
 * Offline dual-layer demo — no public RPC, keys, or capital.
 *
 * Proves, in order:
 *   chain select (x-l2sg-chain key + numeric id) via -32081 chainId
 *   -32081 eth_sendTransaction refused
 *   -32084 signed chainId ≠ selected chain
 *   -32083 Layer 2 policy stop (no sim, no forward)
 *   -32080 Layer 1 definite-revert abort (no forward)
 *
 * Stdout must match docs/fixtures/dual-layer.expected.txt or the process exits 1.
 *
 *   npm run build && npm run demo:dual-layer
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../dist/proxy/server.js";
import { defaultSpendPolicy } from "../dist/policy/index.js";
import { encodeErrorResult } from "viem";

const FAKE_RAW =
  "0x02f86d83066eee80843b9aca00843b9aca008252089400000000000000000000000000000000000000018080c001a07eade7c743ff2ea60f61c687ccca4b77553a14de08378371ac40c7d52a8f1d74a06fed4faa592ac84bae32b9311844176fc059eb70057c18450d4310072a880629";

const ERR_ABI = [
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }],
  },
];

const lines = [];
function emit(line) {
  lines.push(line);
  console.log(line);
}

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
          payload = { jsonrpc: "2.0", id, result: "0x" };
        }
      } else if (method === "eth_sendRawTransaction" || method === "eth_sendTransaction") {
        forwardedSends += 1;
        payload = { jsonrpc: "2.0", id, result: "0x" + "ab".repeat(32) };
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

async function rpc(url, method, params, chainHeader) {
  const headers = { "content-type": "application/json" };
  if (chainHeader != null) headers["x-l2sg-chain"] = chainHeader;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function baseConfig(upstreamUrl, policy) {
  const chain = (id, name, chainId, ecosystem) => ({
    id,
    name,
    chainId,
    upstreamRpcUrl: upstreamUrl,
    preferSimulateV1: true,
    ecosystem,
  });
  return {
    listenHost: "127.0.0.1",
    listenPort: 0,
    guardMode: "open",
    failOpen: true,
    defaultChain: "arb-sepolia",
    policy,
    chains: {
      "arb-sepolia": chain("arb-sepolia", "Arbitrum Sepolia", 421614, "arbitrum"),
      "op-sepolia": chain("op-sepolia", "OP Sepolia", 11155420, "op-stack"),
      "base-sepolia": chain("base-sepolia", "Base Sepolia", 84532, "base"),
    },
  };
}

async function withProxy(mode, policy, fn) {
  const upstream = await startMockUpstream(mode);
  const proxy = createServer(baseConfig(upstream.url, policy));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const addr = proxy.address();
  const proxyUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(proxyUrl, upstream.getForwarded);
  } finally {
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => upstream.server.close(r));
  }
}

function field(data, key) {
  const v = data?.[key];
  if (v === undefined || v === null) return "null";
  return String(v);
}

function row(tag, res, forwarded) {
  const data = res?.error?.data ?? {};
  return [
    tag,
    `code=${res?.error?.code ?? "none"}`,
    `decision=${field(data, "decision")}`,
    `layer=${field(data, "layer")}`,
    `chainId=${field(data, "chainId")}`,
    `signedChainId=${field(data, "signedChainId")}`,
    `certainty=${field(data, "certainty")}`,
    `confidence=${field(data, "confidence")}`,
    `policyCode=${field(data, "policyCode")}`,
    `forwarded=${forwarded}`,
  ].join(" ");
}

emit("L2 Send Guard dual-layer offline transcript");
emit("order: chain-select -> unsigned -32081 -> chain-mismatch -32084 -> policy -32083 (no sim) -> sim abort -32080");

const polOff = defaultSpendPolicy();

await withProxy("success", polOff, async (url, forwarded) => {
  const selects = [
    ["arb-sepolia", 421614],
    ["op-sepolia", 11155420],
    ["base-sepolia", 84532],
    ["84532", 84532],
  ];
  for (const [header, chainId] of selects) {
    const before = forwarded();
    const res = await rpc(url, "eth_sendTransaction", [{}], header);
    const got = res?.error?.data?.chainId;
    emit(
      `CHAIN_SELECT header=${header} code=${res?.error?.code} chainId=${got} forwarded=${forwarded() - before}`
    );
    if (res?.error?.code !== -32081 || got !== chainId || forwarded() !== before) {
      throw new Error(`chain select failed for ${header}`);
    }
  }

  const before = forwarded();
  const unsigned = await rpc(url, "eth_sendTransaction", [{}], "arb-sepolia");
  emit(row("UNSIGNED", unsigned, forwarded() - before));
  if (unsigned?.error?.code !== -32081 || forwarded() !== before) {
    throw new Error("unsigned refusal failed");
  }

  const beforeMismatch = forwarded();
  const mismatch = await rpc(url, "eth_sendRawTransaction", [FAKE_RAW], "op-sepolia");
  emit(row("CHAIN_MISMATCH", mismatch, forwarded() - beforeMismatch));
  if (
    mismatch?.error?.code !== -32084 ||
    mismatch?.error?.data?.decision !== "chain_mismatch" ||
    mismatch?.error?.data?.signedChainId !== 421614 ||
    forwarded() !== beforeMismatch
  ) {
    throw new Error("chain mismatch failed");
  }
});

const polOn = defaultSpendPolicy();
polOn.enabled = true;
polOn.destinations = new Map([
  ["0x1111111111111111111111111111111111111111", {}],
]);

await withProxy("success", polOn, async (url, forwarded) => {
  const health = await fetch(`${url}/health`).then((r) => r.json());
  const before = forwarded();
  const denied = await rpc(url, "eth_sendRawTransaction", [FAKE_RAW], "arb-sepolia");
  emit(row("L2_DENY", denied, forwarded() - before));
  emit(
    `L2_HEALTH policy.enabled=${health?.policy?.enabled} destinationCount=${health?.policy?.destinationCount} notifyConfigured=${health?.policy?.notifyConfigured}`
  );
  if (
    denied?.error?.code !== -32083 ||
    denied?.error?.data?.decision !== "policy_denied" ||
    denied?.error?.data?.layer !== 2 ||
    health?.policy?.enabled !== true ||
    forwarded() !== before
  ) {
    throw new Error("policy deny failed");
  }
});

await withProxy("definite-revert", polOff, async (url, forwarded) => {
  const before = forwarded();
  const abort = await rpc(url, "eth_sendRawTransaction", [FAKE_RAW], "arb-sepolia");
  emit(row("L1_ABORT", abort, forwarded() - before));
  if (
    abort?.error?.code !== -32080 ||
    abort?.error?.data?.decision !== "abort" ||
    abort?.error?.data?.layer !== 1 ||
    abort?.error?.data?.certainty !== "definite" ||
    forwarded() !== before
  ) {
    throw new Error("definite revert abort failed");
  }
});

emit("-32080 definite-revert abort: PASS");
emit("-32081 unsigned refusal: PASS");
emit("-32083 policy_denied stop: PASS");
emit("-32084 chain mismatch: PASS");
emit("chain-select arb/op/base: PASS");
emit("Demo OK — Layer 1 aborts definite reverts; Layer 2 policy never fail-opens.");

const expectedPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../docs/fixtures/dual-layer.expected.txt"
);
const expected = readFileSync(expectedPath, "utf8").replace(/\r\n/g, "\n").trim();
const actual = lines.join("\n").trim();
if (actual !== expected) {
  console.error("\n--- transcript mismatch ---");
  console.error(actual);
  console.error("--- end actual ---");
  process.exit(1);
}
