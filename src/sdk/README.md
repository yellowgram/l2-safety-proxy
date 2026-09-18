# L2 Send Guard — client SDK

Thin helpers so wallets, bots, and agents can point at the proxy **without key custody**.
The SDK only builds a URL + optional `x-l2sg-chain` header. Signing stays in your wallet.

## Install / import

From this package root (after `npm run build`):

```ts
import {
  viemHttpArgs,
  ethersV6Connection,
  createGuardFetch,
  createGuardConnection,
  GUARD_CHAIN_HEADER,
} from "l2-send-guard"; // or relative: ../sdk/index.js
```

Start the proxy first (`npm start` → `http://127.0.0.1:8545`).

## viem

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { viemHttpArgs } from "l2-send-guard";

const transport = http(
  ...viemHttpArgs({
    proxyUrl: "http://127.0.0.1:8545",
    chain: "base-sepolia",
  })
);

const client = createWalletClient({
  account: privateKeyToAccount(process.env.DEMO_KEY as `0x${string}`),
  chain: baseSepolia,
  transport,
});

// eth_sendRawTransaction goes through the guard (simulate → abort or fail-open)
await client.sendTransaction({ to: "0x…", value: 0n, data: "0xdeadbeef" });
```

Or inject a custom fetch:

```ts
import { createGuardFetch } from "l2-send-guard";

const transport = http("http://127.0.0.1:8545", {
  fetch: createGuardFetch({
    proxyUrl: "http://127.0.0.1:8545",
    chain: "arb-sepolia",
  }),
});
```

## ethers v6

```ts
import { FetchRequest, JsonRpcProvider, Wallet } from "ethers";
import { ethersV6Connection } from "l2-send-guard";

const { url, headers } = ethersV6Connection({
  proxyUrl: "http://127.0.0.1:8545",
  chain: "arb-sepolia",
});
const req = new FetchRequest(url);
for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);

const provider = new JsonRpcProvider(req);
const wallet = new Wallet(process.env.DEMO_KEY!, provider);
// Sends are simulated by the proxy before broadcast
await wallet.sendTransaction({ to: "0x…", value: 0, data: "0xdeadbeef" });
```

## Raw JSON-RPC

```ts
import { createGuardConnection } from "l2-send-guard";

const { url, headers } = createGuardConnection({
  proxyUrl: "http://127.0.0.1:8545",
  chain: "base-sepolia",
});

await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendRawTransaction",
    params: ["0x…"], // already signed — proxy never sees keys
  }),
});
```

## Notes

- **Fail-open** remains the proxy default: uncertain sims forward upstream.
- Definite reverts return JSON-RPC `-32080` with `data.confidence: "definite"`.
- `eth_sendTransaction` is **refused** (`-32081`) — sign externally and use `eth_sendRawTransaction`. See [docs/AGENTS.md](../../docs/AGENTS.md).
- Chain keys: `arb-sepolia`, `op-sepolia`, `base-sepolia`.
- No secrets belong in the SDK. Do not commit private keys.
