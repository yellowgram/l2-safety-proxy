# Troubleshooting

Short runbook for the failures that are actually Guard's. Nonce, underpriced, and replacement-underpriced are **client or upstream** fee/nonce problems. Guard does not allocate nonces.

## 1. Upstream RPC flaky or missing `eth_simulateV1`

**Symptom:** `decision: fail_open` with `confidence: unknown` or `eth_call`, or strict mode returns `-32082`.

**What happened:** The proxy prefers `eth_simulateV1`, caches a negative result when the upstream rejects it, and falls back to `eth_call`. If both are uncertain and `GUARD_MODE=open`, the raw tx is **forwarded**. That is not a policy decision.

**Check:** `GET /health` for `guardMode`. Set a per-chain `L2SG_RPC_FALLBACK_<CHAIN>` used only for simulation. Sends still forward to `L2SG_RPC_<CHAIN>`.

Public testnet RPC weather is your upstream, not a Guard bug. CI does not call public Sepolia.

## 2. Layer 2 looks off

**Symptom:** spends you expected to stop are forwarded; `GET /health` shows `policy.enabled: false`.

**What happened:** Layer 2 defaults **off** (Human/ops path). A missing file does **not** silently disable an enabled policy — the process refuses to start. If the process is up and `policy.enabled` is false, the flag or file said off.

**Check:** `policy.enabled`, `destinationCount` (count only, not the list), `notifyConfigured`. Agent path needs `L2SG_POLICY_ENABLED=true` and `L2SG_POLICY_FILE` pointing at a file that passed `npm run policy:check -- ./policy.json`.

## 3. Chain header vs signed chainId

**Symptom:** `-32084` `decision: chain_mismatch`, or a send landed on the wrong upstream before you upgraded.

**What happened:** `x-l2sg-chain` (name or numeric id) selects the chain. If the signed tx has a `chainId` and it disagrees, the proxy stops. It does not simulate and does not forward. Legacy txs with no `chainId` are not compared.

**Check:** the header, the wallet's chain, and `error.data.chainId` vs `error.data.signedChainId`. Fix the header or re-sign. Do not retry the same raw against the other chain.

## 4. Policy JSON invalid

**Symptom:** process exits at start, or `npm run policy:check -- ./policy.json` exits 1.

**What happened:** Policy files are JSON. Comments (`//`) are invalid. Placeholder addresses `0x1111…` / `0x2222…` (any repeated non-zero nibble) fail `policy:check` and, when policy is enabled, refuse start. `allowAnyDestination: true` fails `policy:check`.

**Check:** `npm run policy:check -- ./policy.json` until it prints `policy:check OK`.

## 5. `GUARD_MODE` vs `L2SG_FAIL_OPEN`

**Symptom:** uncertain sims abort, or the opposite of what you set.

**What happened:** `GUARD_MODE=open|strict` wins. `L2SG_GUARD_MODE` is an alias. `L2SG_FAIL_OPEN` applies only when `GUARD_MODE` is unset (`false` → strict). The alias stays through 0.6.0.

Layer 2 denials are `-32083` in both modes. `GUARD_MODE` does not fail-open a policy deny.

## Not a Guard bug

| Symptom | Owner |
| --- | --- |
| nonce too low / too high, replacement underpriced, intrinsic gas | The signing client and the upstream |
| Faucet or balance | Your burner |
| Key management | Your signer. Guard returns `-32081` for `eth_sendTransaction` |
| Approve / Permit2 / multicall drain of an allowlisted router | Your tool inventory. See [RESIDUAL_BYPASSES.md](./RESIDUAL_BYPASSES.md) |
