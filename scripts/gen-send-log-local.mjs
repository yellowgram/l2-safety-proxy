/**
 * Generate ≥20 local/sim SEND_LOG evidence rows (mocked upstream).
 * Also exercises open vs strict. No invented live hashes.
 */
import http from "node:http";
import { createServer } from "../dist/proxy/server.js";
import { encodeErrorResult } from "viem";

const ERR_ABI = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
];

const FAKE_RAW =
  "0x02f86d83066eee80843b9aca00843b9aca008252089400000000000000000000000000000000000000018080c001a07eade7c743ff2ea60f61c687ccca4b77553a14de08378371ac40c7d52a8f1d74a06fed4faa592ac84bae32b9311844176fc059eb70057c18450d4310072a880629";

function startMock(mode) {
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { method, id } = body;
      let payload;
      if (method === "eth_chainId") payload = { jsonrpc: "2.0", id, result: "0x66eee" };
      else if (method === "eth_simulateV1") {
        payload = { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
      } else if (method === "eth_call") {
        if (mode === "revert") {
          const data = encodeErrorResult({ abi: ERR_ABI, errorName: "Error", args: [`local-sim-revert-${n++}`] });
          payload = { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data } };
        } else if (mode === "glitch") {
          payload = { jsonrpc: "2.0", id, error: { code: -32000, message: "temporary glitch" } };
        } else {
          payload = { jsonrpc: "2.0", id, result: "0x" };
        }
      } else if (method === "eth_sendRawTransaction") {
        n += 1;
        const hash = "0x" + (Date.now().toString(16) + n.toString(16)).padStart(64, "0").slice(-64);
        payload = { jsonrpc: "2.0", id, result: hash };
      } else payload = { jsonrpc: "2.0", id, result: null };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function ts() {
  // America/New_York label
  return new Date().toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false }).replace(", ", "T") + " ET";
}

const rows = [];

async function runCase({ mode, guardMode, label }) {
  const up = await startMock(mode);
  const config = {
    listenHost: "127.0.0.1",
    listenPort: 0,
    guardMode,
    failOpen: guardMode === "open",
    defaultChain: "arb-sepolia",
    chains: {
      "arb-sepolia": {
        id: "arb-sepolia",
        name: "Arbitrum Sepolia",
        chainId: 421614,
        upstreamRpcUrl: up.url,
        preferSimulateV1: true,
        ecosystem: "arbitrum",
      },
    },
  };
  const proxy = createServer(config);
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const addr = proxy.address();
  const proxyUrl = `http://127.0.0.1:${addr.port}`;
  const res = await fetch(proxyUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-l2sg-chain": "arb-sepolia" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [FAKE_RAW] }),
  }).then((r) => r.json());
  const meta = res.error?.data ?? res.l2sg ?? {};
  const txOrSim = res.result ?? meta.rawData?.slice(0, 18) ?? `sim-${label}`;
  rows.push({
    ts: ts(),
    chain: "arb-sepolia",
    mode: guardMode,
    decision: meta.decision ?? "?",
    confidence: meta.confidence ?? "?",
    txHashOrSimId: typeof txOrSim === "string" ? txOrSim : String(txOrSim),
    notes: label,
  });
  proxy.close();
  up.server.close();
}

// 8 abort (revert), 6 fail_open (glitch open), 4 strict abort (glitch strict), 6 forward (ok)
for (let i = 0; i < 8; i++) await runCase({ mode: "revert", guardMode: "open", label: `local abort revert #${i + 1}` });
for (let i = 0; i < 6; i++) await runCase({ mode: "glitch", guardMode: "open", label: `local fail_open glitch #${i + 1}` });
for (let i = 0; i < 4; i++) await runCase({ mode: "glitch", guardMode: "strict", label: `local strict abort glitch #${i + 1}` });
for (let i = 0; i < 6; i++) await runCase({ mode: "ok", guardMode: "open", label: `local forward ok #${i + 1}` });

console.log(JSON.stringify(rows, null, 2));
console.log("ROW_COUNT", rows.length);
