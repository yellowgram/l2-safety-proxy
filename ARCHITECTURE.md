# L2 Send Guard — Architecture

## What this is

Drop-in **JSON-RPC middleware** that sits **in front of an existing L2 RPC** (Alchemy, QuickNode, public endpoints, eRPC, self-hosted). On `eth_sendRawTransaction` (and related submit paths) it:

1. Parses the signed raw tx (**no private keys** — recovery of `from` only)
2. Simulates against the upstream node
3. If **definite** revert → abort with decoded reason + `confidence: "definite"`
4. If uncertain / stale / sim failure → **fail-open** (forward to upstream)
5. All other RPC methods pass through unchanged

It is **not** a general RPC cloud, indexer, MEV product, or key custodian.

## Request flow

```
Wallet / bot / agent
        │  JSON-RPC (eth_sendRawTransaction)
        ▼
┌───────────────────────┐
│   L2 Send Guard       │
│  1. select chain      │  (env + x-l2sg-chain header)
│  2. parse + recover   │
│  3. simulate          │
│     ├ eth_simulateV1  │  preferred when available
│     └ eth_call        │  documented fallback
│  4. classify          │
│     ├ definite revert → JSON-RPC error -32080 (abort)
│     ├ success         → forward upstream
│     └ uncertain       → fail-open forward (default)
└───────────┬───────────┘
            ▼
   Existing upstream RPC
```

## Confidence model

| Outcome | Confidence | Action (default) |
| --- | --- | --- |
| Node returns standard revert data / status=0 from sim | `definite` | **Abort** — return decoded error |
| Sim succeeds | `definite` | Forward send |
| Method missing, HTTP/network error, unparseable tx, unexpected shape | `uncertain` | **Fail-open** forward |
| `L2SG_FAIL_OPEN=false` | any uncertain | Surface error instead of forward |

**Ethics:** default fail-open so middleware lag or node quirks never brick operators. Simulation is advisory relative to on-chain truth; confidence flags make that explicit.

## Simulation strategy

1. **Prefer `eth_simulateV1`** when `preferSimulateV1` is true for the chain (Base Flashblocks-aware nodes, and any geth/OP build that advertises it).
2. If the method is **unsupported or unavailable for our request shape** — JSON-RPC `-32601` (method not found) **or** `-32602` (invalid params, observed on Base Sepolia public RPC) — **fallback to `eth_call`** with recovered `from` at `latest` **before** any fail-open forward.
3. **Per-upstream capability cache (process lifetime):** after `-32601`/`-32602` (or equivalent message) for `eth_simulateV1`, that upstream URL skips V1 for the rest of the process and goes straight to `eth_call`.
4. **Optional `L2SG_RPC_FALLBACK_<CHAIN>`:** if primary `eth_call` is still uncertain, retry simulation against the alternate RPC (sends still forward to the primary upstream).
5. Decode `Error(string)` / `Panic(uint256)` / custom selectors for human-readable reasons. Confidence stays `definite` only on clear revert/success; unsupported V1 alone never fail-opens without trying `eth_call`.

No local revm dependency in M1 (KISS TypeScript). A future M2 may add an optional local engine for offline CI.

## Multi-ecosystem (hard differentiation)

Day-one config templates:

| Key | Ecosystem | Default public RPC |
| --- | --- | --- |
| `arb-sepolia` | Arbitrum | `sepolia-rollup.arbitrum.io` |
| `op-sepolia` | OP Stack | `sepolia.optimism.io` |
| `base-sepolia` | Base (OP Stack + Flashblocks path) | `sepolia.base.org` |

Select chain per request via `x-l2sg-chain: arb-sepolia` (or numeric chain id). This is explicitly **not** OP-only.

## Threat model (M1)

| Threat | Mitigation |
| --- | --- |
| Middleware blocks good txs due to stale state | Fail-open on uncertain; document confidence |
| Middleware used as key custody | Never accepts seeds/keys; only signed raw txs |
| Operator thinks abort = on-chain certainty | `confidence` + `simMethod` in error `data` |
| Upstream outage during sim | Fail-open forward (may still fail at upstream) |
| Malicious upstream | Out of scope — trust model = user's chosen RPC |
| MEV / order-flow steering | None — no reordering, no private mempool product |
| DoS via heavy sim | M1: single sim per send; rate limits = hosted tier later |

## vs related tools

| Tool | Relation |
| --- | --- |
| **OP Security Proxy** | Problem validation (revert intercept + fail-open). Their scope is local OP Stack / revm. We differentiate: **Arbitrum + OP/Base from day one**, prefer **`eth_simulateV1`**, TypeScript drop-in, confidence UX. Do not clone OP-only. |
| **Tenderly** | Full simulation DevOps suite (paid, heavy). We are a **thin fail-open RPC middleware** for wallets/bots/agents that already have an RPC. |
| **eRPC** | Multi-upstream reliability/cache proxy. **Complementary** — place Send Guard in front of eRPC (or any RPC). Do not rebuild failover/indexing. |
| **Alchemy / QuickNode** | Managed RPC clouds. We sit in front; we do not replace them. |

## Out of scope (M1)

Hosted SaaS, billing, indexing, MEV, tokens, private-key custody, Safe-enterprise policy engines.

## Package layout

```
src/
  config/     chain templates + env loader
  decode/     revert decoding
  sim/        eth_simulateV1 + eth_call + tx parse + capability cache
  proxy/      HTTP JSON-RPC server + intercept handler
  sdk/        thin viem / ethers v6 provider helpers (no key custody)
  types/      shared types
scripts/      mocked latency bench (`npm run bench`)
tests/        unit + mocked integration (no secrets)
BENCH.md      raw vs guarded send methodology
```
