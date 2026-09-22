# GFI draft — Expand offline demo README snippet

**Proposed labels:** `good first issue`, `documentation`

## Problem
Newcomers need a single copy-paste path from clone → `npm test` → offline abort/fail-open proof without Sepolia keys.

## Acceptance criteria
- [ ] README or `docs/DEMO.md` has a “First 5 minutes (offline)” section with exact commands: `npm ci`, `npm test`, `npm run build`, `node scripts/demo-offline.mjs`
- [ ] Notes expected summary lines (`definite-revert abort: PASS`, `fail-open forward: PASS`)
- [ ] Explicitly states: no keys, no Sepolia, no broadcast
- [ ] Link to `docs/SMOKE.md` offline row once present
- [ ] No `src/` behavior changes

## Out of scope
Live RPC, faucet, Docker, new dependencies
