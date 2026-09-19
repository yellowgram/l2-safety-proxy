# Soft WTP send log

**Auth attempt:** `gh` as `yellowgram` via `/workspace/blockchain/gh-env.sh` (fine-grained `GH_TOKEN`).  
**Date:** 2026-09-19 ~02:35 ET (EDT).  
**Result:** All five public surfaces returned **403** — token can act on `yellowgram/*` but cannot `createIssue` / `createDiscussion` on third-party public repos. No posts were created. Email skipped per task rules (no Gmail).

| target | surface | URL | date ET | status |
| --- | --- | --- | --- | --- |
| Coinbase AgentKit | GitHub Issue `coinbase/agentkit` | — | 2026-09-19 02:35 ET | **BLOCKED** — `403 Resource not accessible by personal access token (createIssue)` |
| Safe{Core} SDK | GitHub Discussion Q&A `safe-global/safe-core-sdk` (Discussions enabled; would use Q&A category) | — | 2026-09-19 02:35 ET | **BLOCKED** — `403 Resource not accessible by personal access token (createDiscussion)` |
| Alchemy Account Kit | GitHub Issue `alchemyplatform/aa-sdk` (repo verified) | — | 2026-09-19 02:35 ET | **BLOCKED** — `403 Resource not accessible by personal access token (createIssue)` |
| Conduit | GitHub Issue `conduitxyz/integrations` (suitable public integrator-feedback repo; issues enabled). Email `support@conduit.xyz` **not** sent (task: no Gmail / no email from this task). | — | 2026-09-19 02:35 ET | **BLOCKED** — same `403 createIssue` on `conduitxyz/integrations`; email path skipped by rule |
| Rabby | GitHub Issue `RabbyHub/Rabby` | — | 2026-09-19 02:35 ET | **BLOCKED** — `403 Resource not accessible by personal access token (createIssue)` |

## Unblock

Replace/upgrade `GH_TOKEN` with a **classic** PAT scoped `public_repo` (fine-grained PATs cannot grant Issues write on arbitrary public third-party repos). Then re-run the five creates; drafts remain in [drafts/SOFT_WTP_TARGETS.md](drafts/SOFT_WTP_TARGETS.md).

## Side note

While probing scopes, accidental issue opened on own repo: https://github.com/yellowgram/l2-safety-proxy/issues/4 (`test permission probe — ignore`). Token can `createIssue` there but **not** `closeIssue`/`updateIssue` — please close manually.
