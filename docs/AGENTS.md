# Agent / bot submit paths

Point your agent’s **JSON-RPC HTTP URL** at the proxy (default `http://127.0.0.1:8545`). Select chain with header `x-l2sg-chain` (`arb-sepolia` | `op-sepolia` | `base-sepolia`) or numeric chain id.

## Accepted submit method

| Method | Behavior |
| --- | --- |
| `eth_sendRawTransaction` | Simulate → abort definite revert (`-32080`) or fail-open forward |
| `eth_sendRawTransactionSync` | Same intercept (if upstream supports it) |

Sign **outside** the proxy (wallet, KMS, agent signer). The proxy only sees already-signed raw txs — **no key custody**.

```bash
curl -s http://127.0.0.1:8545 \
  -H 'content-type: application/json' \
  -H 'x-l2sg-chain: op-sepolia' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x…"]}'
```

SDK helpers (header wiring only): [src/sdk/README.md](../src/sdk/README.md).

## Refused (no custody)

| Method | Response |
| --- | --- |
| `eth_sendTransaction` | JSON-RPC **`-32081`** — refused; use raw + external signer |

Unlocking accounts / node-held keys is out of scope. Do not point an unlocked geth account “through” this middleware expecting it to sign.

## Everything else

`eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_blockNumber`, … are **forwarded** untouched to the chain’s upstream RPC (fail-open posture for non-send traffic).

## Health

`GET /health` lists enabled chains (`arb-sepolia`, `op-sepolia`, `base-sepolia` by default), `chainDetails`, and which submit methods are accepted vs refused.


## Thin `check()` API (Delta C)

```ts
import { check } from "l2-send-guard/agent";
// check(rawTx, chain) → { decision, reason, certainty, simProvenance }
```

Founder loop (offline, ≥100 decisions, external users=0):

```bash
npm run agent:loop
# → docs/agent-decisions.jsonl
```


## Layer 2 (optional)

If `L2SG_POLICY_ENABLED` / policy file is on, address/spend allowlist+caps run **before** sim. Denials are `-32083` / `policy_denied` (not fail-open). `checkWithConfig` applies `config.policy` the same way. Default off.
