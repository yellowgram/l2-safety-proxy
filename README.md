# L2 Send Guard

**Multi-L2 pre-broadcast safety middleware** — drop-in JSON-RPC proxy that sits in front of your existing RPC, simulates `eth_sendRawTransaction`, aborts **definite** reverts with decoded errors, and **fail-opens** when uncertain.

> Not another RPC cloud. Not an indexer. Not key custody. Not an OP-only clone of OP Security Proxy.

**Ecosystems (day one):** Arbitrum Sepolia + Base Sepolia (OP Stack template included).

## Quick start (<10 min)

```bash
git clone <repo> && cd prototype   # project root
npm install
npm test                           # must pass
npm run build
cp .env.example .env               # optional; public RPCs work out of the box
npm start                          # http://127.0.0.1:8545
```

Point your app’s RPC URL at the proxy. Select chain with header `x-l2sg-chain: arb-sepolia` or `base-sepolia`.

```bash
curl -s http://127.0.0.1:8545/health
```

Docker:

```bash
docker compose up --build
```

## Behavior

| Simulation result | Confidence | Default action |
| --- | --- | --- |
| Revert with clear data/status | `definite` | **Abort** — JSON-RPC `-32080` + decoded reason |
| Success | `definite` | Forward to upstream |
| Unsupported method / network / parse error | `uncertain` | **Fail-open** — forward to upstream |

Prefer **`eth_simulateV1`** when the node supports it; on `-32601`/`-32602` (unsupported / invalid params) fall back to **`eth_call` before fail-open**, and cache that upstream as V1-unsupported for the process lifetime. See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Config (env)

See [.env.example](./.env.example).

| Variable | Default | Meaning |
| --- | --- | --- |
| `L2SG_CHAINS` | `arb-sepolia,base-sepolia` | Enabled chains |
| `L2SG_DEFAULT_CHAIN` | first in list | Default when no header |
| `L2SG_FAIL_OPEN` | `true` | Forward on uncertainty |
| `L2SG_RPC_ARB_SEPOLIA` | public Arb Sepolia | Upstream URL |
| `L2SG_RPC_BASE_SEPOLIA` | public Base Sepolia | Upstream URL |
| `L2SG_RPC_OP_SEPOLIA` | public OP Sepolia | Upstream URL |
| `L2SG_RPC_FALLBACK_*` | (unset) | Optional alternate RPC for simulation only |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm test` | Unit + mocked integration tests |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run proxy |
| `npm run dev` | Run via `tsx` (no build) |
| `npm run bench` | Mocked latency: raw send vs guarded send (see [BENCH.md](./BENCH.md)) |


## Client SDK (wallets / agents)

Thin helpers in `src/sdk/` wire viem or ethers v6 to the proxy URL + `x-l2sg-chain` header. **No key custody** — you keep signing locally.

```ts
import { http } from "viem";
import { viemHttpArgs } from "l2-send-guard";

const transport = http(
  ...viemHttpArgs({ proxyUrl: "http://127.0.0.1:8545", chain: "base-sepolia" })
);
```

Full examples (viem + ethers v6): [src/sdk/README.md](./src/sdk/README.md). Latency methodology: [BENCH.md](./BENCH.md).

## Demo

Step-by-step public-testnet demo (no secrets): [docs/DEMO.md](./docs/DEMO.md).

Future grant readiness checklist (do not apply yet): [docs/AF_TRACTION_PREP.md](./docs/AF_TRACTION_PREP.md).

## Differentiation

- **vs OP Security Proxy:** multi-ecosystem (Arb + OP/Base), `eth_simulateV1` preference, confidence flags, TS middleware — not local-OP-only revm.
- **vs Tenderly:** thin fail-open RPC drop-in, not a full DevOps suite.
- **vs eRPC:** complementary safety layer in front of reliability proxies.

## License

MIT — see [LICENSE](./LICENSE).

## Out of scope

Hosted SaaS, billing, indexing, MEV, tokens, private-key custody.
