# L2 Send Guard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-public-brightgreen)](https://github.com/yellowgram/l2-safety-proxy)

**Multi-L2 pre-broadcast safety middleware** — simulate `eth_sendRawTransaction`, **abort definite reverts** with decoded errors, **fail-open** (or strict-abort) when uncertain.

Public: `git clone https://github.com/yellowgram/l2-safety-proxy.git`

## What

| | |
| --- | --- |
| **Is** | Drop-in JSON-RPC proxy in front of your existing Arb / OP / Base Sepolia RPC |
| **Does** | Sim → abort definite revert (`-32080`) or forward; every send decision includes `decision`, `confidence`, `chainId`, decoded revert when present |
| **Chains** | `arb-sepolia` · `op-sepolia` · `base-sepolia` (no new chains in this release) |
| **Sim** | Prefer `eth_simulateV1` → fall back to `eth_call`; capability-cache per upstream |

## What it is not

Not an RPC cloud. Not an indexer. Not revm. **No key custody** — only signed `eth_sendRawTransaction`; `eth_sendTransaction` is refused (`-32081`).

## Install

```bash
npm install && npm test && npm run build
npm start   # http://127.0.0.1:8545
# or: npx l2-send-guard
```

```bash
curl -s http://127.0.0.1:8545/health
# header x-l2sg-chain: arb-sepolia | op-sepolia | base-sepolia | numeric chainId
```

## Demo (Arb Sepolia, ~10 min)

```bash
npm run build
npm run demo:sepolia
npm run demo:delta-a   # Base Sepolia abort + faucet attempts (needs .env burner)
npm run agent:loop     # ≥100 offline agent decisions → docs/agent-decisions.jsonl
# Offline (no network): npm run demo:offline
```

Expect: **known-revert → abort** with `confidence` + decoded reason; **known-success → forward** when the signer has Sepolia ETH (set `DEMO_PRIVATE_KEY` or use a faucet; if faucet blocks, the script logs and stops that slice).

## GUARD_MODE

| Mode | Env | Uncertain / missing / low-confidence sim |
| --- | --- | --- |
| **open** (default) | `GUARD_MODE=open` | **fail_open** — forward upstream |
| **strict** | `GUARD_MODE=strict` | **abort** (`-32082`) — do not forward |

Alias: `L2SG_GUARD_MODE`. Legacy: `L2SG_FAIL_OPEN=true|false` when `GUARD_MODE` unset.

## Confidence (response field)

Every abort / fail_open / forward response includes:

| Field | Values |
| --- | --- |
| `decision` | `abort` \| `fail_open` \| `forward` |
| `confidence` | `simulate_v1` \| `eth_call` \| `unknown` (sim method provenance) |
| `certainty` | `definite` \| `uncertain` |
| `chainId` | e.g. `421614` |
| `decoded` | revert reason when present |

Success / fail-open forwards attach metadata on JSON-RPC extension `l2sg`; aborts put it in `error.data`.

## Evidence

Send decisions: [docs/SEND_LOG.md](./docs/SEND_LOG.md). Architecture: [ARCHITECTURE.md](./ARCHITECTURE.md).


## Client probes

Read-only check for Reth `#27342` (`eth_call` vs `eth_estimateGas` under `--rpc.gascap`):

```bash
RETH_BIN=$(which reth) npm run probe:gascap
```

Exit `2` = split (call capped/OOG, estimate returns gas > cap). No keys, no broadcast. Design notes: [docs/drafts/27342-design.md](./docs/drafts/27342-design.md).

## License

MIT — see [LICENSE](./LICENSE).
