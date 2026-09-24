# Pilot SOW skeleton (G3 lite)

**Not an AF / ESP grant pack.** Use this when an inbound team wants a fixed pilot invoice for Guard dual-layer drop-in.

| Field | Fill in |
| --- | --- |
| **Customer** | |
| **Primary contact** | |
| **Chains** | e.g. Arb / Base / OP Sepolia → mainnet later |
| **Agent stack** | AgentKit / viem / ethers / other |
| **SKU / price** | See [SUPPORT.md](../SUPPORT.md) or custom USD/INR |
| **Invoice path** | USDT / Wise / Razorpay (details on invoice) |
| **Start date** | |
| **End date** | |

## Deliverables (edit)

- [ ] Guard proxy running in customer env (docker or `npm start`) in front of their RPC  
- [ ] Agent transport points `eth_sendRawTransaction` at Guard (`examples/agentkit-viem.ts` pattern)  
- [ ] Layer 2 policy file reviewed / tuned (or explicitly left OFF)  
- [ ] Offline or Sepolia proof of `-32080` and (if policy ON) `-32083`  
- [ ] Short handoff note (runbooks + residual bypass honesty)

## Success metrics (blanks)

| Metric | Baseline | Target | Notes |
| --- | --- | --- | --- |
| Definite-revert aborts observed | | | from `/health` decisions or SEND_LOG |
| Policy stops (`policy_denied`) | | | 0 if Layer 2 OFF |
| Fail-open rate (uncertain) | | | should remain fail-open in `GUARD_MODE=open` |
| False-block incidents | | | customer-reported |

## Acceptance

Pilot **accepted = paid** (or written waiver). OSS usage without a pilot remains free.

## Non-goals

Custody · Safe-clone · hosted SaaS · grant submission theater.
