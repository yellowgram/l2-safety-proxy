# Sim ≠ policy — competitive note (1 page)

**Audience:** AgentKit / CDP / bot integrators comparing pre-broadcast guards.  
**Product:** [L2 Send Guard](https://github.com/yellowgram/l2-safety-proxy) — self-hosted JSON-RPC middleware.

## Two different questions

| Layer | Question | Guard behavior | Typical hosted “agent policy” |
| --- | --- | --- | --- |
| **1 — Simulation** | Will this signed raw tx **definitely revert**? | Abort `-32080` on definite revert; **fail-open** (default) when uncertain | Often **absent** — policy engines do not replace `eth_simulateV1` / `eth_call` |
| **2 — Address/spend policy** | **Should** this destination get value / be called? | Optional allowlist + native caps → `-32083` STOP (never fail-open). **Default OFF** | Hosted allowlist / `ethValue` caps at sign or send time |

**Simulation is not policy.** A tx can simulate cleanly and still be the wrong destination. A destination can be allowlisted and still revert on-chain. Guard runs **both thin layers** in one self-hosted hop when you enable Layer 2.

## Positioning

| Product shape | What it optimizes | Relation to Guard |
| --- | --- | --- |
| **L2 Send Guard** | Definite-revert abort + optional local allowlist/caps; multi-L2 Sepolia; no key custody | **This repo** |
| **Agent Control** (and similar hosted policy UX) | Human/approval inbox + hosted policy for agent wallets | Policy-shaped; **not** a drop-in sim middleware. We do **not** clone Approval-Inbox / Safe |
| **CDP Policy Engine** | Coinbase Developer Platform wallet allowlist / `ethValue` at sign/send | **Complement** — use CDP for CDP-custodied wallets; put Guard in front of **self-hosted / local-sign / non-CDP** RPC paths for Layer 1 sim + portable Layer 2. **We do not replace CDP** |
| **Tenderly / full sim suites** | Deep DevOps simulation | Heavier; Guard stays thin middleware |
| **Safe / Zodiac / session keys** | On-chain / account policy | Wrong layer — out of wedge |

## What we deliberately do not ship

- Safe / enterprise policy engine / Approval-Inbox clone  
- Key custody or unlocking `eth_sendTransaction`  
- Hosted SaaS billing before an explicit traction gate  
- Claiming Layer 2 closes approve / Permit2 / multicall residuals (see ARCHITECTURE “What Layer 2 is not”)

## Drop-in proof

```bash
npm test && npm run build
npm run demo:dual-layer   # offline: -32080 + -32083
```

Full inbound pack (commands + expected PASS transcript): [`INBOUND_DEMO.md`](./INBOUND_DEMO.md).

Agent wiring: [`examples/agentkit-viem.ts`](../examples/agentkit-viem.ts), [`src/sdk/README.md`](../src/sdk/README.md).

**Paid help (optional):** fixed SKUs and how to reply — [`SUPPORT.md`](../SUPPORT.md). Pilot blanks: [`PILOT_SOW.md`](./PILOT_SOW.md). OSS core stays free; no fake checkout URLs.
