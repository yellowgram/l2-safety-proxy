# Soft WTP brief (later; no outreach)

**Status: internal planning only.** This is a one-page problem brief for a later, founder-approved soft-pitch process—not a customer list, sales script, grant application, or evidence of demand.

## Problem

Wallets, agent infrastructure, and Orbit/OP operators can pay gas and absorb support burden when a signed L2 transaction predictably reverts. Existing simulation and tracing suites can be broader than this narrow send-path need, while a general RPC cloud is the wrong product. L2 Send Guard is a thin, self-hostable JSON-RPC/SDK safety layer in front of an existing RPC: simulate a raw send, stop only a **definite** revert, and preserve availability by failing open when the result is uncertain.

The product is not key custody, an indexer, an RPC replacement, or a promise that simulation equals on-chain truth. Signing remains with the wallet, KMS, or agent.

## What to demo

Use a short, reproducible public-testnet demo with no secrets or broadcast requirement:

1. **Definite revert abort:** submit a signed raw transaction whose simulation clearly reverts; show the proxy returning JSON-RPC `-32080`, decoded error data/reason, and no upstream broadcast.
2. **Fail-open:** show an unsupported, unavailable, or otherwise uncertain simulation being forwarded to the upstream RPC, with the confidence state visible. Do not describe this as a guarantee of success.
3. **Multi-L2:** repeat the same send-path flow across Arbitrum Sepolia, OP Sepolia, and Base Sepolia using the chain selector. Highlight that the guard sits in front of the RPC already in use rather than replacing it.

Keep the demo focused on avoided failed sends, clear confidence handling, no key custody, and the operator/user workflow. Do not claim customer savings or adoption without measured evidence.

## Questions to ask later (not quotes)

If the founder/CoS approves outreach, ask open questions and record answers verbatim or as attributable notes—never invent testimonials:

- How often do failed transactions create support work, user friction, or treasury/gas cost?
- What is the current Tenderly or comparable simulation/tracing spend, and which workflow does it cover?
- Would the team self-host this middleware, or pay for a hosted tier with SLA, multi-region reliability, dashboards, or support?
- Which chains and send paths matter most, and what confidence/fail-open behavior is acceptable?

These are discovery questions, not claims that any target has this problem or uses Tenderly.

## Gate before SaaS or AF application

Do not build a hosted SaaS tier or apply to the Arbitrum Foundation before the research-pack bar is met: **at least two weekly users/teams using the OSS workflow, or clear written interest in a paid tier**. Track the evidence, scope, chain, and date without fabricating usage or quotes. This is a readiness gate, not a grant promise; any future application remains a separate founder decision after the relevant program terms are re-checked.

## Outreach guardrail

**Do not contact anyone from this document alone.** The founder/CoS decide whether outreach happens, who may be contacted, and when. Until that decision, this document supports product/demo preparation only. No capital deployment, grant application, or outreach is authorized by this brief.
