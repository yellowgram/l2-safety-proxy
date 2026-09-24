# L2 Send Guard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-public-brightgreen)](https://github.com/yellowgram/l2-safety-proxy)

**Multi-L2 pre-broadcast safety middleware** — simulate `eth_sendRawTransaction`, **abort definite reverts** with decoded errors, **fail-open** (or strict-abort) when uncertain. Optional **Layer 2** address/spend policy (allowlist + caps) beside simulation — default **off**.

Public: `git clone https://github.com/yellowgram/l2-safety-proxy.git`

> **Paid help (optional):** fixed-scope AgentKit wire-up / policy pack review / retainer — see **[SUPPORT.md](./SUPPORT.md)**. OSS core stays free.  
> **Inbound demo (no keys):** [`docs/INBOUND_DEMO.md`](./docs/INBOUND_DEMO.md) · sim ≠ policy: [`docs/COMPETITIVE.md`](./docs/COMPETITIVE.md)

## What

| | |
| --- | --- |
| **Is** | Drop-in JSON-RPC proxy in front of your existing Arb / OP / Base Sepolia RPC |
| **Does** | Sim → abort definite revert (`-32080`) or forward; every send decision includes `decision`, `confidence`, `chainId`, decoded revert when present |
| **Layer 2 (opt)** | Address/spend policy beside sim: allowlist + native caps; outside policy → `-32083` STOP (not fail-open). Default **off** |
| **Chains** | `arb-sepolia` · `op-sepolia` · `base-sepolia` (no new chains in this release) |
| **Sim** | Prefer `eth_simulateV1` → fall back to `eth_call`; capability-cache per upstream |

## What it is not

Not an RPC cloud. Not an indexer. Not revm. Not a Safe/enterprise policy engine. **No key custody** — only signed `eth_sendRawTransaction`; `eth_sendTransaction` is refused (`-32081`). Layer 2 is thin allowlist/caps only.

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

Stranger walkthrough + expected PASS transcript: [`docs/INBOUND_DEMO.md`](./docs/INBOUND_DEMO.md).

```bash
npm run build
npm run demo:dual-layer   # offline: -32080 revert abort AND -32083 policy stop
npm run demo:sepolia
npm run demo:delta-a   # Base Sepolia abort + faucet attempts (needs .env burner)
npm run agent:loop     # ≥100 offline agent decisions → docs/agent-decisions.jsonl
# Offline Layer 1 only: npm run demo:offline
```

Expect: **known-revert → abort** with `confidence` + decoded reason; **known-success → forward** when the signer has Sepolia ETH (set `DEMO_PRIVATE_KEY` or use a faucet; if faucet blocks, the script logs and stops that slice).

## GUARD_MODE

| Mode | Env | Uncertain / missing / low-confidence sim |
| --- | --- | --- |
| **open** (default) | `GUARD_MODE=open` | **fail_open** — forward upstream |
| **strict** | `GUARD_MODE=strict` | **abort** (`-32082`) — do not forward |

Alias: `L2SG_GUARD_MODE`. Legacy: `L2SG_FAIL_OPEN=true|false` when `GUARD_MODE` unset.


## Layer 2 — address / spend policy (optional)

Simulating a send catches definite failures. It does **not** answer “should this address get money at all?” Layer 2 sits **beside** Layer 1:

| | |
| --- | --- |
| **Within policy** | Continue to Layer 1 sim → auto if sim ok |
| **Outside policy** | **STOP** (`-32083` `policy_denied`) — do not forward |
| **Default** | **OFF** — existing fail-open users unchanged |
| **Config** | `L2SG_POLICY_ENABLED` + `L2SG_POLICY_FILE` / `L2SG_POLICY_ALLOWLIST` / caps (see `.env.example`, `policy.example.json`) |

Layer 1 uncertain → still fail-open (or strict). Layer 2 deny → always definite stop. Operator keeps keys.

**Honesty:** Layer 2 allowlist does **not** unwind `approve` / `setApprovalForAll` / Permit2 / multicall router calldata. Allowlisting a router ≠ destination safety. See [ARCHITECTURE.md](./ARCHITECTURE.md#what-layer-2-is-not).

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


## Agent drop-in (viem / AgentKit)

Point your wallet client’s HTTP transport at the proxy — signing stays local (no custody):

```ts
import { http } from "viem";
import { viemHttpArgs, isPolicyDeniedError } from "l2-send-guard/sdk";

const transport = http(
  ...viemHttpArgs({ proxyUrl: "http://127.0.0.1:8545", chain: "base-sepolia" })
);
```

Full example: [`examples/agentkit-viem.ts`](./examples/agentkit-viem.ts).  
Agent policy template: [`policy.agent.example.json`](./policy.agent.example.json).  
*Sim ≠ policy* positioning: [`docs/COMPETITIVE.md`](./docs/COMPETITIVE.md).

## Paid support (optional)

OSS core stays free. Fixed SKUs (AgentKit wire-up, policy pack review, priority retainer): [`SUPPORT.md`](./SUPPORT.md).  
Reply on GitHub Issues / Discussions, or email `CONTACT_EMAIL_TBA`. Demo first: [`docs/INBOUND_DEMO.md`](./docs/INBOUND_DEMO.md).

## Client probes

Read-only check for Reth `#27342` (`eth_call` vs `eth_estimateGas` under `--rpc.gascap`):

```bash
RETH_BIN=$(which reth) npm run probe:gascap
```

Exit `2` = split (call capped/OOG, estimate returns gas > cap). No keys, no broadcast. Design notes: [docs/drafts/27342-design.md](./docs/drafts/27342-design.md).

## License

MIT — see [LICENSE](./LICENSE).
