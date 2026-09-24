# R1 — Broad scan: candidate add-ons + competitor diffs

**Date:** 2026-09-24 (America/New_York)  
**Package:** `l2-send-guard` v0.3.0 @ `/workspace/l2-safety-proxy` (main; Layer 2 spend policy just merged via PR #6)  
**Scope:** continuous improvements + feature add-ons study (research + docs only; no code)  
**Inputs:** ARCHITECTURE, README, A3/B3/D3, METRICS, TRACTION_PLAN, SOFT_WTP, src/, tests/, evaluation/, package.json, open issues via `gh`, peer web research

---

## 0. Posture after v0.3.0

| Layer | Shipped | Default |
| --- | --- | --- |
| **L1** | sim `eth_sendRawTransaction` → `-32080` definite abort; fail-open / strict on uncertain | ON |
| **L2** | allowlist + native wei caps + ERC20 recipient check + optional notify; `-32083` | **OFF** |

**Locked rails (do not violate):** thin JSON-RPC middleware; no key custody; not Safe/enterprise policy engine; not hosted SaaS push; multi-L2 arb/op/base sepolia; TypeScript.

**Prior Layer 2 P2 (A3, not built):** rolling daily caps; hot-reload; selector denylist (approve max); per-token ERC20 amount caps; multicall/router unwind; optional local revm; sim rate-limit (hosted).

**Repo hygiene snapshot:**
- Open issues: **0** (GFIs #1–#3 closed; probe issue #4 closed). TRACTION_PLAN wants ≥2 open GFIs — gap.
- Eval corpus: **310** fixtures, **no** `policy_denied` class.
- Soft WTP: AgentKit #1512 + Safe discussion #1437 founder-sent; 3–5 hold. AgentKit got Cobra Layer-2 framing; founder replied; **Layer 2 now shipped** — natural evidence to surface *only if they reply*, not as a bump.
- Users/teams (METRICS): **0**. Buildathon AT-RISK.

---

## 1. Competitor / adjacent map (diffs)

| Peer | What they do | Vs Send Guard | KEEP / KILL / CHANGE idea |
| --- | --- | --- | --- |
| **OP Security Proxy** (`op-sec-proxy`) | Rust local revm sim; OP-stack; fail-open; `-32000` + gas-saved meta | Closest **L1** peer. We already differentiate multi-L2 + `eth_simulateV1` + TS + confidence UX. No address/spend policy in their public grant scope. | **KEEP** fail-open L1. Optional **CHANGE**: document gas-saved estimate meta (nice UX, not wedge). Do **not** clone OP-only / revm-first. |
| **op-txproxy** (Optimism infra) | Conditional send rate-limit / 4337 target checks for `eth_sendRawTransactionConditional` | Operator ingress tool, not wallet/agent sim. | **KILL** as product clone. **CHANGE**: note Conditional as complementary sequencer feature, not a competitor. |
| **Tenderly** | Hosted full sim / traces / `tenderly_simulateTransaction` | Heavy DevOps suite; paid. We stay thin fail-open middleware in front of existing RPC. | **KILL** rebuild. **KEEP** positioning: “already have RPC; don’t need suite for send-path.” |
| **Alchemy Simulate** | `alchemy_simulateAssetChanges` etc.; **deprecated Sep 30 2026**; also exposes `eth_simulateV1` | Cloud-attached sim, not middleware. Deprecation reinforces **standard `eth_simulateV1`** path we already prefer. | **KEEP** V1-first. **KILL** Alchemy-proprietary method dependency. |
| **eRPC** | Multi-upstream failover / cache / hedge | Complementary — sit in front. | **KILL** rebuild. **CHANGE** (DX): one-line compose example “Guard → eRPC → providers.” |
| **Flashbots Protect** | Private submit / MEV protection RPC | Different threat (order flow), not definite-revert abort. | **KILL** (NON-goal). Document explicit non-overlap. |
| **Safe / Zodiac Roles** | On-chain role target/function/allowance policy; AI-agent patterns with Delay | Full enterprise/on-chain engine. Wrong product shape for EOA raw-tx proxy. | **KILL** clone. Soft WTP Safe thread = complementary evidence only. |
| **ERC-4337 / 7579 Smart Sessions** | Session keys, spend limits, action policies on smart accounts | Wrong custody/account model for this middleware. | **KILL** for package. Optional future “UserOp not intercepted” docs note. |
| **CDP Policy Engine + AgentKit** | Project/account rules: `evmAddress` allowlist, `ethValue` caps on **sign/send** ops; fail-closed | **Overlaps Layer 2 semantics** for CDP-managed wallets, but (a) at **signing** not broadcast middleware, (b) **no definite-revert sim**, (c) not self-host in front of arbitrary RPC / EOA agent. #1512 validated L2 need; Cobra framed policy beside sim. | **CHANGE**: position as **complement** — CDP policy for CDP keys; Send Guard for local-sign agents + L1 sim. Soft WTP hook = AdapterKit example + honest “when CDP policy already covers destinations, you still want L1 sim.” |
| **Blockaid / Blowfish / GoPlus** | Threat intel + tx screening APIs (scam/phish verdicts) | Hosted reputation / malware layer, not thin local policy. | **KILL** embed as default. Optional **defer** adapter hook (OFF by default) if integrator brings own API key — high positioning risk. |
| **Permit2 / allowance UX** | Broad token approval to Permit2; max allowances | Major residual bypass if Layer 2 only checks native + ERC20 transfer recipient. | **CHANGE**: thin selector denylist / docs warning (see candidates). Not full Permit2 decoder in M1. |
| **Reth #27342 gascap** | `eth_call` vs `eth_estimateGas` ceiling split under `--rpc.gascap` | In-repo probe already merged (PR #5). Lesson: client-side probes + honest confidence beat assuming node flags. | **KEEP** probe as evidence artifact. No further product feature unless new RPC quirks appear. |

---

## 2. Candidate add-ons (broad inventory)

### A. Layer 1 harden (sim / confidence / reliability)

| ID | Candidate | One-line |
| --- | --- | --- |
| L1-1 | **Gas-saved estimate** on definite abort (`gas × gasPrice` advisory) | OP Sec Proxy UX parity; marketing-friendly without changing semantics |
| L1-2 | **eth_simulateV1 coverage matrix** doc + CI probe per public Sepolia RPC | Reduce fail-open surprises; document which upstreams skip V1 |
| L1-3 | **State-freshness hints** (block number / age in meta) | Helps agents decide whether uncertain was “stale” vs “method missing” |
| L1-4 | **Optional local revm engine** (ARCHITECTURE M2) | Offline CI / no upstream sim — heavy TS/native bridge risk |
| L1-5 | **Batch / multicall sim** (`eth_simulateV1` multi-call) | Overkill for single-send middleware |
| L1-6 | **Sim timeout + budget** (hard ceiling ms) | Prevent DoS; still fail-open on timeout in open mode |
| L1-7 | **Custom error ABI registry** (user-supplied) | Better decode for app-specific reverts |
| L1-8 | **Flashblocks / preconfirm aware tip** on Base | Niche; Base already preferSimulateV1 |

### B. Layer 2 policy (thin extensions)

| ID | Candidate | One-line |
| --- | --- | --- |
| L2-1 | **Selector denylist** (`approve` max, `setApprovalForAll`, optional Permit2 `permit`) | Closes A3 P2-3; still thin; OFF flags inside policy file |
| L2-2 | **Hot-reload policy file** (SIGHUP / mtime watch) | A3 P2-2; ops DX without restart |
| L2-3 | **Rolling / daily native caps** | A3 P2-1; stateful — creep toward Safe |
| L2-4 | **Per-token ERC20 amount caps** (decimals-aware) | A3 P2-4; amount already decoded but unused for caps |
| L2-5 | **Multicall / router unwind** | A3 P2-5; hard + false confidence risk |
| L2-6 | **From-address allowlist** (which EOAs may send through guard) | Agent fleets; not destination policy |
| L2-7 | **Per-chain policy overlays polish** (examples + validate) | Already in schema; docs/fixture gap |
| L2-8 | **Blocking human gate** (wait for approve API) | Explicitly killed in B3 — deadlock risk |
| L2-9 | **Policy dry-run CLI** (`l2-send-guard policy-check <rawTx>`) | DX for operators before enabling |
| L2-10 | **Startup refuse** empty allowlist when enabled | A3 P1-4 — check if fully enforced |

### C. DX / integrator surface

| ID | Candidate | One-line |
| --- | --- | --- |
| DX-1 | **AgentKit / CDP adapter example** (point wallet RPC / custom transport at guard) | Soft WTP #1512 pull without cold spam |
| DX-2 | **Docker Compose: Guard + eRPC** sample | Complementary story; 10-min integrator path |
| DX-3 | **viem / ethers error helpers** map `-32080/-32083` → typed errors | SDK completeness |
| DX-4 | **Open ≥2 good-first-issues** (TRACTION_PLAN gap) | Discoverability; zero product risk |
| DX-5 | **npm publish checklist / package README on npm** | Only if founder tags release |
| DX-6 | **Policy example cookbook** (agent treasury, faucet bot, allow-any+global-cap) | Reduces misconfig |
| DX-7 | **Health endpoint: policy.enabled + dest count** (no secrets) | Ops visibility |

### D. Evidence / eval / observability (often NOT “features”)

| ID | Candidate | One-line |
| --- | --- | --- |
| EV-1 | **Eval corpus: `policy_denied` class** + generator flags | Corpus still L1-only after v0.3.0 |
| EV-2 | **Decision counters** (abort / fail_open / forward / policy_denied) → `/metrics` or log JSON | METRICS.md currently manual/honest zeros |
| EV-3 | **Refresh GFIs + DEMO gif** | Traction without outreach |
| EV-4 | **Layer 2 offline demo script** | Parallel to `demo-offline.mjs` for `-32083` |
| EV-5 | **Agent loop with policy fixtures** | Evidence for Soft WTP replies |
| EV-6 | **Document residual bypasses** (approve / Permit2 / multicall) in README Threats | Honesty > false confidence |

### E. Explicit non-goals / kill zone

| ID | Candidate | Why kill |
| --- | --- | --- |
| NG-1 | Key custody / `eth_sendTransaction` signing | Product rail |
| NG-2 | Safe / Zodiac / 7579 session module clone | Wrong layer |
| NG-3 | Hosted SaaS + billing | Soft WTP gate unmet (users=0) |
| NG-4 | Flashbots Protect / private mempool product | Different threat |
| NG-5 | Blockaid/GoPlus default embed | Hosted threat-intel ≠ thin middleware |
| NG-6 | Grant theater / AF auto-apply | TRACTION_PLAN hard rule |
| NG-7 | Soft WTP bump on #1512 / #1437 | Freeze: wait for reply |
| NG-8 | Mainnet chain templates as “day-one” marketing | Still Sepolia matrix; mainnet = separate ops decision |
| NG-9 | Replacing CDP Policy Engine | Overlap; complement instead |

---

## 3. Continuous improvements that are NOT new features

These are high leverage and should compete with “feature” backlog:

1. **Eval fixtures for Layer 2** — corpus has zero `policy_denied`; agent loop inherits that gap.  
2. **Re-open GFIs** — TRACTION_PLAN weekly checklist broken (0 open). Themes: policy offline demo docs; Panic fixtures expansion leftover; compose Guard+eRPC; health policy fields.  
3. **Bypass honesty docs** — approve / setApprovalForAll / Permit2 / multicall still residual; README “What it is not” should call them out post-merge.  
4. **Error UX polish** — ensure `hint` + `policyCode` consistently in `-32083` data (A2 draft had `hint`; verify shipped shape).  
5. **Observability** — process-local counters for CoS METRICS without inventing users.  
6. **SDK README Layer 2 note** — still L1-only narrative.  
7. **SMOKE / SEND_LOG** — optional offline policy deny row for evidence pack.  
8. **Empty-allowlist startup refuse** — confirm load path matches A3 P1-4; add test if missing.

---

## 4. Soft WTP / AgentKit angle (no spam)

**What already happened:** founder sent #1512; Cobra replied with Layer-2 framing; founder acknowledged two-layer model; **we shipped Layer 2 on main**.  

**What would make a hook more likely without cold outreach:**

| Move | Why it helps | Spam risk |
| --- | --- | --- |
| Ship **AgentKit adapter example** + short “complement to CDP Policy Engine” note in-repo | Gives maintainers a concrete PR-able artifact if they engage | None (inbound) |
| Add **policy_denied** eval + agent-loop evidence | Makes Soft WTP demo answering Cobra’s question reproducible | None |
| Wait for their reply; then one technical update comment (human) with PR #6 link | Natural continuation of open thread | Low if founder-gated |
| Do **not** open new issues on AgentKit / bump #1512 | Freeze still on | — |
| Public OSS discoverability (GFIs, README Layer 2 + CDP complement) | Passive may find us via search | None |

**Positioning sentence for drafts (not outbound):**  
“CDP Policy Engine governs sign/send for CDP wallets; L2 Send Guard adds definite-revert abort + optional self-hosted destination/spend policy in front of any RPC for local-sign agents.”

---

## 5. What must stay OFF-by-default if added

| If added | Default |
| --- | --- |
| Entire Layer 2 policy (already) | **OFF** |
| Selector denylist / approve guards | **OFF** (or only when policy enabled + explicit list) |
| Hot-reload | Opt-in env flag |
| Rolling caps | OFF / preferably never in-wedge |
| External screening (Blockaid/GoPlus) | OFF; integrator-supplied URL/key only |
| Strict GUARD_MODE | Already opt-in (`open` default) |
| Local revm | OFF optional engine |
| From-address allowlist | OFF (empty = no from filter) |
| Hosted SaaS / rate-limit tier | Not until Soft WTP gate |

**Never fail-open:** any Layer 2 deny path (`-32083`).

---

## 6. Shortlist for R2 deepening

Carry forward (rough top pull × fit × thinness):

1. Eval + offline policy evidence (EV-1, EV-4, EV-5)  
2. Selector denylist thin (L2-1) + bypass docs (EV-6)  
3. AgentKit / CDP complement DX (DX-1) + Soft WTP readiness  
4. Decision counters / health policy fields (EV-2, DX-7)  
5. Gas-saved meta (L1-1) — polish  
6. Hot-reload (L2-2) — ops  
7. Per-token ERC20 caps (L2-4) — careful  
8. eRPC compose (DX-2) + GFI reopen (DX-4)  
9. Sim timeout budget (L1-6)  
10. From-allowlist (L2-6)

Defer deepen-kill: L2-3 rolling, L2-5 multicall unwind, L1-4 revm, NG-* .

---

## 7. Surprises vs prior Layer 2 P2 follow-ups

1. **CDP Policy Engine is now a real adjacent** (allowlist + `ethValue` at sign time). A3 assumed AgentKit lacked destination policy; CDP docs show they have it for CDP wallets. Differentiation shifts to **L1 sim + self-host + non-CDP EOAs**, not “we invented allowlists.”  
2. **Alchemy proprietary Simulate APIs are sunsetting (2026-09-30)** — strengthens our `eth_simulateV1` bet.  
3. **Eval/agent evidence did not keep up with Layer 2 ship** — P2 list was feature-heavy; the surprising gap is **evidence/DX**, not missing rolling caps.  
4. **All GFIs closed** — traction checklist regression unnoticed in Layer 2 merge focus.  
5. **Cobra’s comment + Layer 2 merge same day** — Soft WTP thread is hot for *evidence*, cold for *outreach*.

