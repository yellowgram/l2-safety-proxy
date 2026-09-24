# A3 — Research synthesis + ranked backlog

**Consolidates:** A1 + A2  
**Date:** 2026-09-24  
**Product cut locked:** Layer 1 sim (fail-open uncertain) + Layer 2 address/spend policy (definite stop) beside it.

---

## Synthesis (one paragraph)

L2 Send Guard today is a solid Layer-1 send middleware: simulate raw txs, abort definite reverts, fail-open when uncertain, no custody. Peers (OP Security Proxy, Tenderly) either validate the sim niche or overshoot into heavy DevOps; Safe/7579 own on-chain policy but are the wrong product shape for an EOA/agent raw-tx proxy. AgentKit #1512 explicitly separated the missing question — *should this address get money at all?* — which is Layer 2: config-driven allowlist + per-tx caps + optional human-gate notify/STOP, default off, error `-32083`, ordered **parse → policy → sim → forward**. Stay thin; do not become Safe.

---

## Ranked improvement backlog

### P0 — must ship this pipeline

| ID | Item | Why |
| --- | --- | --- |
| P0-1 | **Layer 2 policy module** (allowlist, global + per-dest native caps, create deny, `-32083`) | External signal + product cut |
| P0-2 | **Config: default OFF**; enable via `L2SG_POLICY_ENABLED` + JSON file and/or env allowlist | Don’t break existing fail-open users |
| P0-3 | **Handler order: parse → policy → sim → forward** | Skip sim on deny; clear semantics |
| P0-4 | **Distinct meta** `decision: policy_denied`, never fail-open on policy | Prevent UX conflation |
| P0-5 | **Tests** allow / deny / over-cap / disabled / GUARD_MODE interaction | Gate for PR |
| P0-6 | **Docs** ARCHITECTURE + README What it is/not for Layer 2; SOFT_WTP one-liner | Honest scope |

### P1 — hardening in scope (implement if cheap after P0)

| ID | Item | Why |
| --- | --- | --- |
| P1-1 | Best-effort ERC20 `transfer` / `transferFrom` decode for recipient + amount vs caps | Closes major bypass |
| P1-2 | Optional `humanGate.notifyUrl` POST on deny (fire-and-forget) | Cobra “wait on you” without blocking |
| P1-3 | Address normalize via `getAddress` + case-insensitive map | Footgun fix |
| P1-4 | Startup refuse if `enabled` and empty allowlist without `allowAnyDestination` | Config footgun |
| P1-5 | Policy fields in abort `data` (`policyCode`, `to`, `valueWei`) | Agent UX |

### P2 — later (document, don’t build now)

| ID | Item |
| --- | --- |
| P2-1 | Rolling daily/aggregate caps + drip detection |
| P2-2 | Hot-reload policy file |
| P2-3 | Selector denylist (approve max, setApprovalForAll) |
| P2-4 | Per-token ERC20 allowlists / decimals-aware caps |
| P2-5 | Multicall / router unwinding |
| P2-6 | Layer 1: local revm optional engine (already M2 note) |
| P2-7 | Rate-limit / DoS on sim (hosted tier) |

### Layer 1 hardening still in scope (non-blocking)

| ID | Item | Priority |
| --- | --- | --- |
| L1-a | Ensure policy path doesn’t weaken fail-open tests | P0 (regression) |
| L1-b | Document that strict mode ≠ policy | P0 docs |
| L1-c | Confidence UX already good — no change required | KEEP |

---

## Success criteria for Phases B–C

1. With policy disabled: all existing tests green; behavior identical.  
2. With policy enabled: unknown destination → `-32083`, no forward, no sim call.  
3. Allowlisted under cap → proceeds to sim → existing Layer 1 rules.  
4. Over-cap → `-32083` even if destination allowlisted.  
5. README/ARCHITECTURE clear two-layer model; no Safe-enterprise claims.  
6. No private keys in repo; no mainnet funds.

---

## Non-goals (locked)

- Key custody, SaaS, Soft WTP outreach expansion  
- Safe Policy Engine / ERC-7579 session modules  
- Claiming Layer 2 replaces agent intent validation or on-chain guards
