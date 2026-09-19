# Soft WTP targets (SEND ATTEMPTED — blocked)

**Status: SEND ATTEMPTED 2026-09-19 ~02:35 ET — all 5 BLOCKED (gh fine-grained PAT 403 on third-party createIssue/createDiscussion).** CoS authorized ≤5 soft WTP prep on 2026-09-19. See [SEND_LOG.md](../SEND_LOG.md).  
**Guardrails:** no spam, no DM abuse, no early AF apply, ₹0. Do **not** send until an explicit send step. Prefer public non-DM surfaces.

Public repo: https://github.com/yellowgram/l2-safety-proxy  
Demo: https://github.com/yellowgram/l2-safety-proxy/blob/main/docs/DEMO.md · offline: `node scripts/demo-offline.mjs`

Discovery questions (from [SOFT_WTP.md](../SOFT_WTP.md)): failed-tx support/gas burden; Tenderly-or-similar spend/workflow; self-host vs paid hosted tier; chains + fail-open tolerance.

---

## 1. Coinbase AgentKit (`coinbase/agentkit`)

| | |
| --- | --- |
| **Fit** | Agent-infra wallet toolkit that submits onchain txs (Base/Arb/etc.). Pre-broadcast definite-revert abort + fail-open maps to agent submit reliability without custody. |
| **Public contact** | GitHub Issues / Discussions on https://github.com/coinbase/agentkit (prefer issue or discussion over Discord DM). |
| **Status** | **BLOCKED** 2026-09-19 ET — `403 createIssue` on `coinbase/agentkit` (fine-grained PAT). Not sent. |

**Discovery message draft:**

> Hi — researching a narrow pre-broadcast JSON-RPC safety layer (simulate `eth_sendRawTransaction`, abort only definite reverts, fail-open when uncertain; no key custody). Relevant for agent submit paths that already use CDP/AgentKit wallets. Curious: (1) how often failed L2 sends create support or gas friction for agents you see? (2) do you already cover this with Tenderly/sim tooling, and which workflow? (3) would a self-hostable middleware in front of an existing RPC be useful vs a hosted tier? Public repo + offline demo (no keys/capital): https://github.com/yellowgram/l2-safety-proxy · https://github.com/yellowgram/l2-safety-proxy/blob/main/docs/DEMO.md — happy to take a “not a fit” if send-path sim isn’t a pain.

---

## 2. Safe{Core} SDK (`safe-global/safe-core-sdk`)

| | |
| --- | --- |
| **Fit** | Multisig / smart-account wallet stack; proposers and operators still pay for predictable reverts on L2. Thin send-path guard complements protocol kit without replacing Safe. |
| **Public contact** | GitHub Discussions: https://github.com/safe-global/safe-core-sdk/discussions (Q&A / Ideas). |
| **Status** | **BLOCKED** 2026-09-19 ET — Discussions available (Q&A); `403 createDiscussion`. Not sent. Fallback Issue not attempted after Discussion 403 (same PAT). |

**Discovery message draft:**

> Researching whether Safe integrators feel pain from predictable L2 reverts at the `eth_sendRawTransaction` boundary (support load / gas). We’re OSS-building a fail-open JSON-RPC middleware: definite sim revert → abort `-32080`; uncertain → forward. No custody. Questions: how often do failed sends create support work for Safe users on Arb/OP/Base? Is Tenderly (or similar) already the workflow? Would self-host in front of existing RPC beat a paid hosted tier? Repo + DEMO: https://github.com/yellowgram/l2-safety-proxy — drafts only; not asking for endorsement.

---

## 3. Alchemy Account Kit (`alchemyplatform/aa-sdk`)

| | |
| --- | --- |
| **Fit** | Smart-wallet / AA SDK with sponsored and batched sends across L2s. Complementary safety layer in front of bundler/RPC paths for definite reverts before broadcast. |
| **Public contact** | GitHub Issues on https://github.com/alchemyplatform/aa-sdk (feature/feedback issues; avoid private support tickets for cold discovery). |
| **Status** | **BLOCKED** 2026-09-19 ET — repo verified `alchemyplatform/aa-sdk`; `403 createIssue`. Not sent. |

**Discovery message draft:**

> Looking for honest signal on pre-broadcast revert friction for Account Kit / smart-wallet send paths on L2. Prototype: multi-L2 JSON-RPC guard (Arb/OP/Base Sepolia) — simulate raw send, abort definite reverts, fail-open on uncertainty; sits in front of the RPC you already use. Questions from our soft-WTP brief: failed-tx support/gas frequency? current sim/tracing spend & workflow? self-host vs hosted SLA interest? chains that matter most? Public: https://github.com/yellowgram/l2-safety-proxy + DEMO.md. Not a sales pitch — fine if this is already solved upstream.

---

## 4. Conduit (Orbit / OP RaaS operators)

| | |
| --- | --- |
| **Fit** | Managed Arbitrum Orbit + OP Stack rollup operator; chain operators and their apps absorb failed-send support on custom L2 RPCs. Middleware-in-front-of-RPC matches their model. |
| **Public contact** | Public email `support@conduit.xyz` (listed on GitHub org) **or** a public GitHub issue on an appropriate `conduitxyz/*` repo if filing as integrator feedback — prefer email/issue over Discord DM. |
| **Status** | **BLOCKED** 2026-09-19 ET — preferred Issue on `conduitxyz/integrations` → `403 createIssue`; email skipped (no Gmail / task forbid). Not sent. |

**Discovery message draft:**

> Hi Conduit team — soft discovery only (no ask for partnership). Building OSS L2 Send Guard: thin pre-broadcast sim for `eth_sendRawTransaction` on Orbit/OP-style RPCs; abort definite reverts; fail-open when uncertain; no custody. Curious whether failed user/app sends on Conduit-hosted chains create measurable support or gas pain, whether operators already standardize on Tenderly-class tooling, and whether a self-hostable guard in front of Conduit RPC would be interesting vs hosted. Repo + DEMO: https://github.com/yellowgram/l2-safety-proxy — happy with a brief “not a priority.”

---

## 5. Rabby Wallet (`RabbyHub/Rabby`)

| | |
| --- | --- |
| **Fit** | EVM wallet with strong security UX; users still hit predictable reverts on L2. Drop-in RPC middleware could reduce failed broadcasts without Rabby holding different custody assumptions. |
| **Public contact** | GitHub Issues on https://github.com/RabbyHub/Rabby (public issue; do not cold-DM Discord). |
| **Status** | **BLOCKED** 2026-09-19 ET — `403 createIssue` on `RabbyHub/Rabby`. Not sent. |

**Discovery message draft:**

> Soft research question for wallet teams that route L2 sends: how often do predictable reverts create support tickets or user friction on Arb/OP/Base? We’re OSS-shipping a fail-open JSON-RPC safety proxy (simulate → abort only definite; uncertain forwards). No keys, not an RPC replacement. Would self-host in front of the user’s RPC URL be useful, or is Tenderly/sim already covering this in-product? Public repo + offline abort demo: https://github.com/yellowgram/l2-safety-proxy · docs/DEMO.md. Draft outreach — not sent as spam; ignore if off-mission.

---

## Target count

**5 / 5 max.** No additional named orgs until a future CoS refresh.
