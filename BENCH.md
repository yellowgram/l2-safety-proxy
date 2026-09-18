# Latency bench — raw send vs guarded send

Compare the **added latency** of L2 Send Guard against a direct `eth_sendRawTransaction` to the same upstream. Methodology is local/mocked so it needs **no capital**, no funded accounts, and no mainnet txs.

## What we measure

| Scenario | Path | Why |
| --- | --- | --- |
| **Raw send** | Client → mock upstream `eth_sendRawTransaction` | Baseline (no simulation) |
| **Guarded (eth_call only)** | Client → proxy → `eth_call` sim → forward send | Steady-state when V1 is disabled |
| **Guarded (after V1 cache)** | Client → proxy → `eth_call` only → forward | Steady-state after upstream rejected `eth_simulateV1` (`-32601`/`-32602`) |

We report **mean / p50 / p95** over N iterations (default 40) after a short warmup.

## How to run

```bash
npm run build   # optional; bench uses tsx on TypeScript
npm run bench
```

Env knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `L2SG_BENCH_ITERS` | `40` | Timed iterations per scenario |
| `L2SG_BENCH_WARMUP` | `5` | Discarded warmup calls |

The bench also asserts that **after the first unsupported V1 response**, subsequent guarded sends do **not** re-hit `eth_simulateV1` (capability cache). Exit code `1` if that invariant fails.

## Interpreting results

- Mock upstream adds a few milliseconds of artificial delay so timing is stable on CI laptops. **Do not treat absolute ms as production RTT.**
- Useful signal is **relative overhead**: `guarded_mean - raw_mean`.
- Production overhead ≈ one extra JSON-RPC round-trip (`eth_call` or `eth_simulateV1`) plus proxy parse/recover time. Public L2 RTT usually dominates.
- Fail-open / abort paths are not timed here; abort avoids the upstream send entirely (often *faster* than a reverting broadcast + receipt wait).

## Optional live (manual)

If you want public-testnet RTT numbers:

1. Start the proxy against public Sepolia RPCs (see `.env.example`).
2. Time read-only `eth_blockNumber` through proxy vs direct (no send).
3. For guarded send, use an **unfunded** ephemeral key and a known-reverting calldata; expect `-32080` abort (no broadcast). Do not fund accounts for this measurement.

Live numbers vary with public RPC load; prefer the mocked bench for regression checks in CI.
