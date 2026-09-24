# Paid support & integration (optional)

**L2 Send Guard stays MIT / free to run.** Core simulation, fail-open semantics, and optional Layer 2 policy are not paywalled. This page is for teams that want **fixed-scope help** or **priority triage**.

**Try before you buy:** [`docs/INBOUND_DEMO.md`](./docs/INBOUND_DEMO.md) — `npm test` / `npm run build` / `npm run demo:dual-layer`, how to read `-32080` / `-32083`, expected PASS transcript.

Community (free): GitHub **Issues** & **Discussions** on [yellowgram/l2-safety-proxy](https://github.com/yellowgram/l2-safety-proxy). No SLA.

**Contact for paid SKUs:** reply on GitHub Issues / Discussions (title `support: <SKU>`), **or** email `CONTACT_EMAIL_TBA` when the founder publishes an address. Do not invent founder contact details from this repo.

Sim ≠ policy positioning: [`docs/COMPETITIVE.md`](./docs/COMPETITIVE.md). Income kill clock (internal): [`docs/INCOME_GATE.md`](./docs/INCOME_GATE.md).

---

## Public SKUs (USD)

| SKU | What you get | Price (USD) | Typical calendar |
| --- | --- | --- | --- |
| **AgentKit wire-up** | Point AgentKit / viem / ethers at Guard; dual-layer demo (`-32080` / `-32083`); policy.agent template tuned to your allowlist; short handoff note | **$1,200** | **3 days** |
| **Policy pack review** | Review of your Layer 2 JSON (allowlist, native caps, notify hook); bypass honesty checklist (approve / Permit2 / multicall); written residual risks — **no** Safe-clone redesign | **$600** | **1–2 days** |
| **Priority triage retainer** | Slack/email triage queue for Guard runtime questions; best-effort same-business-day reply on regressions you can repro offline | **$800 / month** | Monthly |

Prices are **public list** in USD. Currency / settlement (INR / USDT / Wise / other) is chosen **on the invoice** after scope is confirmed — not advertised as fake checkout links in this repo.

Custom pilots: start from [`docs/PILOT_SOW.md`](./docs/PILOT_SOW.md) (blanks for deliverables / success metrics / price).

---

## Community vs paid boundary

| Included free (OSS) | Paid |
| --- | --- |
| Run proxy, Layer 1 sim, Layer 2 policy (self-hosted) | Hands-on wire-up into your agent stack |
| Docs, offline demos, eval harness, GitHub issues | Scheduled review of *your* policy pack |
| Best-effort maintainer replies when capacity allows | Retainer SLA-ish priority triage |

We will **not** charge for access to core middleware features.

---

## How to buy (invoice path)

1. **Inbound only:** open a GitHub Issue / Discussion titled `support: <SKU>`, **or** email `CONTACT_EMAIL_TBA` (placeholder until founder publishes).  
2. Confirm SKU + scope in writing (use [`docs/PILOT_SOW.md`](./docs/PILOT_SOW.md) for multi-day pilots).  
3. **Founder provides payee details on the invoice** (USDT network+address, Wise business details, Razorpay/card link, or other). CoS fills invoice fields **only after** the founder supplies them — **no** invented Wise/USDT/Razorpay details or fake checkout URLs in this repo.  
4. Work starts after cleared payment (or written net-terms agreement).

### Internal process (agents / CoS — not a customer step)

1. Draft SOW from [`docs/PILOT_SOW.md`](./docs/PILOT_SOW.md) when an inbound thread exists.  
2. **Founder sends** the SOW / invoice to the buyer.  
3. **Never CoS cold-send** — no unsolicited SOW email, Soft WTP bumps, or invented payee details. Soft WTP freeze: do not bump AgentKit #1512.

---

## Out of scope for these SKUs

Key custody · becoming your RPC cloud · Safe / Zodiac / ERC-7579 builds · Approval-Inbox product clone · grant-application writing · Soft WTP / cold outreach on your behalf · hosted SaaS before the income gate ([`docs/INCOME_GATE.md`](./docs/INCOME_GATE.md)).
