# GFI draft — Extra unit cases for `isGascapSplit`

**Proposed labels:** `good first issue`, `tests`

## Problem
`scripts/gascap-split.mjs` helper is covered by `tests/gascap-probe.test.ts` with the core matrix; edge cases (NaN gas, negative gas, cap=0) would harden the probe.

## Acceptance criteria
- [ ] Add ≥3 vitest cases in `tests/gascap-probe.test.ts` for: `gas: NaN`, `gas: -1`, `cap: 0` with estimate ok / call fail
- [ ] `npx vitest run tests/gascap-probe.test.ts` passes
- [ ] No changes to `src/**` or to shell probe behavior
- [ ] Do not add npm dependencies

## Out of scope
Spawning Reth, Docker, posting on upstream issues
