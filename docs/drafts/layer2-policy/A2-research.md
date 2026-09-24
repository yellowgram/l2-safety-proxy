# A2 — Deep research (iteration 2): failure modes, diffs, KEEP/KILL/CHANGE

**Refines:** A1-research.md  
**Date:** 2026-09-24

---

## 1. Failure modes for a thin policy layer

| Failure / bypass | Severity | Mitigation (thin Layer 2) |
| --- | --- | --- |
| Operator confuses policy deny with sim fail-open | High UX | Distinct code `-32083`, `decision: "policy_denied"`, never `fail_open` |
| Policy off → agents overclaim “protected” | High | Docs + response meta `policy.enabled: false`; README What it is / is not |
| Allowlist case / checksum mismatch | Medium | Normalize with viem `getAddress` (checksum) + compare lowercase |
| Contract creation (`to` empty) drains via init code | Medium | Default: deny create when policy enabled unless `allowContractCreation: true` |
| ERC20 `transfer` to evil addr while `to` is token contract (allowlisted) | High if we only check `tx.to` | v1: optional ERC20 decode for `transfer(address,uint256)` / `transferFrom`; if undecodable calldata with value=0 and unknown selector → treat as **interaction with `to`** under allowlist of contract, not destination of funds — document limit |
| Native value=0 but approval/unlimited approve | High | Out of scope for thin v1 OR optional selector denylist for `approve` with max uint — prefer document “approve not covered” rather than half-implement |
| Cap bypass via many sub-cap txs | Medium | Single-tx caps only in v1; document drip as known limit (no rolling counters — avoids state/custody creep) |
| Cap in wrong units (ETH vs wei) | High footgun | Config: integer **wei** strings; optional human `maxNativeEth` parsed once at load |
| Multi-chain: allowlist on wrong chain | Medium | Policy file keyed by chain id / chain key; apply only matching chain |
| Human-gate never returns → hung sends | Medium | v1: **STOP + reason `needs_approval`**; hook is optional async notifier, not blocking wait (operator re-submits after updating allowlist) |
| Policy check after sim wastes RPC / leaks intent to sim node | Low–Med | **Order: policy before sim** |
| Strict mode + policy: double abort paths confusing | Low | Policy runs first; sim/strict unchanged |
| Malicious policy file path / symlink | Low | Load only from env path; fail closed if file unreadable when policy explicitly enabled |
| Empty allowlist with policy enabled | High footgun | If `enabled` and allowlist empty → deny-all (safe) OR refuse to start — prefer **refuse to start** with clear error when `enabled` and no destinations and no `allowAnyDestination` |
| `allowAnyDestination: true` + only global cap | OK | Supported: open destinations, still enforce global max native value |

---

## 2. Competitor diffs (what to copy vs avoid)

| Idea | Source | KEEP / KILL / CHANGE |
| --- | --- | --- |
| Fail-open on sim uncertainty | OP Sec Proxy + our L1 | **KEEP** Layer 1 |
| Deny-by-default when policy on | Safe Policy Engine | **KEEP** semantics when enabled; **KILL** on-chain modular engine |
| Session keys / 7579 modules | Smart Sessions | **KILL** for this package (wrong custody/account model) |
| Merchant MCC / HNP spend simulators | AINumbers etc. | **KILL** (cross-domain / SaaS) |
| Action-level transfer guards in agent | AgentKit PRs | **CHANGE** → middleware policy so any agent pointing RPC benefits |
| Destination allowlist before broadcast | Wallet firewalls | **KEEP** as core Layer 2 |
| Daily aggregate / drip detection | Spend-policy sims | **KILL** for v1 (stateful); document as P2 |
| Human cosigner / multi-sig gate | Safe | **CHANGE** → optional notify hook + STOP; operator edits config / re-signs |

---

## 3. JSON-RPC error UX

| Code | Meaning | Forward? | Certainty |
| --- | --- | --- | --- |
| `-32080` | Definite sim revert | No | definite (sim) |
| `-32081` | Unsigned send refused | No | n/a |
| `-32082` | Strict uncertain | No | uncertain |
| **`-32083`** | **Policy denied** | **No** | **definite (policy)** — not fail-open |

Error `data` shape (aligned with existing meta):

```json
{
  "l2SendGuard": true,
  "decision": "policy_denied",
  "layer": 2,
  "policyCode": "DESTINATION_NOT_ALLOWLISTED" | "OVER_CAP" | "CONTRACT_CREATE_DENIED" | "NEEDS_APPROVAL",
  "to": "0x...",
  "value": "0x...",
  "chainId": 421614,
  "hint": "Add destination to policy or raise cap; operator keeps keys."
}
```

Do **not** reuse `certainty: uncertain` for policy denies.

---

## 4. Config surface (draft for B)

**Enable:** `L2SG_POLICY_ENABLED=true` **or** presence of `L2SG_POLICY_FILE=./policy.json` with `"enabled": true`. Default: disabled.

**Minimal JSON:**

```json
{
  "enabled": true,
  "allowContractCreation": false,
  "globalMaxNativeWei": "100000000000000000",
  "destinations": {
    "0xabc...": { "maxNativeWei": "50000000000000000" },
    "0xdef...": {}
  },
  "humanGate": {
    "mode": "stop",
    "notifyUrl": null
  }
}
```

Env-only thin mode (optional):

- `L2SG_POLICY_ALLOWLIST=0xabc,0xdef`
- `L2SG_POLICY_GLOBAL_MAX_WEI=...`
- `L2SG_POLICY_ENABLED=true`

**YAML:** optional if we add a tiny parser; prefer JSON-only for KISS (no new deps) — **CHANGE from “JSON/YAML” aspiration → JSON + env**.

---

## 5. Attack / bypass paths (summary)

1. **Calldata destination ≠ `tx.to`** — ERC20 transfer. Mitigate with optional transfer decode; document residual.  
2. **Approve / permit / setApprovalForAll** — document out of scope v1.  
3. **Delegatecall / multicall wrappers** — out of scope; allowlisting the wrapper ≠ safe. Docs warn: allowlist final fund destinations when possible.  
4. **Policy disabled** — expected; Layer 1 only.  
5. **Race: update allowlist while in-flight** — process loads config at start; hot-reload out of scope v1 (restart to apply).

---

## 6. KEEP / KILL / CHANGE (package-level)

### KEEP
- Layer 1 fail-open / definite-only sim semantics  
- No key custody / refuse `eth_sendTransaction`  
- Multi-L2 chain templates + `x-l2sg-chain`  
- Error code family `-3208x` with rich `data`  
- Default behavior unchanged when policy absent  
- KISS TypeScript + viem  

### KILL (for this cut)
- Safe/7579 policy engine clone  
- Rolling daily/monthly aggregates / drip detection  
- Blocking human-in-the-loop wait (deadlock risk)  
- Hosted SaaS policy SaaS  
- Soft WTP outreach expansion (docs language only)  
- New npm deps for YAML if avoidable  

### CHANGE
- Handler flow: insert policy after parse, before sim  
- Types: new decision `policy_denied`, error `-32083`  
- Config loader: optional policy file + env  
- Docs: two-layer model; SOFT_WTP one paragraph that Layer 2 is optional policy beside sim  
- Tests: allow / deny / over-cap / disabled / GUARD_MODE interaction  
- ERC20: best-effort `transfer`/`transferFrom` amount+recipient decode when selector matches; else native-only  

---

## 7. Answers to A1 open questions

| Q | Decision (A2) |
| --- | --- |
| Cap aggregation | **Single-tx only** for v1 |
| Contract creation | Deny when policy on unless flag |
| ERC20 | Best-effort transfer decode; document limits |
| Human-gate | STOP + optional notify URL; no blocking wait |
| GUARD_MODE | Independent; policy always fail-closed when enabled |
