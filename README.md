# L2 Send Guard

[![CI](https://github.com/yellowgram/l2-safety-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/yellowgram/l2-safety-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
**Public OSS** — `git clone https://github.com/yellowgram/l2-safety-proxy.git`


**Multi-L2 pre-broadcast safety middleware** for wallets, agents, and Orbit/OP operators.

Drop-in JSON-RPC proxy in front of your existing RPC: simulate `eth_sendRawTransaction`, **abort definite reverts** with decoded errors, and **fail-open** when uncertain. Not an RPC cloud. Not an indexer. **No key custody.**

| | |
| --- | --- |
| **Chains (day one)** | Arbitrum Sepolia · OP Sepolia · Base Sepolia |
| **Submit** | `eth_sendRawTransaction` (simulated) |
| **Refuse** | `eth_sendTransaction` (`-32081`) — sign externally |
| **License** | MIT |

---

## 60-second start

```bash
git clone https://github.com/yellowgram/l2-safety-proxy.git
cd l2-safety-proxy
npm install && npm test && npm run build
npm start                          # http://127.0.0.1:8545
```

```bash
curl -s http://127.0.0.1:8545/health
# Point your app RPC URL here. Select chain:
#   header x-l2sg-chain: arb-sepolia | op-sepolia | base-sepolia
```

Docker:

```bash
docker compose up --build
```

**Prove abort + fail-open offline (no keys, no capital):**

```bash
node scripts/demo-offline.mjs
```

Full Sepolia walkthrough (npm + Docker): **[docs/DEMO.md](./docs/DEMO.md)**.

---

## Chain matrix

| Key | Ecosystem | Chain ID | Default public RPC |
| --- | --- | --- | --- |
| `arb-sepolia` | Arbitrum | 421614 | `https://sepolia-rollup.arbitrum.io/rpc` |
| `op-sepolia` | OP Stack | 11155420 | `https://sepolia.optimism.io` |
| `base-sepolia` | Base (OP Stack) | 84532 | `https://sepolia.base.org` |

Override with `L2SG_RPC_*` / `L2SG_RPC_FALLBACK_*` (see [.env.example](./.env.example)). Production tip: point upstreams at the Alchemy / QuickNode / eRPC URL you already use — this middleware sits **in front**, it does not replace your RPC vendor.

---

## Safety guarantees (honest)

| Guarantee | Detail |
| --- | --- |
| **Fail-open** | Default `L2SG_FAIL_OPEN=true`. Uncertain / unsupported / network sim failures **forward** to upstream so availability is preserved. |
| **Abort only when definite** | Clear revert → JSON-RPC **`-32080`** + decoded reason; raw tx is **not** broadcast. |
| **No custody** | Proxy never holds keys or mnemonics. Only signed `eth_sendRawTransaction` is accepted; `eth_sendTransaction` is refused (`-32081`). |
| **Not absolute truth** | Simulation ≠ finality. Always inspect `confidence` / `aborted` on error `data`. |
| **Sim preference** | Prefer `eth_simulateV1`; on unsupported (`-32601`/`-32602`) fall back to `eth_call` **before** fail-open; capability-cache per upstream for process lifetime. |

Details: [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Client SDK

Thin helpers in `src/sdk/` wire **viem** or **ethers v6** to the proxy URL + `x-l2sg-chain`. Signing stays local.

```ts
import { http } from "viem";
import { viemHttpArgs } from "l2-send-guard";

const transport = http(
  ...viemHttpArgs({ proxyUrl: "http://127.0.0.1:8545", chain: "base-sepolia" })
);
```

Full examples: **[src/sdk/README.md](./src/sdk/README.md)**. Agent submit rules: **[docs/AGENTS.md](./docs/AGENTS.md)**.

---

## Behavior cheat-sheet

| Simulation result | Confidence | Default action |
| --- | --- | --- |
| Revert with clear data/status | `definite` | **Abort** — `-32080` + decoded reason |
| Success | `definite` | Forward to upstream |
| Unsupported / network / parse error | `uncertain` | **Fail-open** — forward |

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm test` | Unit + mocked integration |
| `npm run build` | TypeScript → `dist/` |
| `npm start` / `npm run dev` | Run proxy |
| `npm run bench` | Mocked latency (see [BENCH.md](./BENCH.md)) |
| `node scripts/demo-offline.mjs` | Offline abort + fail-open proof |
| `node scripts/live-smoke-cache.mjs` | Live Base Sepolia definite-abort smoke |

---

## Docs map (integrators)

| Doc | Why open it |
| --- | --- |
| **[docs/DEMO.md](./docs/DEMO.md)** | Public Sepolia demo — npm + Docker, abort + fail-open |
| **[docs/AGENTS.md](./docs/AGENTS.md)** | Bot / agent submit paths (accepted vs refused) |
| **[docs/AF_TRACTION_PREP.md](./docs/AF_TRACTION_PREP.md)** | Future AF readiness checklist — **do not apply yet** |
| **[docs/SOFT_WTP.md](./docs/SOFT_WTP.md)** | Soft WTP problem brief — **no outreach** |
| **[docs/TRACTION_PLAN.md](./docs/TRACTION_PLAN.md)** | Weekly agent-runnable traction (no founder intros / no grant apply) |
| **[docs/METRICS.md](./docs/METRICS.md)** | Weekly users/sims template for CoS |
| [docs/SMOKE.md](./docs/SMOKE.md) | Dated live smoke log |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Request flow, confidence, threat model |

---

## Differentiation

- **vs OP Security Proxy:** multi-ecosystem (Arb + OP + Base), `eth_simulateV1` preference, confidence flags, TS middleware — not local-OP-only revm.
- **vs Tenderly:** thin fail-open RPC drop-in, not a full DevOps suite.
- **vs eRPC:** complementary safety layer in front of reliability proxies.

## Out of scope

Hosted SaaS, billing, indexing, MEV, tokens, private-key custody, unsolicited outreach, grant applications from this repo alone.

## License

MIT — see [LICENSE](./LICENSE).
