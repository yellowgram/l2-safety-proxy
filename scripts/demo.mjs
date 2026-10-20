/**
 * Offline demo: a mock RPC, the real proxy with a small policy, and six sends.
 * No network, keys or funds. Run after `npm run build`:  npm run demo
 */
import http from "node:http";
import { encodeErrorResult, encodeFunctionData, maxUint256, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createServer, Guard, MemoryStore, parsePolicy } from "../dist/api.js";

// A well-known test key (anvil #1). Never use it for anything real.
const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const CHAIN_ID = 421614;
const PAYEE = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const REVERTS = "0x4444444444444444444444444444444444444444";

// Mock upstream: eth_simulateV1 succeeds except for calls to REVERTS; sends return a hash.
let sent = 0;
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { id, method, params } = JSON.parse(body);
    const reply = (x) => res.end(JSON.stringify({ jsonrpc: "2.0", id, ...x }));
    if (method === "eth_simulateV1") {
      const to = params[0][0].blockStateCalls[0].calls[0].to?.toLowerCase();
      const fail = to === REVERTS;
      const returnData = fail ? encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["Not enough balance"] }) : "0x";
      return reply({ result: [{ calls: [{ status: fail ? "0x0" : "0x1", returnData, logs: [], ...(fail ? { error: { code: 3, message: "execution reverted", data: returnData } } : {}) }] }] });
    }
    if (method === "eth_sendRawTransaction") {
      sent += 1;
      return reply({ result: "0x" + "ab".repeat(32) });
    }
    return reply({ error: { code: -32601, message: "method not found" } });
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

const policy = parsePolicy({
  window: { seconds: 3600 },
  native: { maxPerTxWei: parseEther("0.1").toString(), windowMaxWei: parseEther("0.5").toString() },
  destinations: { [PAYEE]: {}, [MULTICALL3]: {}, [REVERTS]: {} },
  tokens: { [TOKEN]: { approve: { spenders: [PAYEE], maxAmountRaw: "1000000" } } },
});
const config = {
  listenHost: "127.0.0.1",
  listenPort: 0,
  guardMode: "strict",
  failOpen: false,
  defaultChain: "arb-sepolia",
  chains: { "arb-sepolia": { id: "arb-sepolia", name: "Arbitrum Sepolia", chainId: CHAIN_ID, upstreamRpcUrl: `http://127.0.0.1:${upstream.address().port}`, preferSimulateV1: true, ecosystem: "arbitrum" } },
  guard: new Guard({ policy, store: new MemoryStore() }),
};
const proxy = createServer(config);
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${proxy.address().port}`;

const fee = { gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, chainId: CHAIN_ID };
async function send(label, raw, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
  }).then((r) => r.json());
  const outcome = res.error
    ? `${res.error.code} ${res.error.data?.policyCode ?? res.error.data?.code ?? ""} — ${res.error.data?.reason ?? res.error.message}${res.error.data?.path ? ` (at ${res.error.data.path})` : ""}`
    : `forwarded, hash ${res.result.slice(0, 10)}…`;
  console.log(`${label.padEnd(48)} ${outcome}`);
  return res;
}

const erc20 = parseAbi(["function approve(address,uint256)"]);
const mc3 = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool,bytes)[])"]);

await send("1. 0.05 ETH to an allowed payee", await agent.signTransaction({ ...fee, nonce: 0, to: PAYEE, value: parseEther("0.05") }));
await send("2. 0.05 ETH to an address not in the policy", await agent.signTransaction({ ...fee, nonce: 1, to: STRANGER, value: parseEther("0.05") }));
const hidden = encodeFunctionData({ abi: mc3, functionName: "aggregate3", args: [[{ target: TOKEN, allowFailure: false, callData: encodeFunctionData({ abi: erc20, functionName: "approve", args: [STRANGER, maxUint256] }) }]] });
await send("3. unlimited approve hidden inside Multicall3", await agent.signTransaction({ ...fee, nonce: 1, to: MULTICALL3, data: hidden }));
await send("4. a call that would revert", await agent.signTransaction({ ...fee, nonce: 1, to: REVERTS, value: 0n }));
const auth = await agent.signAuthorization({ contractAddress: STRANGER, chainId: CHAIN_ID, nonce: 2 });
await send("5. EIP-7702: delegate this account to a stranger", await agent.signTransaction({ ...fee, type: "eip7702", nonce: 1, to: agent.address, authorizationList: [auth] }));
const key = { "idempotency-key": "invoice-1009" };
await send("6a. pay invoice 1009 (Idempotency-Key)", await agent.signTransaction({ ...fee, nonce: 1, to: PAYEE, value: parseEther("0.01") }), key);
await send("6b. agent retries with a fresh nonce", await agent.signTransaction({ ...fee, nonce: 2, to: PAYEE, value: parseEther("0.01") }), key);

console.log(`\nThe mock RPC received ${sent} of 7 transactions.${sent === 2 ? " Demo OK" : ""}`);
proxy.close();
upstream.close();
if (sent !== 2) process.exit(1);
