# D1 — Expert code review (PR #6 / feat/layer2-spend-policy)

**Persona:** Wallet middleware + agent security reviewer  
**SHA:** 5339954  
**Date:** 2026-09-24

---

## Summary

Layer 2 design matches B3: default off, `-32083`, parse→policy→sim→forward, native caps, ERC20 recipient check, fire-and-forget notify. Tests cover the critical paths. Several must-fixes before merge trust is high.

---

## Must-fix

| ID | Issue | Severity |
| --- | --- | --- |
| M1 | **`check()` / `checkWithConfig` bypass Layer 2** — agents using the dry-run API never see `policy_denied`; only the HTTP proxy enforces policy. Wire policy into `checkWithConfig` (and optional `policy` on `CheckOptions`). | High |
| M2 | **`load.ts` double `parseWei`** on chain overlays — call once; also avoids double-throw edge confusion. | Low |
| M3 | **No unit test for `loadSpendPolicy`** (file + env merge, enable flag). Regression risk on config footguns. | Med |
| M4 | **Handler over-cap path untested with non-zero value raw tx** — unit evaluate covers OVER_CAP; add one handler-level test using mocked parse path or synthetic PolicyCheck via evaluate is OK but document; prefer injecting a raw with value or testing via evaluate-only acknowledgment. *Accept evaluate coverage; add load test instead as M3.* | Low → absorb into M3 |

## Should-fix

| ID | Issue |
| --- | --- |
| S1 | Test file indentation after `policy: defaultSpendPolicy()` lines is inconsistent |
| S2 | `docs/AGENTS.md` should mention Layer 2 one-liner |
| S3 | `CheckResult` could include optional `layer` / `policyCode` for agents |

## Nits / non-blocking

- `notify` uses `AbortSignal.timeout` (Node ≥20 — matches engines)
- Multicall / approve bypass documented in B3 — residual risk accepted
- SSRF via operator `notifyUrl` — operator trust model OK
- Version bump 0.3.0 appropriate

## What looks good

- Fail-open never applied to policy denies (tested)
- Simulate not called on deny (tested)
- Default disabled preserves 76+ legacy tests
- Clear error meta (`layer: 2`, `policyCode`, hint)
- No new deps; viem-only ERC20 decode

## Verdict

**Request changes** — address M1–M3, then re-review (D2).
