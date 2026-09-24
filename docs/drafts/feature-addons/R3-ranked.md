# R3 — Ranked backlog (feature add-ons + continuous improvements)

**Date:** 2026-09-24 (America/New_York)  
**Consolidates:** [R1-scan.md](./R1-scan.md) + [R2-deep.md](./R2-deep.md)  
**Package:** `l2-send-guard` v0.3.0 (Layer 2 spend policy merged)  
**Rule:** research/docs only in this study — no implementation in this PR beyond these drafts

---

## Ranking columns

`name | layer | why | effort | P(useful 90d) | keep/kill/defer | dependency on keys/hosted | notes`

---

## P0 next (do soon if founder greenlights) — max 5

| name | layer | why | effort | P(useful 90d) | keep/kill/defer | dependency on keys/hosted | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Eval + offline Layer 2 evidence** (`policy_denied` corpus class, generator, offline `-32083` demo, agent-loop policy slice) | evidence | Layer 2 shipped but eval/agent corpus still L1-only; Soft WTP #1512 needs reproducible answer to Cobra | S–M | 0.75 | **keep** | none | Highest credibility per hour; updates evaluation README decision classes |
| **Bypass honesty docs** (approve / setApprovalForAll / Permit2 / multicall residual) | evidence | Prevents false confidence after allowlist ship; Zodiac + A2 already warn | S | 0.70 | **keep** | none | README + ARCHITECTURE “What Layer 2 is not”; not a code feature |
| **AgentKit / CDP complement example** (in-repo transport tip + “CDP Policy Engine vs Send Guard” paragraph) | DX | Soft WTP pull without cold outreach; CDP now has sign-time allowlist/`ethValue` — we must differentiate L1 sim + self-host | S | 0.55 | **keep** | none | Example-only; **no** AgentKit dependency; **no** bump on #1512 |
| **Decision counters + health policy summary** | evidence / DX | METRICS today is manual; ops need abort/fail_open/forward/policy_denied counts; health shows `policy.enabled` + dest count (no addresses) | S | 0.60 | **keep** | none | JSON `/health` or `/metrics`; feeds CoS without inventing users |
| **Re-open ≥2 good first issues** | DX | TRACTION_PLAN weekly gap (0 open issues after GFI closures) | S | 0.50 | **keep** | none | Themes: policy offline demo docs; health policy fields; Panic fixtures; Guard+eRPC compose note. Human/founder files issues — study does not post |

---

## P1 later — max 8

| name | layer | why | effort | P(useful 90d) | keep/kill/defer | dependency on keys/hosted | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Selector denylist** (approve max / setApprovalForAll / optional Permit2 selectors) | L2 policy | Closes major residual when policy ON; A3 P2-3 | S–M | 0.45 | **keep** (defer implement) | none | **OFF-by-default** empty list; only active when policy enabled + configured |
| **Sim timeout budget** (`L2SG_SIM_TIMEOUT_MS` → uncertain) | L1 harden | Public RPC hangs; preserves fail-open ethics | S | 0.45 | **keep** | none | Timeout = uncertain, not policy deny |
| **Hot-reload policy file** (SIGHUP / mtime) | L2 policy | Ops DX for iterating allowlists; A3 P2-2 | M | 0.40 | **defer** | none | Keep-old on bad reload; document restart still fine |
| **Per-token ERC20 amount caps** (raw units) | L2 policy | Amount already decoded; native-only caps leave ERC20 hole | M | 0.40 | **defer** | none | **No** on-chain `decimals()`; raw integer strings; OFF unless configured |
| **Gas-saved estimate meta** on `-32080` | L1 harden | OP Sec Proxy parity; demo UX | S | 0.35 | **keep** | none | Advisory only; never claim exact savings |
| **From-address allowlist** | L2 policy | Multi-agent fleets sharing one proxy | S | 0.35 | **defer** | none | OFF = no from filter; recover `from` already exists |
| **eRPC compose sample** | DX | Complementary story already in ARCHITECTURE | S | 0.30 | **keep** | none | Do not rebuild failover |
| **SDK typed error helpers** (`-32080/-32082/-32083`) | DX | Integrator DX; SDK README still L1-skewed | S | 0.40 | **keep** | none | Map JSON-RPC errors → typed results for viem/ethers |

---

## Kill / out of wedge — explicit

| name | layer | why | effort | P(useful 90d) | keep/kill/defer | dependency on keys/hosted | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Rolling daily / aggregate caps + drip detection** | non-goal | Stateful Safe/Zodiac territory; lies across restart/multi-instance | L | 0.20 | **kill** | would push hosted state | Document as known limit |
| **Multicall / router calldata unwind** | non-goal | High false-confidence; L effort | L | 0.15 | **kill** | none | Docs: allowlisting router ≠ destination safety |
| **Optional local revm engine (now)** | non-goal | Native/deps; Arb vs OP divergence; ARCHITECTURE already parks as M2 | L | 0.20 | **kill** (90d) | none | Revisit only if upstream sim untenable |
| **Blockaid / Blowfish / GoPlus default embed** | non-goal | Hosted threat-intel changes trust model; not thin middleware | M | 0.15 | **kill** | **hosted API keys** | Integrators can run their own pre-sign screen |
| **Flashbots Protect / private submit product** | non-goal | MEV/privacy ≠ definite-revert abort | L | 0.05 | **kill** | relay/hosted | Explicit NON-overlap in ARCHITECTURE vs table |
| **Safe / Zodiac / ERC-7579 session-key clone** | non-goal | Wrong layer; product rail | L | 0.05 | **kill** | often custody/smart-account | Complement Soft WTP Safe thread only |
| **Hosted SaaS + billing + sim rate-limit tier** | non-goal | Soft WTP gate unmet (users/teams=0) | L | 0.10 | **kill** (until gate) | **hosted** | AF_TRACTION_PREP stays prep-only |
| **Key custody / unlock `eth_sendTransaction`** | non-goal | Product rail | — | 0 | **kill** | **keys** | Keep `-32081` |
| **Soft WTP bump / new cold issues on AgentKit·Safe·…** | non-goal | Freeze; 3–5 hold; spam risk | S | — | **kill** | none | Wait for reply; founder-gated only |
| **Blocking human-approval wait server** | non-goal | Deadlock; killed in B3 | M | 0.10 | **kill** | often hosted | Keep fire-and-forget `notifyUrl` only |
| **Replace CDP Policy Engine** | non-goal | Overlap for CDP wallets; we complement | — | — | **kill** | CDP hosted | Position: L1 sim + self-host + local-sign |

---

## Explicit answers

### 1. Continuous improvements that are NOT new features?

Yes — and they dominate P0:

- **Test / eval gaps:** `policy_denied` fixtures; confirm empty-allowlist startup refuse; agent-loop policy path.  
- **Docs:** residual bypass honesty; SDK README Layer 2; CDP complement positioning; Soft WTP language already updated — keep non-expansion.  
- **Error UX:** consistent `policyCode` / `hint` / `layer: 2` on `-32083` (verify vs A2 draft).  
- **Observability:** decision counters; health policy summary; METRICS row for Layer 2 merge week.  
- **Traction hygiene:** reopen GFIs; DEMO/SMOKE offline policy row; no outreach.

### 2. What would make Soft WTP / AgentKit hook more likely without cold outreach spam?

1. In-repo **AgentKit transport example** + honest **CDP Policy Engine complement** blurb.  
2. **Reproducible Layer 2 evidence** (offline `-32083` + eval class) answering Cobra’s “should this address get money?”  
3. Rely on **inbound** + at most **one founder technical reply after they reply** (link PR #6 / demos) — never bump, never Soft WTP 3–5 spray.  
4. README SEO / GFIs so AgentKit-adjacent builders find the repo organically.

### 3. What must stay OFF-by-default if added?

| Add-on | Default |
| --- | --- |
| Layer 2 policy (already) | **OFF** |
| Selector denylist / unlimited-approve guards | **OFF** (empty) |
| Per-token ERC20 amount caps | **OFF** |
| From-address allowlist | **OFF** |
| Hot-reload | Opt-in |
| Sim timeout | Sensible default OK; strict abort on timeout still only in `GUARD_MODE=strict` |
| External screening webhooks beyond notify | **OFF** / none |
| Local revm | **OFF** |
| Strict mode | Already opt-in (`open` default) |

**Invariant:** Layer 2 deny never fail-opens (`-32083`).

---

## Surprises vs prior Layer 2 P2 follow-ups (A3)

| Prior A3 P2 | This study |
| --- | --- |
| Rolling caps, hot-reload, approve denylist, token caps, multicall unwind, revm, rate-limit | Still listed — but **P0 is evidence/DX**, not those features |
| Assumed AgentKit lacked destination policy | **CDP Policy Engine** now documents allowlist + `ethValue` at sign/send — differentiation must emphasize **L1 definite-revert + self-host + non-CDP EOAs** |
| Feature-heavy follow-ups after merge | **Eval corpus never gained `policy_denied`**; GFIs all closed — process gaps larger than missing rolling caps |
| Soft WTP dormant | #1512 + Layer 2 ship **same day**; hottest move is evidence pack, not more policy surface |
| Alchemy sim as ambient competitor | Proprietary Simulate APIs **deprecate 2026-09-30** — strengthens `eth_simulateV1` path |

---

## Suggested founder greenlight order (if P0 approved)

1. Docs: bypass honesty (+ CDP complement paragraph in README or `docs/AGENTS.md`)  
2. Eval `policy_denied` + offline policy demo script  
3. Health counters / policy summary  
4. AgentKit example folder (no outbound)  
5. File GFIs (human) matching TRACTION_PLAN  

Then P1 only if an integrator asks or Soft WTP reply demands a specific footgun (likely approve denylist or ERC20 amount caps).

---

## Non-goals reminder (product rails)

Thin JSON-RPC middleware · L1 fail-open uncertain · L2 deny definite · no custody · not Safe/enterprise engine · not hosted SaaS push · multi-L2 Sepolia day-one · TypeScript.

