# A1 — Deep research (iteration 1): package inventory + peer gap map

**Date:** 2026-09-24 (America/New_York)  
**Scope:** L2 Send Guard @ `/workspace/l2-safety-proxy` (https://github.com/yellowgram/l2-safety-proxy)  
**External trigger:** AgentKit #1512 comment (Cobra-bit-prog): *“Simulating a send catches definite failures. It does not answer should this address get money at all?”*

---

## 1. Current package inventory (Layer 1 only)

### What exists

| Area | Status |
| --- | --- |
| JSON-RPC proxy intercept of `eth_sendRawTransaction` (+ Sync) | Yes — `src/proxy/handler.ts` |
| Refuse unsigned `eth_sendTransaction` (`-32081`) | Yes — no key custody |
| Parse signed raw tx (viem `parseTransaction`) | Yes — `src/sim/txParse.ts` (`to`, `value`, `data`, `gas`) |
| Sim: prefer `eth_simulateV1` → `eth_call` fallback + capability cache | Yes |
| Abort definite revert (`-32080`) + decoded reason | Yes |
| Fail-open on uncertain (`GUARD_MODE=open` default) / strict (`-32082`) | Yes |
| Multi-L2 day-one: arb / op / base sepolia | Yes |
| SDK provider helpers + agent `check()` wedge | Yes |
| Offline evaluation corpus (310 fixtures) | Yes |
| Address / spend allowlist / caps / human-gate | **Missing** |
| Policy error code distinct from sim abort | **Missing** |
| Config surface for destinations / spend | **Missing** (env is chain/RPC/guard-mode only) |

### Request flow today

```
parse chain → refuse unsigned → (non-send passthrough)
  → validate raw hex
  → simulate
  → definite revert → abort -32080
  → success → forward
  → uncertain → fail_open (open) | abort -32082 (strict)
```

**Gap:** after parse, nothing asks “is this destination / spend amount allowed?” Simulation answers executability, not policy intent.

### Explicit out-of-scope (ARCHITECTURE.md)

> Hosted SaaS, billing, indexing, MEV, tokens, private-key custody, **Safe-enterprise policy engines**.

Layer 2 must stay **thin** and agent-wallet friendly — not clone Safe Policy Engine / session-key module stacks.

---

## 2. Peer inventory (what peers do / don’t)

| Peer | Role vs Send Guard | Policy? | Fail-open? | Notes for Layer 2 |
| --- | --- | --- | --- | --- |
| **OP Security Proxy** | Closest Layer-1 peer (revm local sim, OP Stack) | No allowlist/spend in public grant scope | Yes — ambiguity → forward | Validates Layer-1 problem; we already differentiate multi-L2 + eth_simulateV1 + TS. Layer 2 is orthogonal differentiation. |
| **Tenderly** | Full sim DevOps / alerts | Transaction simulation + monitoring; not a thin local allowlist middleware | N/A (hosted suite) | Too heavy; we remain drop-in in front of existing RPC. |
| **Safe Policy Engine / Guards** | On-chain deny-by-default access control | Full modular policies (allowlist, daily limits, timelock, cosigner) | Fail-closed on-chain | **Overclaim risk** — do not become Safe. Inspiration only: deny-by-default *when policy enabled*, destination + value checks. |
| **ERC-4337 / Smart Sessions (7579)** | Session keys with action policies, spend limits, expiry | Rich per-action / aggregate limits | On-account enforcement | Wrong layer for EOA + raw-tx middleware; optional future hook, not M1. |
| **CDP / AgentKit** | Agent wallet actions (`native_transfer`, erc20) | Some action-level guardrails (e.g. don’t send tokens to token contracts) | Agent signs then broadcasts | #1512 validates need for **policy beside sim**. Best fit: agent points JSON-RPC at Send Guard; policy lives in middleware. |
| **Allowlist RPC proxies / wallet firewalls** | Destination allowlists before broadcast | Yes (often static lists) | Usually fail-closed on deny | Closest UX for Layer 2; keep ours config-driven + caps + optional human-gate hook. |
| **eRPC / Alchemy / QN** | Reliability / RPC cloud | Not spend policy | N/A | Complementary — sit in front. |

### AgentKit #1512 signal (verbatim cut)

- Layer 1: sim catches definite failures.  
- Layer 2: *should this address get money at all?*  
- Within policy = auto · Outside = stop · Operator keeps keys.  
- Founder reply already framed: two layers; sim stays fail-open/definite-only; do not overclaim as full wallet policy.

---

## 3. Gap analysis vs product cut

| Requirement | Gap |
| --- | --- |
| Allowlist destinations | No config or check |
| Per-destination and/or global caps (native value) | No |
| Optional human-gate hook for new/over-cap | No hook surface |
| Outside policy = STOP (do not forward) | Would incorrectly fall under fail-open if naively bolted onto sim path |
| New error code (e.g. `-32083` policy_denied) | Free; `-32080..82` taken |
| Default OFF (don’t break fail-open users) | Need explicit enable + empty/absent config = Layer 1 only |
| Order: prefer policy before sim | Not implemented; sim always runs today |
| ERC20 vs native value decoding | Only native `tx.value` parsed; ERC20 amount in calldata not decoded |
| Multi-chain policy | Chains exist; no per-chain allowlist |

---

## 4. Design constraints carried forward

1. **Semantics split:** Layer 1 uncertain → fail-open (default). Layer 2 deny → definite stop. Never conflate.  
2. **No custody:** still only signed raw txs.  
3. **KISS:** JSON/YAML or env allowlist + caps; optional webhook/CLI hook stub — not a policy DSL.  
4. **Thin:** destination allowlist + value caps + optional “require approval” flag. No Safe/7579 clone.  
5. **Default off:** absent policy config → current behavior unchanged.  
6. **Prefer flow:** `parse → policy → sim → forward` (skip sim cost on denied destinations).

---

## 5. Open questions for A2

1. Global cap vs per-destination cap aggregation (process lifetime? rolling window? single-tx only?)  
2. Contract creation (`to` null) — allow/deny default?  
3. How thin for ERC20: decode `transfer`/`transferFrom` only, or native-only in v1?  
4. Human-gate: sync HTTP hook vs file-drop vs out-of-band (STOP + log only for v1)?  
5. Interaction with `GUARD_MODE=strict` when policy disabled vs enabled.
