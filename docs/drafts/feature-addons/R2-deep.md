# R2 — Deepen top candidates

**Date:** 2026-09-24 (America/New_York)  
**Refines:** [R1-scan.md](./R1-scan.md)  
**Lens:** effort · risk to thin positioning · user pull evidence · Soft WTP / AgentKit fit

---

## Method

For each shortlisted candidate: score **effort (S/M/L)**, **thin-risk (Low/Med/High)**, **P(useful to integrators in 90d)** as a subjective 0–1 given users=0 today, **Soft WTP pull**, and a keep/kill/defer lean. Evidence sources: AgentKit #1512 thread, CDP Policy Engine docs, A3 P2 list, METRICS (users=0), TRACTION_PLAN gaps, residual bypasses in A2/B3.

---

## 1. Eval corpus + offline policy evidence (EV-1, EV-4, EV-5)

| | |
| --- | --- |
| **What** | Extend `evaluation/` with `policy_denied` decision class; generator flags; offline demo script for `-32083`; optional `agent:loop` policy slice |
| **Effort** | **S–M** (fixtures + classify + one script; ~1–2 focused PRs) |
| **Thin-risk** | **Low** — not a product surface change |
| **P(useful 90d)** | **0.75** — every Soft WTP / AF prep / CoS metrics path needs honest Layer 2 evidence; currently corpus is L1-only after v0.3.0 ship |
| **User pull** | Indirect: Cobra’s question is exactly “policy beside sim.” Reproducible deny evidence answers that without another outbound message |
| **AgentKit Soft WTP** | **High fit** — when/if #1512 gets a reply, pointing at offline `-32083` demo + eval report is the non-spam continuation |
| **Deps on keys/hosted** | None |
| **Lean** | **KEEP → P0** |

**Notes:** evaluation README still documents only abort_definite / probable / forward / infra_abort. Adding `policy_denied` is the smallest “continuous improvement” with outsized credibility.

---

## 2. Bypass honesty docs + thin selector denylist (EV-6 + L2-1)

| | |
| --- | --- |
| **What** | (a) README/ARCHITECTURE residual-risk section: `approve` / `setApprovalForAll` / Permit2 / multicall+router. (b) Optional policy `deniedSelectors` / `denyMaxApprovals` when Layer 2 enabled |
| **Effort** | Docs **S**; denylist **S–M** |
| **Thin-risk** | Docs **Low**. Denylist **Med** if marketed as “full approval safety” — must stay best-effort selector match, OFF unless configured |
| **P(useful 90d)** | Docs **0.7**; denylist **0.45** (operators who enable policy will hit approve footguns; many won’t configure selectors) |
| **User pull** | Zodiac docs literally warn “approve is as powerful as transfer.” A2 already flagged this. Agent treasuries care |
| **AgentKit Soft WTP** | Medium — CDP Policy Engine already covers some of this at sign time; our value is self-host + raw-tx path |
| **Deps** | None |
| **Lean** | Docs **KEEP P0**; denylist **KEEP P1** (default empty / off) |

**Must stay OFF-by-default:** denylist empty unless operator lists selectors or sets `denyUnlimitedApprovals: true` under enabled policy.

---

## 3. AgentKit / CDP complement DX (DX-1)

| | |
| --- | --- |
| **What** | `docs/` or `examples/agentkit/` showing: local signer → viem transport via Send Guard → Base/Arb Sepolia; one paragraph contrasting **CDP Policy Engine** (sign/send rules for CDP wallets) vs **Send Guard** (L1 sim + optional L2 for any RPC / local keys) |
| **Effort** | **S** |
| **Thin-risk** | **Low** if framed as complement, not “AgentKit plugin” claim |
| **P(useful 90d)** | **0.55** — only pays off if Soft WTP thread continues or organic AgentKit users find README; still the highest Soft-WTP-specific DX |
| **User pull** | Direct #1512 signal; Cobra + founder already aligned on two-layer language |
| **AgentKit Soft WTP** | **Highest** among product-ish items — enables inbound without bumping the issue |
| **Deps** | None (example-only; no AgentKit dependency in package.json) |
| **Lean** | **KEEP → P0** |

**Anti-pattern:** opening new AgentKit issues, DMs, or “please integrate us” PRs. Example stays in *our* repo.

---

## 4. Decision counters + health policy fields (EV-2, DX-7)

| | |
| --- | --- |
| **What** | In-process counters: `abort`, `fail_open`, `forward`, `policy_denied`, `sim_uncertain`; expose on `GET /health` or `GET /metrics` (JSON, no Prometheus required). Health already lists chains — add `policy: { enabled, destinationCount }` (no addresses). |
| **Effort** | **S** |
| **Thin-risk** | **Low** |
| **P(useful 90d)** | **0.6** — makes METRICS.md honest without inventing users; ops for self-hosters |
| **User pull** | Weak external signal; strong internal CoS need (users=0 but sims should be countable when demos run) |
| **AgentKit Soft WTP** | Low direct; supports evidence pack |
| **Deps** | None |
| **Lean** | **KEEP → P0** |

---

## 5. Gas-saved estimate on definite abort (L1-1)

| | |
| --- | --- |
| **What** | On `-32080`, include advisory `estimatedGasSavedWei` from sim gasUsed × tx gas params (or estimate) |
| **Effort** | **S** |
| **Thin-risk** | **Low** if clearly advisory (not a guarantee) |
| **P(useful 90d)** | **0.35** — nice demo UX; OP Sec Proxy markets this; does not unblock integrators |
| **User pull** | Competitive parity optics only |
| **AgentKit Soft WTP** | Low |
| **Lean** | **KEEP → P1** (polish, not wedge) |

---

## 6. Hot-reload policy file (L2-2)

| | |
| --- | --- |
| **What** | Reload `L2SG_POLICY_FILE` on SIGHUP or periodic mtime check; atomic swap of in-memory policy |
| **Effort** | **M** (races with in-flight requests; validation on reload; refuse bad file keep-old) |
| **Thin-risk** | **Low–Med** — ops feature, not Safe clone; still careful with partial loads |
| **P(useful 90d)** | **0.4** — agents that iterate allowlists hate restarts; early users may just restart |
| **User pull** | A3 P2; no external ask yet |
| **AgentKit Soft WTP** | Low |
| **Lean** | **DEFER → P1** |

---

## 7. Per-token ERC20 amount caps (L2-4)

| | |
| --- | --- |
| **What** | Use already-decoded ERC20 `amount` against per-token or global token caps (decimals-aware config) |
| **Effort** | **M** (config shape, decimals source of truth, tests) |
| **Thin-risk** | **Med** — starts looking like a token policy engine; wrong decimals = false safety |
| **P(useful 90d)** | **0.4** — real bypass today: allowlisted token contract + huge transfer to allowlisted recipient under native cap 0 |
| **User pull** | Implicit from A2 failure modes; AgentKit moves ERC20 often |
| **AgentKit Soft WTP** | Medium |
| **Lean** | **DEFER → P1** with strict OFF-by-default and wei/smallest-unit only (no auto decimals fetch) |

**Prefer:** caps in **raw token units** (string integer), operator supplies decimals knowledge — no on-chain decimals() call in middleware (latency + fail-open confusion).

---

## 8. eRPC compose sample + reopen GFIs (DX-2, DX-4)

| | |
| --- | --- |
| **What** | `docker-compose.erpc.yml` or docs snippet: client → Send Guard → eRPC → Alchemy/public. File 2–3 good first issues (policy offline demo docs; health policy field; Panic fixture leftover). |
| **Effort** | **S** |
| **Thin-risk** | **Low** |
| **P(useful 90d)** | **0.5** for GFIs (TRACTION_PLAN); **0.3** for eRPC compose alone |
| **User pull** | TRACTION_PLAN explicit weekly gap (0 open issues) |
| **AgentKit Soft WTP** | None direct; discoverability |
| **Lean** | **KEEP → P0** (GFIs especially) |

---

## 9. Sim timeout / budget (L1-6)

| | |
| --- | --- |
| **What** | `L2SG_SIM_TIMEOUT_MS`; on timeout → uncertain → fail-open (open) / abort (strict) |
| **Effort** | **S** |
| **Thin-risk** | **Low** — reinforces ethics of fail-open |
| **P(useful 90d)** | **0.45** — public RPCs hang; agents need bounded latency |
| **Lean** | **KEEP → P1** |

---

## 10. From-address allowlist (L2-6)

| | |
| --- | --- |
| **What** | When policy enabled, optional `allowedFrom` set; recover `from` already done in parse |
| **Effort** | **S** |
| **Thin-risk** | **Low** |
| **P(useful 90d)** | **0.35** — multi-agent fleets sharing one proxy |
| **Lean** | **DEFER → P1** |

---

## 11. Rolling daily caps (L2-3) — deepen-to-kill

| | |
| --- | --- |
| **Effort** | **L** (durable state, clock, multi-instance) |
| **Thin-risk** | **High** — Zodiac/Safe territory; process memory lies under restart |
| **P(useful 90d)** | **0.2** without hosted tier |
| **Lean** | **KILL / out of wedge** (document as known limit) |

---

## 12. Multicall / router unwind (L2-5) — deepen-to-kill

| | |
| --- | --- |
| **Effort** | **L** |
| **Thin-risk** | **High** — false confidence if partial decode |
| **P(useful 90d)** | **0.15** |
| **Lean** | **KILL** — docs warn: allowlisting a router ≠ destination safety |

---

## 13. Optional local revm (L1-4)

| | |
| --- | --- |
| **Effort** | **L** |
| **Thin-risk** | **Med–High** (native deps, OP vs Arb divergence) |
| **P(useful 90d)** | **0.2** |
| **Lean** | **KILL for 90d** — keep ARCHITECTURE M2 note only |

---

## 14. External tx screening embed (Blockaid/GoPlus)

| | |
| --- | --- |
| **Effort** | **M** |
| **Thin-risk** | **High** — hosted SaaS dependency; changes trust model |
| **P(useful 90d)** | **0.15** |
| **Lean** | **KILL** as product feature. Extreme defer: generic `preflightWebhook` already partially covered by `humanGate.notifyUrl` pattern — do not specialize to threat vendors |

---

## 15. Soft WTP strategy (explicit, no outreach)

| Lever | Effect | Constraint |
| --- | --- | --- |
| In-repo AgentKit example + CDP complement paragraph | Raises reply quality if they return | No outbound |
| Policy eval evidence + Layer 2 offline demo | Answers Cobra with artifacts | No bump on #1512 |
| Founder-only technical reply *after* their next comment | Natural thread hygiene | Human gate |
| GFIs + README SEO for “agent eth_sendRawTransaction fail-open” | Organic discovery | TRACTION_PLAN |
| Do not send Soft WTP 3–5 until CoS refresh | Avoid spray | Already hold |

**What would make Soft WTP / AgentKit hook more likely without cold outreach spam?**  
Ship the **complement DX + Layer 2 evidence pack** so any AgentKit maintainer (or reader of #1512) can verify the two-layer answer in <10 minutes, then rely on **inbound** or a **single founder reply to their reply** — never new cold surfaces.

---

## Cross-cut: continuous improvements (non-features) ranked by leverage

1. Eval `policy_denied` + offline policy demo  
2. Residual bypass docs  
3. Reopen ≥2 GFIs  
4. `/health` policy summary + decision counters  
5. SDK README Layer 2 + error helper types  
6. Confirm empty-allowlist startup refuse + test  
7. METRICS row after Layer 2 merge week  

---

## Carry to R3

**P0 pool (max 5):** EV-1/4/5 evidence · DX-1 AgentKit example · EV-2/DX-7 counters+health · DX-4 GFIs · EV-6 bypass docs  

**P1 pool:** L2-1 selector denylist · L2-2 hot-reload · L2-4 ERC20 amount caps · L1-1 gas-saved · L1-6 sim timeout · L2-6 from-allowlist · DX-2 eRPC compose · DX-3 typed errors  

**Kill:** rolling caps · multicall unwind · revm-now · Blockaid default · Flashbots product · Safe/7579 · SaaS · Soft WTP bump · custody  

