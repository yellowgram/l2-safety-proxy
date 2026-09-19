# Sepolia live smoke

## Arb Sepolia definite-abort — 2026-09-19 ~09:07 ET

**Result:** PASS abort via `eth_call` after Arb public RPC rejects `eth_simulateV1` shape (`cannot unmarshal … simOpts`); capability-cache marks V1 unsupported. Forward broadcast slice **stopped** — faucets blocked (triangle 503; HTML-only drips). No invented hashes.

Reproduce: `npm run demo:sepolia` (see also `docs/SEND_LOG.md`).

---

# Sepolia live smoke

## Re-smoke (capability-cache) — 2026-09-18 22:49 EDT

**Result:** PASS — guarded send on Base Sepolia now aborts definite reverts via `eth_call` after unsupported `eth_simulateV1`, and the process-lifetime capability cache skips V1 on subsequent sends.

### Configuration

- Proxy loaded from local gitignored `.env` / defaults (public RPCs only).
- **Base Sepolia public RPC:** `https://sepolia.base.org`
- Ephemeral unfunded signer created in memory and discarded (no keys stored or committed).
- Zero-value EIP-1559 tx to Base Sepolia USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) with calldata `0xdeadbeef`.
- No capital, no mainnet, no broadcast of a successful send.

### Checks

| Check | Result |
| --- | --- |
| `GET /health` | **PASS** — `ok: true`, chains include `base-sepolia`, `failOpen: true` |
| Control `eth_call` (same to/data) via proxy | **PASS** — upstream `code: 3, message: execution reverted` |
| Guarded `eth_sendRawTransaction` #1 | **PASS** — JSON-RPC **`-32080`**, `confidence: definite`, `simMethod: eth_call`, `aborted: true` (~193ms) |
| Capability cache after #1 | **PASS** — upstream URL marked V1-unsupported (`count: 1`) |
| Guarded send #2 (same raw) | **PASS** — again **`-32080`** / `eth_call` (~105ms, faster; cache count still `1`) |

Reproduce (after `npm run build`):

```bash
node scripts/live-smoke-cache.mjs
```

### Interpretation

Base Sepolia public RPC still rejects the proxy’s `eth_simulateV1` shape with **`-32602 Invalid params`**. The guard marks that upstream unsupported, falls back to **`eth_call` before fail-open**, and aborts on definite revert. Subsequent sends do **not** re-probe V1 for the process lifetime (verified by cache flag + lower latency on send #2). Fail-open remains for uncertain sims; this smoke exercised the definite-abort branch only.

---

## Earlier smoke — 2026-09-18 16:22–16:24 EDT

**Result:** PASS for proxy startup, health, and read-only RPC forwarding; the guarded-send attempt was safely not broadcast and exposed a live `eth_simulateV1` compatibility limitation (since hardened — see re-smoke above).

### Configuration

- Created a local, gitignored `.env` from `.env.example`.
- Configured the public, no-key endpoints by name:
  - **Arbitrum Sepolia public RPC:** `https://sepolia-rollup.arbitrum.io/rpc`
  - **Base Sepolia public RPC:** `https://sepolia.base.org`
- No API keys, user private keys, funded accounts, or mainnet endpoints were used. `.env` was not committed.

### Checks run

The proxy was built with `npm run build` and started locally at `http://127.0.0.1:8545`.

| Check | Result |
| --- | --- |
| `GET /health` | **PASS** — `ok: true`, chains `arb-sepolia,base-sepolia`, default `arb-sepolia`, `failOpen: true` |
| `eth_chainId` via proxy, default Arb chain | **PASS** — `0x66eee` (421614) |
| `eth_blockNumber` via proxy, default Arb chain | **PASS** — `0x127ec8a4` (310298788 at capture) |
| `eth_chainId` via proxy with `x-l2sg-chain: base-sepolia` | **PASS** — `0x14a34` (84532) |
| `eth_blockNumber` via proxy with Base header | **PASS** — `0x2cd1f5f` (46997343 at capture) |

The same read-only calls also succeeded directly against both named public endpoints. No rate limiting or HTTP failures occurred during this run.

### Safe revert/simulation attempt (pre-hardening)

On that first run, Base Sepolia returned `-32602` for `eth_simulateV1` and the guard **fail-opened** without trying `eth_call` first; upstream then rejected the unfunded send (`-32003`). Safe (no funds / no tx hash) but not a definite-revert abort.

### Hardening (post first smoke)

Unsupported / invalid-params V1 (`-32601` / `-32602`) now **falls back to `eth_call` before fail-open**; the upstream is **capability-cached**; optional `L2SG_RPC_FALLBACK_*` can supply an alternate sim RPC. Confirmed live in the re-smoke section above.
