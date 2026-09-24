# B2 — Critique + redesign (agent security persona)

**Persona:** Agent-wallet security engineer  
**Critiques:** B1-design.md  
**Date:** 2026-09-24

---

## 1. Critique of B1

| Issue | Severity | Redesign |
| --- | --- | --- |
| Fail-open confusion: `certainty: definite` on policy but `confidence: unknown` looks like sim | Med | Add `layer: 2`; set `confidence` n/a field `policy: true`; omit simMethod or set `policy` |
| Custody creep via notifyUrl blocking | High | **Must** be fire-and-forget with short timeout; never await in send path beyond 50ms best-effort race — better: `void notify()` no await |
| ERC20 amount caps without decimals | High footgun | **Native-only caps** in locked design; ERC20 decode only for **recipient allowlist**. Document explicitly |
| Multi-chain: one global allowlist wrong for agents on 3 L2s | Med | Policy JSON optional `chains: { "arb-sepolia": { destinations... }, "default": {...} }` with fallback to top-level destinations |
| Parse fail before policy | Low | Keep: unparseable → existing sim/uncertain path (don’t invent policy on garbage) |
| Empty allowlist refuse-to-start may break “deny all” intentional lockdown | Med | Allow empty if `denyAll: true` explicit OR `allowAnyDestination`; else refuse. Simpler: empty + enabled = **deny all** (safe lockdown) — document; open destinations need `allowAnyDestination: true` |
| Startup refuse vs deny-all | — | **CHANGE:** enabled + empty + !allowAny = **deny-all** (safe), no throw — agents can lockdown without listing |
| `NEEDS_APPROVAL` vs not allowlisted | Low | Keep distinct codes; both STOP |
| Config: wei-only easy to mis-set | Med | Accept `globalMaxNativeWei` string; also `globalMaxNativeEth` number → parseEther at load; reject both set |
| Handler still calls simulate with raw string before parse visible | — | Export parse in handler: parse once → policy(input) → simulate(raw) |

---

## 2. Redesigned evaluation order (locked for B2)

```
1. resolve chain
2. refuse unsigned / passthrough non-send
3. validate hex raw
4. try parseRawTransaction
   - on throw: treat as uncertain sim path (existing) — no policy
5. if policy.enabled:
     result = evaluate(policyForChain, { to, value, data })
     if !result.allow → notify void; return -32083
6. simulate(raw)
7. Layer 1 decisions unchanged
```

---

## 3. Multi-chain config (redesign)

```json
{
  "enabled": true,
  "allowContractCreation": false,
  "allowAnyDestination": false,
  "globalMaxNativeWei": "100000000000000000",
  "destinations": {
    "0xabc...": { "maxNativeWei": "1" }
  },
  "chains": {
    "base-sepolia": {
      "globalMaxNativeWei": "50000000000000000",
      "destinations": {
        "0xdef...": {}
      }
    }
  },
  "erc20RecipientCheck": true,
  "humanGate": { "mode": "stop", "notifyUrl": null }
}
```

Resolution: `chains[chainKey] ?? chains[String(chainId)]` overlays top-level defaults (destinations merge: chain-specific replaces top-level map when present).

---

## 4. ERC20 rules (clarified)

When `erc20RecipientCheck` true (default true if policy enabled):

- If `data` selector is `transfer(address,uint256)` (0xa9059cbb) or `transferFrom(address,address,uint256)` (0x23b872dd):
  - Extract recipient
  - Policy destination check applies to **recipient**, not token `tx.to`
  - Native `value` still subject to native caps (usually 0)
  - **No ERC20 amount cap** in this version
- Otherwise: destination check on `tx.to` (contract interaction allowlist)

Warning in docs: allowlisting a router/multicall is **not** destination safety.

---

## 5. Fail-open vs policy (hard rule)

```
policy deny  → decision=policy_denied, failOpen=false, code=-32083
sim uncertain + open → decision=fail_open
sim definite revert → decision=abort, code=-32080
```

Automated test: policy deny never yields `fail_open` even when `GUARD_MODE=open`.

---

## 6. What B2 kills from B1

- ERC20 amount capping  
- Blocking human gate  
- Startup throw on empty allowlist (replace with deny-all)  
- Omitting multi-chain overlay  

## What B2 keeps

- Default OFF  
- parse → policy → sim → forward  
- `-32083`  
- Fire-and-forget notify  
- Native wei caps + optional eth alias at load  
- KISS modules under `src/policy/`
