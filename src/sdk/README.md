# l2-send-guard/sdk

Small client helpers for talking to the proxy. They never touch keys: you sign, the proxy checks and forwards.

```ts
import { viemHttpArgs, sendRawTransaction, classifyGuardError } from "l2-send-guard/sdk";
```

## viem

```ts
import { createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { viemHttpArgs } from "l2-send-guard/sdk";

const wallet = createWalletClient({
  account, // a local account; viem signs and sends eth_sendRawTransaction
  chain: baseSepolia,
  transport: http(...viemHttpArgs({ proxyUrl: "http://127.0.0.1:8545", chain: "base-sepolia" })),
});
```

`chain` sets the `x-l2sg-chain` header (a name from `L2SG_CHAINS` or a numeric chain id). Leave it out to use
the proxy's default chain. `createGuardFetch(opts)` does the same as a custom `fetch`.

## One send under an idempotency key

viem sets headers once per client, so for a per-send `Idempotency-Key` sign first, then send with
`sendRawTransaction`:

```ts
import { sendRawTransaction } from "l2-send-guard/sdk";

const raw = await account.signTransaction(await wallet.prepareTransactionRequest({ to, value }));
const hash = await sendRawTransaction({ proxyUrl: "http://127.0.0.1:8545", chain: "base-sepolia", raw, idempotencyKey: "invoice-1009" });
```

Retrying with the same key and the same signed transaction returns the same hash. A different transaction
under the same key is refused (`-32087`) unless it reuses the nonce (a fee bump).

## ethers v6

```ts
import { FetchRequest, JsonRpcProvider } from "ethers";
import { ethersV6Connection } from "l2-send-guard/sdk";

const { url, headers } = ethersV6Connection({ proxyUrl: "http://127.0.0.1:8545", chain: "base-sepolia" });
const req = new FetchRequest(url);
for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
const provider = new JsonRpcProvider(req);
```

## Errors

```ts
import { classifyGuardError, guardErrorData } from "l2-send-guard/sdk";

try {
  await wallet.sendTransaction({ to, value });
} catch (err) {
  switch (classifyGuardError(err)) {
    case "policy_denied":        // -32083: stop; guardErrorData(err).policyCode says why
    case "idempotency_conflict": // -32087: stop; don't pay twice
    case "bypass_locked":        // -32088: stop; a human must look
      throw err;
    case "definite_revert":      // -32080: don't rebroadcast this transaction
    case "strict_uncertain":     // -32082: simulation couldn't decide; retry later
    case "chain_mismatch":       // -32084
    case "unsigned_refused":     // -32081: sign locally
    default:
      throw err;
  }
}
```

`classifyGuardError` and the `is…Error` helpers read `code` from the error or its `cause`, so they work on
viem and ethers errors and on `GuardRpcError` from `sendRawTransaction`.
