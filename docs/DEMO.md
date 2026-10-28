# Offline demo walkthrough (Layer 1 + Layer 2)

`l2-send-guard` checks every signed transaction in two stages:

- **Layer 1 — simulation.** Each transaction is simulated with `eth_simulateV1` (with EIP-7702 code overrides), falling back to `eth_call`. A *definite* revert is refused with `-32080`. If simulation cannot decide, `GUARD_MODE` decides: `strict` (the default) refuses, `open` forwards.
- **Layer 2 — policy.** Destination, selector, token-transfer, approval, Permit2 and EIP-7702 rules from your policy file are applied before simulation. A policy denial is refused with `-32083`; `data.policyCode` says why and `data.path` says where.

Both stages run **offline — no keys, no network, no funds** in the bundled demo:

```bash
git clone https://github.com/yellowgram/l2-safety-proxy.git && cd l2-safety-proxy
npm ci && npm run demo
```

> On 0.x and 1.x the same walkthrough shipped as `npm run demo:dual-layer` and `docs/INBOUND_DEMO.md`.
> Since 1.0.0 those were folded into `npm run demo` (see [CHANGELOG](../CHANGELOG.md)). If you followed an
> older link, this page is its replacement.

The demo prints one line per case. Two of them exercise the two layers:

```text
2. 0.05 ETH to an address not in the policy      -32083 DESTINATION_NOT_ALLOWED — 0x2222… is not an allowed destination (at tx)
4. a call that would revert                      -32080 DEFINITE_REVERT — Not enough balance
```

`-32083` is a **Layer 2 policy deny** (refused before it is sent). `-32080` is a **Layer 1 simulation abort**
(simulation says it would revert). The forwarded cases print `forwarded, hash 0xabababab…`; a deny is never
"fail-open" — see [README › How it works](../README.md#how-it-works).

## Turning Layer 2 on and off

- Layer 2 is on whenever a policy file is loaded: `L2SG_POLICY_FILE=./policy.json`.
- `L2SG_POLICY=off` runs **simulation only** (Layer 1) and prints a warning; no policy is loaded.
- Start from [`policy.example.json`](../policy.example.json) (one payee, ETH plus one stablecoin) or
  [`policy.agent.example.json`](../policy.agent.example.json) (contracts with selector lists, Permit2 and 7702 delegation).

A deny is never a fail-open: when the policy refuses, the transaction is not forwarded. `GUARD_MODE=open`
only forwards a transaction that has already passed every policy check, and only when simulation cannot decide.

## What Layer 2 does not cover

Layer 2 judges the calldata it decodes; it is not a full contract auditor. Approvals, Permit2 and batch
wrappers (Multicall3, Safe `multiSend`, Universal Router) are checked call by call, but read
[README › Threat model and limits](../README.md#threat-model-and-limits) for the residual gaps (off-chain
signatures are only checked through the guarded signer, swap prices are not checked, and so on).
