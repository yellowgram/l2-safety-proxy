# D2 — Second code review (after D1 must-fixes)

**Date:** 2026-09-24  
**Follow-up to:** D1-code-review.md

---

## D1 must-fix status

| ID | Status |
| --- | --- |
| M1 Wire policy into `check` / `checkWithConfig` | **Done** — `CheckOptions.policy`, `checkWithConfig` applies `config.policy`; returns `policy_denied` + `layer: 2`; test added |
| M2 Double `parseWei` in load.ts | **Done** |
| M3 `loadSpendPolicy` unit tests | **Done** — `tests/policy.load.test.ts` (default / env / file+env) |
| S1 Indentation | **Done** |
| S2 AGENTS.md | **Done** |
| S3 CheckResult layer/policyCode | **Done** |

---

## New review findings

| ID | Issue | Severity | Action |
| --- | --- | --- | --- |
| D2-1 | `shapeKeys` / agent API now always includes `layer` — minor breaking for consumers asserting exact key sets | Low | Documented by tests; acceptable in 0.3.0 minor |
| D2-2 | `check()` without policy still Layer-1-only — intentional; callers must pass policy or use `checkWithConfig` | Info | Keep; docs note |
| D2-3 | No hot-reload / no rolling caps | Info | Locked P2 — out of scope |
| D2-4 | Handler still swallows parse errors into Layer 1 path when policy on | OK | Matches B3 |

## Residual risks (accepted)

- ERC20 amount not capped; approve/multicall bypass if operator allowlists routers
- Notify webhook SSRF is operator-configured
- Process-lifetime config only (restart to reload)

## Verdict

**Approve with nits** — no further must-fixes. Proceed to D3 consolidation + push.
