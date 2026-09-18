/**
 * Live smoke: Base Sepolia public RPC via local proxy.
 * Unfunded ephemeral key + known-reverting calldata — no broadcast of value.
 * Verifies: first send aborts with -32080 (eth_call after V1 unsupported),
 * second send also -32080 (capability cache; should not need another V1 probe
 * that we can observe only indirectly via consistent simMethod).
 */
import { createServer } from "../dist/proxy/server.js";
import { loadConfig } from "../dist/config/env.js";
import {
  clearSimulateV1CapabilityCache,
  isSimulateV1Unsupported,
  simulateV1UnsupportedCount,
} from "../dist/sim/capabilityCache.js";
import {
  createWalletClient,
  http,
  encodeFunctionData,
  parseGwei,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";

clearSimulateV1CapabilityCache();

const config = loadConfig();
// Force base as default for this smoke
const smokeConfig = {
  ...config,
  defaultChain: "base-sepolia",
  listenPort: 0,
  listenHost: "127.0.0.1",
};

const server = createServer(smokeConfig);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
const proxyUrl = `http://127.0.0.1:${addr.port}`;
console.log("proxy", proxyUrl);
console.log("upstream base", smokeConfig.chains["base-sepolia"].upstreamRpcUrl);

const health = await fetch(proxyUrl + "/health").then((r) => r.json());
console.log("health", health);

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
console.log("ephemeral from", account.address, "(discard after; unfunded)");

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Sign via wallet client pointed at public RPC for nonce/gas — then send raw through proxy
const direct = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(smokeConfig.chains["base-sepolia"].upstreamRpcUrl),
});

// Use deadbeef calldata (known revert on USDC) — prepare signed raw tx
const signed = await direct.signTransaction({
  to: USDC,
  data: "0xdeadbeef",
  value: 0n,
  gas: 100000n,
  maxFeePerGas: parseGwei("0.1"),
  maxPriorityFeePerGas: parseGwei("0.001"),
  nonce: 0, // unfunded account
  chainId: baseSepolia.id,
  type: "eip1559",
});

async function sendRaw(label) {
  const t0 = Date.now();
  const res = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-l2sg-chain": "base-sepolia",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [signed],
    }),
  }).then((r) => r.json());
  const ms = Date.now() - t0;
  console.log(label, { ms, error: res.error, result: res.result });
  return res;
}

// Control: eth_call should revert
const callCtrl = await fetch(proxyUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-l2sg-chain": "base-sepolia",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [
      { to: USDC, data: "0xdeadbeef", from: account.address },
      "latest",
    ],
  }),
}).then((r) => r.json());
console.log("control eth_call", {
  errorCode: callCtrl.error?.code,
  message: callCtrl.error?.message?.slice?.(0, 80),
});

const first = await sendRaw("send#1");
const upstream = smokeConfig.chains["base-sepolia"].upstreamRpcUrl;
console.log("cache after #1", {
  unsupported: isSimulateV1Unsupported(upstream),
  count: simulateV1UnsupportedCount(),
});

const second = await sendRaw("send#2");
console.log("cache after #2", {
  unsupported: isSimulateV1Unsupported(upstream),
  count: simulateV1UnsupportedCount(),
});

const ok =
  first.error?.code === -32080 &&
  first.error?.data?.simMethod === "eth_call" &&
  first.error?.data?.confidence === "definite" &&
  second.error?.code === -32080 &&
  second.error?.data?.simMethod === "eth_call" &&
  isSimulateV1Unsupported(upstream) &&
  simulateV1UnsupportedCount() >= 1;

console.log(ok ? "SMOKE_PASS" : "SMOKE_FAIL");
server.close();
process.exit(ok ? 0 : 1);
