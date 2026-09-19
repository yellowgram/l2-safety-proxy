/**
 * Arb Sepolia stranger demo (~10 min) — no committed keys.
 *
 * 1) Start proxy (Arb Sepolia default, GUARD_MODE=open)
 * 2) Known-revert raw tx → abort + confidence + decoded
 * 3) Known-success path → forward (requires faucet ETH; stops cleanly if blocked)
 *
 * Usage (after npm run build):
 *   npm run demo:sepolia
 *   GUARD_MODE=strict npm run demo:sepolia
 *
 * Env:
 *   L2SG_RPC_ARB_SEPOLIA — optional public/override RPC
 *   DEMO_PRIVATE_KEY     — optional funded key for forward slice (never commit)
 *   DEMO_SKIP_FAUCET=1   — skip faucet attempt; abort-only
 */
import { createServer } from "../dist/proxy/server.js";
import { loadConfig } from "../dist/config/env.js";
import { clearSimulateV1CapabilityCache } from "../dist/sim/capabilityCache.js";
import {
  createWalletClient,
  http,
  parseGwei,
  formatEther,
  isHex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

const RPC =
  process.env.L2SG_RPC_ARB_SEPOLIA ??
  "https://sepolia-rollup.arbitrum.io/rpc";

clearSimulateV1CapabilityCache();

const config = loadConfig();
const demoConfig = {
  ...config,
  defaultChain: "arb-sepolia",
  listenPort: 0,
  listenHost: "127.0.0.1",
  chains: {
    ...config.chains,
    "arb-sepolia": {
      ...config.chains["arb-sepolia"],
      upstreamRpcUrl: RPC,
    },
  },
};

const server = createServer(demoConfig);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
const proxyUrl = `http://127.0.0.1:${addr.port}`;

console.log("=== L2 Send Guard — demo:sepolia (Arb Sepolia) ===");
console.log("proxy", proxyUrl);
console.log("GUARD_MODE", demoConfig.guardMode);
console.log("upstream", RPC);

const health = await fetch(proxyUrl + "/health").then((r) => r.json());
console.log("health", {
  ok: health.ok,
  guardMode: health.guardMode,
  chains: health.chains,
  confidence: health.confidence,
});

const pk =
  process.env.DEMO_PRIVATE_KEY && isHex(process.env.DEMO_PRIVATE_KEY)
    ? process.env.DEMO_PRIVATE_KEY
    : generatePrivateKey();
const account = privateKeyToAccount(pk);
console.log("signer", account.address, process.env.DEMO_PRIVATE_KEY ? "(DEMO_PRIVATE_KEY)" : "(ephemeral)");

const direct = createWalletClient({
  account,
  chain: arbitrumSepolia,
  transport: http(RPC),
});

/** Multicall3 on Arb Sepolia — well-known; deadbeef calldata → definite revert */
const TARGET = "0xcA11bde05977b3631167028862bE2a173976CA11";

async function sendRaw(label, signed) {
  const t0 = Date.now();
  const res = await fetch(proxyUrl, {
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
  const ms = Date.now() - t0;
  const meta = res.error?.data ?? res.l2sg;
  console.log(label, {
    ms,
    decision: meta?.decision,
    confidence: meta?.confidence,
    certainty: meta?.certainty,
    chainId: meta?.chainId,
    decoded: meta?.decoded,
    errorCode: res.error?.code,
    result: res.result,
  });
  return { res, meta, ms };
}

// --- Slice A: known-revert → abort ---
const nonce = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getTransactionCount",
    params: [account.address, "pending"],
  }),
}).then((r) => r.json()).then((j) => Number(j.result ?? "0x0"));

const revertSigned = await direct.signTransaction({
  to: TARGET,
  data: "0xdeadbeef",
  value: 0n,
  gas: 100000n,
  maxFeePerGas: parseGwei("0.1"),
  maxPriorityFeePerGas: parseGwei("0.001"),
  nonce,
  chainId: arbitrumSepolia.id,
  type: "eip1559",
});

const abort = await sendRaw("abort#known-revert", revertSigned);
const abortOk =
  abort.res.error?.code === -32080 &&
  abort.meta?.decision === "abort" &&
  abort.meta?.aborted === true;
console.log(abortOk ? "PASS abort (decoded definite revert, not broadcast)" : "FAIL abort");

// --- Slice B: known-success → forward (needs gas) ---
let forwardOk = false;
let forwardHash = null;
let faucetNote = null;

async function getBalance(addr) {
  const j = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [addr, "latest"],
    }),
  }).then((r) => r.json());
  return BigInt(j.result ?? "0x0");
}

let bal = await getBalance(account.address);
console.log("balance", formatEther(bal), "ETH");

if (process.env.DEMO_SKIP_FAUCET === "1") {
  faucetNote = "DEMO_SKIP_FAUCET=1 — skipped forward slice";
  console.log(faucetNote);
} else if (bal === 0n && !process.env.DEMO_PRIVATE_KEY) {
  // Try a few public faucet endpoints (may block bots / captcha)
  const faucets = [
    {
      name: "triangle",
      url: "https://faucet.triangleplatform.com/api/v1/arbitrum/sepolia",
      body: { network: "arbitrum-sepolia", address: account.address },
    },
  ];
  let funded = false;
  for (const f of faucets) {
    try {
      console.log("faucet try", f.name);
      const r = await fetch(f.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(f.body),
        signal: AbortSignal.timeout(10000),
      });
      const text = await r.text();
      console.log("faucet response", f.name, r.status, text.slice(0, 200));
      const looksJson = text.trim().startsWith("{") || text.trim().startsWith("[");
      if (r.ok && looksJson) {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          bal = await getBalance(account.address);
          if (bal > 0n) {
            funded = true;
            break;
          }
        }
      } else {
        faucetNote = `faucet ${f.name} blocked: HTTP ${r.status} (non-JSON/suspended) — stopping forward slice`;
        console.log(faucetNote);
        break;
      }
      if (funded) break;
    } catch (err) {
      faucetNote = `faucet ${f.name} blocked/error: ${err instanceof Error ? err.message : String(err)}`;
      console.log(faucetNote);
      break;
    }
  }
  if (!funded) {
    faucetNote =
      faucetNote ??
      "faucet blocked or unfunded — stopping forward slice (abort slice still valid)";
    console.log(faucetNote);
  }
}

bal = await getBalance(account.address);
if (bal > 0n) {
  const successSigned = await direct.signTransaction({
    to: account.address,
    data: "0x",
    value: 0n,
    gas: 50000n,
    maxFeePerGas: parseGwei("0.1"),
    maxPriorityFeePerGas: parseGwei("0.001"),
    nonce,
    chainId: arbitrumSepolia.id,
    type: "eip1559",
  });
  const fwd = await sendRaw("forward#self-transfer-0", successSigned);
  forwardOk =
    fwd.meta?.decision === "forward" &&
    typeof fwd.res.result === "string" &&
    fwd.res.result.startsWith("0x");
  forwardHash = forwardOk ? fwd.res.result : null;
  console.log(
    forwardOk
      ? `PASS forward (hash ${forwardHash})`
      : "FAIL forward (sim/upstream rejected)"
  );
  if (!forwardOk && fwd.res.error) {
    console.log("upstream/guard error", fwd.res.error);
  }
} else {
  console.log("no balance — forward slice stopped");
}

console.log("\n=== summary ===");
console.log({
  abort: abortOk ? "PASS" : "FAIL",
  abortDecision: abort.meta?.decision,
  abortConfidence: abort.meta?.confidence,
  abortDecoded: abort.meta?.decoded?.reason ?? abort.meta?.reason,
  forward: forwardOk ? "PASS" : faucetNote ? "SKIPPED" : "FAIL",
  forwardHash,
  faucetNote,
  guardMode: demoConfig.guardMode,
});

server.close();
process.exit(abortOk ? 0 : 1);
