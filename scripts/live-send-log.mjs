/**
 * Collect live Arb Sepolia SEND_LOG rows (real RPC only; no invented hashes).
 * Abort slice always runs. Forward slice needs faucet / DEMO_PRIVATE_KEY.
 */
import { createServer } from "../dist/proxy/server.js";
import { loadConfig } from "../dist/config/env.js";
import { clearSimulateV1CapabilityCache } from "../dist/sim/capabilityCache.js";
import { createWalletClient, http, parseGwei, keccak256, isHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

const RPC =
  process.env.L2SG_RPC_ARB_SEPOLIA ??
  "https://sepolia-rollup.arbitrum.io/rpc";
const TARGET = "0xcA11bde05977b3631167028862bE2a173976CA11";

clearSimulateV1CapabilityCache();
const config = loadConfig();
const demoConfig = {
  ...config,
  defaultChain: "arb-sepolia",
  listenPort: 0,
  listenHost: "127.0.0.1",
  chains: {
    ...config.chains,
    "arb-sepolia": { ...config.chains["arb-sepolia"], upstreamRpcUrl: RPC },
  },
};

const server = createServer(demoConfig);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${server.address().port}`;

function ts() {
  return (
    new Date()
      .toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false })
      .replace(", ", "T") + " ET"
  );
}

const rows = [];
const pk =
  process.env.DEMO_PRIVATE_KEY && isHex(process.env.DEMO_PRIVATE_KEY)
    ? process.env.DEMO_PRIVATE_KEY
    : generatePrivateKey();
const account = privateKeyToAccount(pk);
const direct = createWalletClient({
  account,
  chain: arbitrumSepolia,
  transport: http(RPC),
});

async function rpcDirect(method, params) {
  return fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
}

async function sendViaProxy(signed, mode) {
  // recreate server config mode by setting env is hard; instead hit same proxy
  // (proxy already open). For strict we spawn another server.
  const url = mode === demoConfig.guardMode ? proxyUrl : null;
  let useUrl = proxyUrl;
  let extraServer = null;
  if (mode !== demoConfig.guardMode) {
    const cfg = { ...demoConfig, guardMode: mode, failOpen: mode === "open" };
    extraServer = createServer(cfg);
    await new Promise((r) => extraServer.listen(0, "127.0.0.1", r));
    useUrl = `http://127.0.0.1:${extraServer.address().port}`;
  }
  const res = await fetch(useUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-l2sg-chain": "arb-sepolia",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [signed],
    }),
  }).then((r) => r.json());
  if (extraServer) extraServer.close();
  return res;
}

const nonceRes = await rpcDirect("eth_getTransactionCount", [
  account.address,
  "pending",
]);
let nonce = Number(nonceRes.result ?? "0x0");

// --- Live aborts (5+) with simId = keccak of raw (not an on-chain hash) ---
for (let i = 0; i < 5; i++) {
  const signed = await direct.signTransaction({
    to: TARGET,
    data: `0xdeadbeef${i.toString(16).padStart(2, "0")}`,
    value: 0n,
    gas: 100000n,
    maxFeePerGas: parseGwei("0.1"),
    maxPriorityFeePerGas: parseGwei("0.001"),
    nonce: nonce + i,
    chainId: arbitrumSepolia.id,
    type: "eip1559",
  });
  const simId = keccak256(signed);
  const res = await sendViaProxy(signed, "open");
  const meta = res.error?.data ?? res.l2sg ?? {};
  rows.push({
    ts: ts(),
    chain: "arb-sepolia",
    mode: "open",
    decision: meta.decision ?? "?",
    confidence: meta.confidence ?? "?",
    txHashOrSimId: `sim:${simId}`,
    notes: `live abort #${i + 1} decoded=${meta.decoded?.reason ?? meta.reason ?? ""} code=${res.error?.code}`,
  });
  console.log("abort", i + 1, meta.decision, meta.confidence, res.error?.code);
}

// --- Try faucet for forward hashes ---
async function bal() {
  const j = await rpcDirect("eth_getBalance", [account.address, "latest"]);
  return BigInt(j.result ?? "0x0");
}

let faucetNote = null;
let balance = await bal();
console.log("balance", balance.toString(), "signer", account.address);

if (balance === 0n && !process.env.DEMO_PRIVATE_KEY) {
  const attempts = [
    {
      name: "triangle",
      run: async () =>
        fetch("https://faucet.triangleplatform.com/api/v1/arbitrum/sepolia", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            network: "arbitrum-sepolia",
            address: account.address,
          }),
          signal: AbortSignal.timeout(20000),
        }),
    },
    {
      name: "learnweb3",
      run: async () =>
        fetch("https://sepoliafaucet.com/", {
          method: "GET",
          signal: AbortSignal.timeout(10000),
        }),
    },
  ];
  for (const a of attempts) {
    try {
      const r = await a.run();
      const text = await r.text();
      console.log("faucet", a.name, r.status, text.slice(0, 180));
      faucetNote = `faucet ${a.name}: HTTP ${r.status} ${text.slice(0, 120)}`;
      if (r.ok) {
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 4000));
          balance = await bal();
          if (balance > 0n) break;
        }
      }
      if (balance > 0n) break;
    } catch (err) {
      faucetNote = `faucet ${a.name} blocked: ${err instanceof Error ? err.message : String(err)}`;
      console.log(faucetNote);
    }
  }
}

balance = await bal();
const liveHashes = [];
if (balance > 0n) {
  for (let i = 0; i < 5; i++) {
    const n = Number(
      (
        await rpcDirect("eth_getTransactionCount", [
          account.address,
          "pending",
        ])
      ).result ?? "0x0"
    );
    const signed = await direct.signTransaction({
      to: account.address,
      data: "0x",
      value: 0n,
      gas: 50000n,
      maxFeePerGas: parseGwei("0.1"),
      maxPriorityFeePerGas: parseGwei("0.001"),
      nonce: n,
      chainId: arbitrumSepolia.id,
      type: "eip1559",
    });
    const res = await sendViaProxy(signed, "open");
    const meta = res.error?.data ?? res.l2sg ?? {};
    const hash = typeof res.result === "string" ? res.result : null;
    rows.push({
      ts: ts(),
      chain: "arb-sepolia",
      mode: "open",
      decision: meta.decision ?? "?",
      confidence: meta.confidence ?? "?",
      txHashOrSimId: hash ?? `no-hash:${meta.decision}`,
      notes: `live forward #${i + 1} ${hash ? "broadcast" : "no-hash"} ${res.error?.message ?? ""}`.slice(0, 160),
    });
    if (hash) liveHashes.push(hash);
    console.log("forward", i + 1, meta.decision, hash);
    if (!hash) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
} else {
  faucetNote =
    faucetNote ??
    "faucet blocked / unfunded — stopping forward live-hash slice";
  rows.push({
    ts: ts(),
    chain: "arb-sepolia",
    mode: "open",
    decision: "n/a",
    confidence: "n/a",
    txHashOrSimId: "—",
    notes: faucetNote,
  });
  console.log(faucetNote);
}

server.close();
console.log(JSON.stringify({ rows, liveHashes, faucetNote }, null, 2));
