# Troubleshooting

## The proxy won't start

It refuses to start rather than run with a weaker setup than you asked for. The message says what to change.

| Message mentions | Fix |
| --- | --- |
| `no policy` | Set `L2SG_POLICY_FILE=./policy.json`, or `L2SG_POLICY=off` for simulation only |
| `is a 0.x policy file` | `npx l2-send-guard migrate-policy old.json > policy.json`, then review it |
| `L2SG_POLICY_ENABLED` or another `L2SG_POLICY_*` | Removed in 1.0: move the rules into the policy file |
| `unknown chain` | Check the spelling in `L2SG_CHAINS` (`arb-sepolia`, `op-sepolia`, `base-sepolia`, `ethereum`, `arbitrum`, `optimism`, `base`, `sepolia`) |
| `no public default RPC` | Mainnets need `L2SG_RPC_<NAME>`, e.g. `L2SG_RPC_BASE` |
| `store … is in use by process` | Another proxy uses the same state file. Use one file per process, or Postgres for several |
| `journal line is not JSON` | The state file is corrupt beyond its last line. Move it aside to start fresh (rolling caps and keys reset) |
| `PostgresStore needs the "pg" package` | `npm i pg` |

## Every send is refused with -32083

Read `error.data.policyCode` and `error.data.path`. `path` shows where in the transaction the rule fired,
e.g. `tx>aggregate3[1]` is the second call inside a Multicall3. [POLICY.md](./POLICY.md#deny-codes) lists
the codes. The usual causes:

- `DESTINATION_NOT_ALLOWED` for a contract you call through: the wrapper (Multicall3, a router) must be a destination too.
- `TOKEN_NOT_ALLOWED`: token calls are judged under `tokens`, not `destinations`. Add a `tokens` entry.
- `APPROVAL_OVER_CAP` with "(none set)": `approve.maxAmountRaw` is required for any approval.
- `CHAIN_NOT_ALLOWED`: the chain id isn't in `chains`.

## -32082 (simulation couldn't decide)

The upstream RPC doesn't support `eth_simulateV1`, and `eth_call` didn't give a clear answer (or, for a 7702
transaction, the RPC ignores state overrides, so the delegated code can't be simulated). Use an RPC that
supports `eth_simulateV1`, set a `L2SG_RPC_FALLBACK_<NAME>` that does, or accept the risk with `GUARD_MODE=open`.

## -32084 (chain mismatch)

The transaction was signed for a different chain than the one the proxy selected. Send the `x-l2sg-chain`
header (a name from `L2SG_CHAINS` or a numeric chain id), or set `L2SG_DEFAULT_CHAIN`.

## -32087

- `IDEMPOTENCY_CONFLICT`: the key already sent a different transaction. `error.data.priorTxHash` is that
  transaction. Don't send again under a new key unless you're sure the first one won't land; to replace it,
  re-sign with the same nonce.
- `STORE_DOWN`: the state store failed. Nothing was sent. Check the disk or the database.
- `CHAIN_READ_FAILED`: the upstream RPC didn't answer `eth_getTransactionCount`, which the bypass check needs.
  Nothing was sent. Retry, or fix the RPC. (`L2SG_BYPASS=off` skips the check.)

## -32088 (sender locked)

A transaction from this sender reached the chain without the guard (or the receive watch saw an approval the
policy would refuse). Find out what sent it: another process with the key, a wallet app, a leaked key. When
you've dealt with it, run `l2-send-guard unlock <address> --chain <id>` (stop the proxy first if you use the
file store). If something else legitimately shares the key, set `L2SG_BYPASS=alert` instead.

## Not a guard problem

`nonce too low`, `replacement transaction underpriced` and `insufficient funds` come from your upstream RPC and
are passed through unchanged.
