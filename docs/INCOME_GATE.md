# Income gate (Guard paid surface)

**Clock start:** 2026-09-24 (America/New_York).  
**Purpose:** keep paid SKUs findable and inbound-ready **without** building hosted SaaS or inventing traction.

## Kill / revisit rule

**Revisit (or kill the paid push) if, 90 days after clock start (≈ 2026-12-23 ET), both are still true:**

1. **0 external integrators** — no third-party team running Guard in their own env with evidence in metrics / issues / Discussions, and  
2. **0 paid inquiries** — no inbound ask for a SUPPORT SKU or pilot SOW (GitHub or email).

Until then: keep OSS free, keep [`SUPPORT.md`](../SUPPORT.md) + [`PILOT_SOW.md`](./PILOT_SOW.md) accurate, prefer inbound demos ([`INBOUND_DEMO.md`](./INBOUND_DEMO.md)).

## Explicit freezes

| Freeze | Rule |
| --- | --- |
| **No hosted SaaS before traction** | Do not build billing / multi-tenant hosted Guard until this gate is revisited with real demand. Prep-only docs ([`AF_TRACTION_PREP.md`](./AF_TRACTION_PREP.md)) stay prep. |
| **Soft WTP freeze** | Do **not** bump AgentKit #1512 or open new Soft WTP cold issues. Wait for their reply; founder-gated only. See [`SOFT_WTP.md`](./SOFT_WTP.md). |
| **No invented payee / checkout** | Invoice payee details are founder-supplied only. CoS does not invent Wise / USDT / Razorpay URLs. |
| **No CoS cold-send of SOWs** | Draft SOW in-repo → **founder** sends to the inbound contact. CoS never cold-emails prospects. |

## What stays in control (agents / CoS)

- README / SUPPORT / COMPETITIVE findability  
- Inbound demo pack + honest GFIs  
- Metrics honesty (zeros OK)  
- Draft SOW when an inbound thread exists

Linked lightly from [`SUPPORT.md`](../SUPPORT.md) and [`TRACTION_PLAN.md`](./TRACTION_PLAN.md).
