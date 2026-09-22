/**
 * Delta A live proof — Base Sepolia preferred (else Arb/OP).
 * 1) Burner from L2SG_BURNER_KEY (.env, gitignored)
 * 2) Faucet attempts (document; never invent hashes)
 * 3) Definite-abort sim via Guard proxy (always)
 * 4) Success-path broadcast if funded; wait receipt
 *
 * Usage (after npm run build):
 *   node --env-file=.env scripts/delta-a-live-proof.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "../dist/proxy/server.js";
import { loadConfig } from "../dist/config/env.js";
import { clearSimulateV1CapabilityCache } from "../dist/sim/capabilityCache.js";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseGwei,
  formatEther,
  keccak256,
  isHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, arbitrumSepolia, optimismSepolia } from "viem/chains";

function loadDotEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const CHAINS = [
  {
    key: "base-sepolia",
    viem: baseSepolia,
    rpc:
      process.env.L2SG_RPC_BASE_SEPOLIA ?? "https://sepolia.base.org",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  },
  {
    key: "arb-sepolia",
    viem: arbitrumSepolia,
    rpc:
      process.env.L2SG_RPC_ARB_SEPOLIA ??
      "https://sepolia-rollup.arbitrum.io/rpc",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  },
  {
    key: "op-sepolia",
    viem: optimismSepolia,
    rpc: process.env.L2SG_RPC_OP_SEPOLIA ?? "https://sepolia.optimism.io",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  },
];

const pk = process.env.L2SG_BURNER_KEY;
if (!pk || !isHex(pk)) {
  console.error("L2SG_BURNER_KEY missing/invalid in .env");
  process.exit(1);
}
const account = privateKeyToAccount(pk);
console.log("burner", account.address);

function ts() {
  return (
    new Date()
      .toLocaleString("en-CA", {
        timeZone: "America/New_York",
        hour12: false,
      })
      .replace(", ", "T") + " ET"
  );
}

async function rpc(url, method, params) {
  const j = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
  return j;
}

async function getBal(url, addr) {
  const j = await rpc(url, "eth_getBalance", [addr, "latest"]);
  return BigInt(j.result ?? "0x0");
}

const faucetAttempts = [];

async function tryFaucet(name, chainKey, run) {
  try {
    console.log("faucet try", name, chainKey);
    const r = await run();
    const text = typeof r.text === "function" ? await r.text() : String(r.body ?? "");
    const status = r.status ?? 0;
    const note = `HTTP ${status} ${text.slice(0, 160).replace(/\s+/g, " ")}`;
    console.log("faucet", name, note);
    faucetAttempts.push({
      ts: ts(),
      name,
      chainKey,
      status,
      note,
    });
    return { status, text, ok: status >= 200 && status < 300 };
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    console.log("faucet", name, "error", note);
    faucetAttempts.push({
      ts: ts(),
      name,
      chainKey,
      status: 0,
      note: `error: ${note}`,
    });
    return { status: 0, text: note, ok: false };
  }
}

// --- Faucet attempts (Base preferred, then Arb/OP) ---
const addr = account.address;
await tryFaucet("triangle-base", "base-sepolia", () =>
  fetch("https://faucet.triangleplatform.com/api/v1/base/sepolia", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: "base-sepolia", address: addr }),
    signal: AbortSignal.timeout(15000),
  })
);
await tryFaucet("triangle-base-retry", "base-sepolia", () =>
  fetch("https://faucet.triangleplatform.com/api/v1/base/sepolia", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: "base-sepolia", address: addr }),
    signal: AbortSignal.timeout(15000),
  })
);
await tryFaucet("triangle-arb", "arb-sepolia", () =>
  fetch("https://faucet.triangleplatform.com/api/v1/arbitrum/sepolia", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: "arbitrum-sepolia", address: addr }),
    signal: AbortSignal.timeout(15000),
  })
);
await tryFaucet("triangle-op", "op-sepolia", () =>
  fetch("https://faucet.triangleplatform.com/api/v1/optimism/sepolia", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: "optimism-sepolia", address: addr }),
    signal: AbortSignal.timeout(15000),
  })
);
await tryFaucet("chainlink", "base-sepolia", () =>
  fetch("https://faucets.chain.link/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: addr, network: "base-sepolia" }),
    signal: AbortSignal.timeout(15000),
  })
);
await tryFaucet("quicknode-page", "base-sepolia", () =>
  fetch("https://faucet.quicknode.com/base/sepolia", {
    method: "GET",
    signal: AbortSignal.timeout(15000),
  })
);
await tryFaucet("learnweb3", "base-sepolia", () =>
  fetch("https://learnweb3.io/faucets/base_sepolia", {
    method: "GET",
    signal: AbortSignal.timeout(15000),
  })
);

// Poll balances briefly after faucet attempts
let fundedChain = null;
for (const c of CHAINS) {
  let bal = await getBal(c.rpc, addr);
  console.log("balance", c.key, formatEther(bal), "ETH");
  if (bal === 0n) {
    // brief wait in case a drip is pending
    await new Promise((r) => setTimeout(r, 2000));
    bal = await getBal(c.rpc, addr);
  }
  if (bal > 0n) {
    fundedChain = c;
    break;
  }
}

clearSimulateV1CapabilityCache();
const config = loadConfig();
const proofChain = fundedChain ?? CHAINS[0];
const demoConfig = {
  ...config,
  defaultChain: proofChain.key,
  listenPort: 0,
  listenHost: "127.0.0.1",
  chains: {
    ...config.chains,
    [proofChain.key]: {
      ...config.chains[proofChain.key],
      upstreamRpcUrl: proofChain.rpc,
    },
  },
};

const server = createServer(demoConfig);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${server.address().port}`;
console.log("proxy", proxyUrl, "chain", proofChain.key);

const wallet = createWalletClient({
  account,
  chain: proofChain.viem,
  transport: http(proofChain.rpc),
});
const publicClient = createPublicClient({
  chain: proofChain.viem,
  transport: http(proofChain.rpc),
});

async function sendViaProxy(signed) {
  return fetch(proxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-l2sg-chain": proofChain.key,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [signed],
    }),
  }).then((r) => r.json());
}

const nonceRes = await rpc(proofChain.rpc, "eth_getTransactionCount", [
  addr,
  "pending",
]);
const nonce = Number(nonceRes.result ?? "0x0");

// --- Definite abort (sim-only; never broadcast) ---
const revertSigned = await wallet.signTransaction({
  to: proofChain.multicall3,
  data: "0xdeadbeef",
  value: 0n,
  gas: 100000n,
  maxFeePerGas: parseGwei("0.1"),
  maxPriorityFeePerGas: parseGwei("0.001"),
  nonce,
  chainId: proofChain.viem.id,
  type: "eip1559",
});
const simId = keccak256(revertSigned);
const abortRes = await sendViaProxy(revertSigned);
const abortMeta = abortRes.error?.data ?? abortRes.l2sg ?? {};
const abortOk =
  abortRes.error?.code === -32080 &&
  abortMeta.decision === "abort" &&
  abortMeta.aborted === true;
console.log("abort", {
  ok: abortOk,
  decision: abortMeta.decision,
  certainty: abortMeta.certainty,
  confidence: abortMeta.confidence,
  code: abortRes.error?.code,
  simId,
});

// --- Forward success if funded ---
let forwardHash = null;
let receiptStatus = null;
let forwardNote = null;

if (fundedChain) {
  const n = Number(
    (
      await rpc(proofChain.rpc, "eth_getTransactionCount", [addr, "pending"])
    ).result ?? "0x0"
  );
  const successSigned = await wallet.signTransaction({
    to: addr,
    data: "0x",
    value: 0n,
    gas: 50000n,
    maxFeePerGas: parseGwei("0.1"),
    maxPriorityFeePerGas: parseGwei("0.001"),
    nonce: n,
    chainId: proofChain.viem.id,
    type: "eip1559",
  });
  const fwd = await sendViaProxy(successSigned);
  const meta = fwd.error?.data ?? fwd.l2sg ?? {};
  if (typeof fwd.result === "string" && fwd.result.startsWith("0x")) {
    forwardHash = fwd.result;
    console.log("broadcast", forwardHash, "decision", meta.decision);
    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: forwardHash,
        timeout: 120_000,
      });
      receiptStatus = Number(receipt.status);
      console.log("receipt status", receiptStatus, "block", receipt.blockNumber);
    } catch (err) {
      forwardNote = `receipt wait failed: ${err instanceof Error ? err.message : String(err)}`;
      console.log(forwardNote);
    }
  } else {
    forwardNote = `forward rejected: ${JSON.stringify(fwd.error ?? fwd).slice(0, 200)}`;
    console.log(forwardNote);
  }
} else {
  forwardNote =
    "FAUCET BLOCKED — all public drips failed/suspended/captcha. Forward live-hash slice STOPPED. No invented hashes.";
  console.log(forwardNote);
}

server.close();

const evidence = {
  ts: ts(),
  burnerAddress: addr,
  chain: proofChain.key,
  abort: {
    ok: abortOk,
    decision: abortMeta.decision,
    certainty: abortMeta.certainty,
    confidence: abortMeta.confidence,
    simMethod: abortMeta.simMethod,
    simId: `sim:${simId}`,
    errorCode: abortRes.error?.code,
    decoded: abortMeta.decoded?.reason ?? abortMeta.reason,
  },
  forward: {
    hash: forwardHash,
    receiptStatus,
    note: forwardNote,
  },
  faucetAttempts,
  funded: Boolean(fundedChain),
};

writeFileSync(
  "docs/delta-a-evidence.json",
  JSON.stringify(evidence, null, 2) + "\n"
);
console.log("\n=== summary ===");
console.log(JSON.stringify(evidence, null, 2));
process.exit(abortOk ? 0 : 1);
