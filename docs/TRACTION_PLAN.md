# Agent-runnable traction plan

**Audience:** autonomous / semi-autonomous agents operating this repo.  
**Goal:** grow discoverability and reproducible evidence for L2 Send Guard **without** founder intros, cold DMs, shilling, capital, or grant applications.

| Hard rules | |
| --- | --- |
| **No unsolicited DMs / shilling** | No Discord/Telegram cold messages, no Twitter spam, no “check out my project” replies. |
| **No grant apply** | Do **not** submit AF / foundation / accelerator applications. Prep only: [AF_TRACTION_PREP.md](./AF_TRACTION_PREP.md). |
| **No outreach to external people** | Soft WTP questions stay internal until founder/CoS explicitly authorize: [SOFT_WTP.md](./SOFT_WTP.md). |
| **No visibility change** | Do not flip the GitHub repo public/private; prepare docs as if public OSS. |
| **₹0 / $0** | No paid ads, no paid SEO, no paid listing boosts. |

Public Q&A (ethereum-magicians, StackExchange) is **draft-only** until a human reviews — see weekly backlog.

Paid-surface kill clock (inbound only; Soft WTP freeze): [INCOME_GATE.md](./INCOME_GATE.md). Inbound demo pack: [INBOUND_DEMO.md](./INBOUND_DEMO.md).

---

## Weekly cadence (agent checklist)

Copy into the weekly CoS note. Check boxes only when evidence is in-repo or linked.

### Every week

- [ ] **README / SEO hygiene** — title, first paragraph, keywords (`eth_sendRawTransaction`, L2, Arbitrum, Optimism, Base, fail-open, JSON-RPC) still accurate; clone URL and 60-second start work on a clean clone.
- [ ] **DEMO freshness** — run `npm test`, `node scripts/demo-offline.mjs`; optionally `node scripts/live-smoke-cache.mjs` if public RPCs are reachable. Append dated notes to [SMOKE.md](./SMOKE.md) on live runs.
- [ ] **Metrics row** — append one line to [METRICS.md](./METRICS.md) (users / sims / week). Use `docs/metrics/` for raw exports (CSV/JSON). Prefer real counters; if none, record `0` honestly — never invent users.
- [ ] **Good first issues** — ensure ≥2 open labeled `good first issue` with acceptance criteria (templates under `.github/ISSUE_TEMPLATE/`).
- [ ] **Demo artifact** — refresh or add a short GIF/script path (asciinema, terminal GIF, or markdown fenced transcript) showing `-32080` abort + fail-open. Prefer scripts committed in `scripts/` over hosted binaries.

### Biweekly (or when docs drift)

- [ ] **Issue / PR templates** — bug + feature + good-first-issue templates still match current CLI/env names.
- [ ] **SDK pointer** — [src/sdk/README.md](../src/sdk/README.md) examples compile against current exports.
- [ ] **Chain matrix** — README + DEMO list matches `L2SG_CHAINS` defaults and public RPC hosts.

### Later (draft only — human gate)

- [ ] **ethereum-magicians draft** — technical note on multi-L2 pre-broadcast simulation + fail-open; save under `docs/drafts/` (create folder when needed). Do **not** post without founder/CoS approval.
- [ ] **Ethereum StackExchange draft** — answer only questions that already exist and where this tool is a factual fit; draft offline; no self-promo titles. Human posts.

### Explicitly out of weekly scope

- Founder intros, partner emails, grant forms, paid listings.
- Changing repo visibility.
- Contacting anyone named in [SOFT_WTP.md](./SOFT_WTP.md).

---

## Concrete workstreams (what “done” looks like)

### 1. GitHub README / SEO

- Keep the top-of-README integrator pitch (what / 60s start / chain matrix / SDK / safety).
- Topics/keywords via `package.json` `keywords` and README headings — no keyword stuffing.
- Ensure clone → `npm test` → `npm start` → `/health` is the documented happy path.

### 2. Demo GIFs / scripts

| Artifact | Path | Purpose |
| --- | --- | --- |
| Offline abort + fail-open | `scripts/demo-offline.mjs` | Deterministic, CI-friendly |
| Live Base definite abort | `scripts/live-smoke-cache.mjs` | Public Sepolia evidence |
| Human walkthrough | `docs/DEMO.md` | npm + Docker |

Optional: add `docs/assets/demo-abort.gif` (generated locally; keep small). Do not commit secrets captured in recordings.

### 3. Issue templates & good first issues

Templates live in `.github/ISSUE_TEMPLATE/`. Example good-first-issue themes (file real issues when shipping):

- Add a chain-id numeric alias test for `x-l2sg-chain: 84532`
- Document a second live smoke for Arb Sepolia (unfunded abort)
- Improve decoded-error golden fixtures for Panic(uint256)
- Wire a GitHub Action that runs `npm test` + `demo-offline.mjs` on PR

### 4. Metrics for CoS

- Template: [METRICS.md](./METRICS.md)
- Raw drops: `docs/metrics/` (keep `.gitkeep`; commit anonymized aggregates only)
- Fields: week start (ET), unique users/teams, sim count, definite aborts, fail-opens, notes

### 5. Discoverability without outreach

- Accurate README + DEMO so search/GitHub browse converts.
- Release tags only when founder asks (`v0.x.y`); agents do not cut marketing releases alone.
- Keep AF_TRACTION_PREP evidence pack links fresh so a future human application is one decision away — not auto-submitted.

---

## Definition of weekly success (honest)

A week is successful if:

1. Tests + offline demo still pass.
2. Metrics row exists (even if zeros).
3. At least one discoverability/docs improvement landed **or** an intentional “no change; verified fresh” note in METRICS.
4. Zero unsolicited external messages and zero grant applications.

Traction is evidence over time, not a single launch shout.
