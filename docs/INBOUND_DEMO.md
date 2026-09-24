# Inbound demo pack (no keys, no capital)

**Audience:** strangers evaluating L2 Send Guard before asking for paid help.  
**Goal:** reproduce Layer 1 abort (`-32080`) and Layer 2 policy stop (`-32083`) offline in under 10 minutes — or read the expected transcript below without running.

OSS stays free. Paid SKUs (optional): [`SUPPORT.md`](../SUPPORT.md). Pilot skeleton: [`PILOT_SOW.md`](./PILOT_SOW.md). Positioning: [`COMPETITIVE.md`](./COMPETITIVE.md).

---

## Exact commands

```bash
git clone https://github.com/yellowgram/l2-safety-proxy.git
cd l2-safety-proxy
npm install
npm test
npm run build
npm run demo:dual-layer
```

Optional follow-ons (still free / self-hosted):

```bash
npm run demo:offline    # Layer 1 only (abort + fail-open)
npm start               # http://127.0.0.1:8545 — then curl /health
```

Agent wiring (signing stays local — no custody):

- Example: [`examples/agentkit-viem.ts`](../examples/agentkit-viem.ts)
- Policy template: [`policy.agent.example.json`](../policy.agent.example.json)

---

## How to read the error codes

| Code | Meaning | Layer | Fail-open? |
| --- | --- | --- | --- |
| **`-32080`** | Definite-revert **abort** — sim says the signed raw tx will revert; **not** forwarded upstream | 1 (simulation) | No |
| **`-32083`** | **Policy stop** (`policy_denied`) — destination / spend outside Layer 2 allowlist or caps; **not** forwarded | 2 (address/spend) | **Never** (deny is definite) |
| `-32081` | `eth_sendTransaction` refused (no key custody) | — | N/A |
| `-32082` | Uncertain sim aborted because `GUARD_MODE=strict` | 1 | No (strict only) |

On aborts, inspect `error.data`: `decision`, `confidence` / `certainty`, `chainId`, `layer`, `decoded` (Layer 1) or `policyCode` / `hint` (Layer 2). Success / fail-open forwards may attach the same shape under JSON-RPC extension `l2sg`.

**Honesty:** simulation ≠ on-chain truth. Layer 2 allowlist does **not** unwind `approve` / Permit2 / multicall — see [ARCHITECTURE.md](../ARCHITECTURE.md#what-layer-2-is-not).

---

## Expected dual-layer transcript (captured 2026-09-24 ET)

Run after `npm run build`. No public RPC, keys, or capital required.

```text
> l2-send-guard@0.4.0 demo:dual-layer
> node scripts/demo-dual-layer.mjs

L2 Send Guard — dual-layer offline demo (-32080 + -32083; no keys, no capital)

=== 1) Layer 1 definite-revert ABORT (-32080) ===
health.policy: {"enabled":false,"destinationCount":0,"allowAnyDestination":false,"allowContractCreation":false,"hasGlobalMaxNativeWei":false,"erc20RecipientCheck":false,"notifyConfigured":false}
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32080,
    "message": "L2 Send Guard: abort — demo: definite revert",
    "data": {
      "l2SendGuard": true,
      "decision": "abort",
      "confidence": "eth_call",
      "certainty": "definite",
      "chainId": 421614,
      "simMethod": "eth_call",
      "layer": 1,
      "aborted": true,
      "failOpen": false,
      "reason": "demo: definite revert",
      "code": "DEFINITE_REVERT",
      "decoded": {
        "reason": "demo: definite revert",
        "kind": "string",
        "selector": "0x08c379a0"
      }
    }
  }
}
upstream eth_sendRawTransaction calls: 0

=== 2) Layer 2 policy STOP (-32083) ===
health.policy: {"enabled":true,"destinationCount":1,"allowAnyDestination":false,"allowContractCreation":false,"hasGlobalMaxNativeWei":false,"erc20RecipientCheck":true,"notifyConfigured":false}
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32083,
    "message": "L2 Send Guard: policy_denied — destination 0x0000000000000000000000000000000000000001 not on Layer 2 allowlist",
    "data": {
      "l2SendGuard": true,
      "decision": "policy_denied",
      "confidence": "unknown",
      "certainty": "definite",
      "chainId": 421614,
      "simMethod": "unavailable",
      "layer": 2,
      "aborted": true,
      "failOpen": false,
      "reason": "destination 0x0000000000000000000000000000000000000001 not on Layer 2 allowlist",
      "code": "DESTINATION_NOT_ALLOWLISTED",
      "policyCode": "DESTINATION_NOT_ALLOWLISTED",
      "to": "0x0000000000000000000000000000000000000001",
      "value": "0x0",
      "hint": "Update Layer 2 policy allowlist/caps or disable L2SG_POLICY_ENABLED. Operator keeps keys."
    }
  }
}
upstream eth_sendRawTransaction calls: 0

--- summary ---
-32080 definite-revert abort: PASS
-32083 policy_denied stop:    PASS

Demo OK — Layer 1 aborts definite reverts; Layer 2 policy never fail-opens.
```

**PASS lines to look for:** `-32080 definite-revert abort: PASS` and `-32083 policy_denied stop: PASS`. Upstream send count must stay `0` in both slices.

---

## Next steps if it fits

1. Try AgentKit / viem drop-in (`examples/agentkit-viem.ts` + `policy.agent.example.json`).
2. Compare vs hosted policy engines: [`COMPETITIVE.md`](./COMPETITIVE.md).
3. Want hands-on wire-up or a policy pack review? [`SUPPORT.md`](../SUPPORT.md) — reply on **GitHub Issues / Discussions**, or email `CONTACT_EMAIL_TBA` when published. Do not invent payment links; founder invoices after scope is confirmed ([`PILOT_SOW.md`](./PILOT_SOW.md)).

Income / kill clock (internal): [`INCOME_GATE.md`](./INCOME_GATE.md).
