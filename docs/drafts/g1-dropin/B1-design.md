# G1 Dual-Layer Agent Drop-in — B1 design lock

**Date:** 2026-09-24 (America/New_York)  
**Package base:** `l2-send-guard` v0.3.0 (Layer 2 merged)  
**Target version:** **0.4.0** (SDK typed errors + health counters + eval `policy_denied` class = API/surface growth)

## Scope (founder greenlight)

| ID | Ship | Out |
| --- | --- | --- |
| G1a | First-class AgentKit / viem wrapper pointing `eth_sendRawTransaction` at Guard | No AgentKit hard dependency; no Soft WTP bump |
| G1b | Agent-tuned `policy.agent.example.json` + offline DEMO for `-32080` **and** `-32083` | Live faucet / funded wallet not required for MVP |
| G1c | 1-page competitive note: *sim ≠ policy* | No Approval-Inbox / Safe clone |
| G1d | Explicit non-goals (Safe / enterprise / custody) | — |
| R3 P0 | Eval `policy_denied`; bypass honesty docs; decision counters + health policy summary | Selector denylist, rolling caps, hot-reload (P1) |
| G2 | Public `SUPPORT.md` SKUs + invoice placeholders | No fake payment links; no core paywall |
| G3 lite | Optional thin `PILOT_SOW.md` skeleton | Not AF grant pack |

## Design decisions

1. **SDK:** Keep URL + `x-l2sg-chain` helpers; add typed error classifiers (`isDefiniteRevert`, `isPolicyDenied`, …) and `createAgentKitTransportTip` docs/example that uses existing `viemHttpArgs` / `createGuardFetch`. Example-only AgentKit wiring — no `@coinbase/agentkit` import.
2. **Policy example:** Separate `policy.agent.example.json` (tight allowlist, native caps, notify-on-deny) so generic `policy.example.json` stays illustrative.
3. **Demo:** Extend offline path — new `scripts/demo-dual-layer.mjs` (or extend offline) that (1) mocks definite revert → `-32080`, (2) enables Layer 2 with empty/mismatched allowlist → `-32083`, neither forwards.
4. **Eval:** Add `policy_denied` decision class; fixtures enable policy + deny before sim; classify maps `decision: policy_denied` → class.
5. **Health:** Process-lifetime counters on send decisions (`abort` / `fail_open` / `forward` / `policy_denied`); `/health` includes `policy: { enabled, destinationCount }` (no addresses) + `decisions`.
6. **Money (G2):** Public USD SKUs; note contact for INR/USDT/Wise; founder-facing INR guidance only in draft notes if needed — public page stays USD + contact.
7. **Rails:** Layer 2 default OFF; policy deny never fail-opens; no key custody; thin middleware only.

## Acceptance

- `npm test` green
- Offline dual-layer demo prints PASS for both error codes
- PR `feat/g1-agent-dropin-support` → `main`, **do not merge** (founder/CoS)
- No Soft WTP posts; no grant packs

## Kill / non-goals reminder

Safe/Zodiac/ERC-7579 clone · Approval-Inbox · hosted SaaS · key custody · Soft WTP bump AgentKit #1512 · AF grant submit.
