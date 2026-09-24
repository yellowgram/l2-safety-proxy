# B3 — Locked design (L2 ops / middleware consolidation)

**Status:** LOCKED for Phase C implementation  
**Date:** 2026-09-24  
**Personas consolidated:** wallet middleware (B1) + agent security (B2) + L2 ops

---

## What Layer 2 is

- Optional, config-driven **address / spend policy** beside Layer 1 simulation.
- Answers: *should this destination receive funds / be called under local policy?*
- Within policy → continue to Layer 1 sim → auto forward if sim ok.
- Outside policy → **STOP** (`-32083` `policy_denied`); do not forward; do not fail-open.
- Operator keeps keys; middleware never custodies.

## What Layer 2 is not

- Not a Safe / enterprise policy engine, not ERC-7579 session keys, not on-chain enforcement.
- Not a replacement for agent intent validation or Tenderly.
- Not rolling daily limits, drip detection, or token-amount accounting (native wei caps only).
- Not key custody, SaaS, or a blocking human approval server.
- Not a change to Layer 1 fail-open semantics for **simulation uncertainty**.

---

## Locked request flow

```
Wallet / bot / agent
        │  eth_sendRawTransaction
        ▼
┌─────────────────────────────────────┐
│  L2 Send Guard                      │
│  1. select chain                    │
│  2. parse signed raw (no keys)      │
│  3. Layer 2 policy (if enabled)     │
│     ├ deny → -32083 STOP            │
│     └ allow → continue              │
│  4. Layer 1 simulate                │
│     ├ definite revert → -32080      │
│     ├ success → forward             │
│     └ uncertain → fail-open|strict  │
└───────────────┬─────────────────────┘
                ▼
        upstream RPC
```

**Order rationale:** policy is local/deterministic; skip sim on deny (cost + intent hygiene).

---

## Error codes (locked)

| Code | Name | Layer |
| --- | --- | --- |
| -32080 | definite revert | 1 |
| -32081 | unsigned refused | custody |
| -32082 | strict uncertain | 1 |
| **-32083** | **policy_denied** | **2** |

`GuardDecision` adds `"policy_denied"`.

---

## Config (locked)

**Default:** Layer 2 **OFF** (`enabled: false` / env unset).

**Enable:** `L2SG_POLICY_ENABLED=true` and/or policy JSON `"enabled": true`.

**Sources (merge):** JSON file (`L2SG_POLICY_FILE`) + env overrides.

**Fields:**

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | false | |
| `allowContractCreation` | false | |
| `allowAnyDestination` | false | empty destinations ⇒ deny-all |
| `globalMaxNativeWei` | unset | string wei; XOR `globalMaxNativeEth` at load |
| `destinations` | {} | checksummed/lowercased keys; optional `maxNativeWei`, `requireApproval` |
| `chains` | {} | optional per-chain overlay |
| `erc20RecipientCheck` | true | transfer/transferFrom recipient allowlist |
| `humanGate.mode` | `stop` | only stop |
| `humanGate.notifyUrl` | null | fire-and-forget POST |

**Env shortcuts:** `L2SG_POLICY_ALLOWLIST`, `L2SG_POLICY_GLOBAL_MAX_WEI`, `L2SG_POLICY_ALLOW_CREATE`, `L2SG_POLICY_ALLOW_ANY`, `L2SG_POLICY_NOTIFY_URL`, `L2SG_POLICY_ERC20_RECIPIENT_CHECK`.

---

## Evaluation rules (locked)

1. Disabled → allow.  
2. No `to` → deny `CONTRACT_CREATE_DENIED` unless `allowContractCreation`.  
3. If `erc20RecipientCheck` and data is ERC20 transfer/transferFrom → `effectiveTo = recipient`. Else `effectiveTo = to`.  
4. If destination entry `requireApproval` → deny `NEEDS_APPROVAL`.  
5. If `!allowAnyDestination` and `effectiveTo` not in map → deny `DESTINATION_NOT_ALLOWLISTED`.  
6. Native `tx.value` vs `globalMaxNativeWei` and per-dest `maxNativeWei` → deny `OVER_CAP` if exceeded.  
7. Else allow.  
8. On deny: `void notify()` if URL set; return `-32083`.

**No ERC20 amount caps. No rolling aggregates. No blocking wait.**

---

## Module layout (locked)

```
src/policy/types.ts
src/policy/load.ts
src/policy/evaluate.ts
src/policy/erc20.ts
src/policy/notify.ts
src/policy/index.ts
```

`GuardConfig.policy: SpendPolicyConfig` always present (`enabled: false` by default).

---

## Tests (locked acceptance)

See B1 list + B2 rules: policy deny ≠ fail_open; simulate not called on deny; ERC20 recipient path; deny-all empty; multi-chain overlay optional test.

---

## Docs updates (locked)

- ARCHITECTURE.md: Layer 1 / Layer 2 sections + flow diagram + What it is/not.  
- README.md: short Layer 2 table; default off.  
- SOFT_WTP.md: one paragraph — optional policy beside sim; still no outreach expansion.  
- .env.example: policy vars.  
- DEMO/SEND_LOG: note only if needed (policy offline tests suffice).

---

## Implementation checklist (Phase C)

- [ ] types + ERR_POLICY_DENIED  
- [ ] policy module  
- [ ] env/load wiring  
- [ ] handler order  
- [ ] tests  
- [ ] docs  
- [ ] npm test green  
- [ ] branch `feat/layer2-spend-policy` + PR
