# Weekly metrics (CoS report)

**Purpose:** honest, auditable weekly snapshot for Chief of Staff / founder review.  
**Rules:** never invent users or sims; prefer `0` over guesses; no PII, keys, or funded addresses.

Raw exports (optional CSV/JSON) go in [`docs/metrics/`](./metrics/) — keep filenames like `2026-W38.json`.

## How to count

| Field | Meaning |
| --- | --- |
| **Week** | ISO week or `YYYY-MM-DD` start (America/New_York) |
| **Users / teams** | Distinct external integrators or teams with repeated use (not local mock tests). Anonymize. |
| **Sims** | Count of guarded `eth_sendRawTransaction` simulations observed (proxy logs / metrics export). Exclude unit-test runs unless labeled `test-only`. |
| **Definite aborts** | Sims that returned `-32080` / `aborted: true` |
| **Fail-opens** | Uncertain sims forwarded upstream |
| **Notes** | Demo refreshes, SEO edits, blockers — one line |
| **Eval corpus path** | Repo-relative path to offline fixture corpus (e.g. `evaluation/fixtures/corpus.jsonl`) |
| **Eval corpus size** | Fixture count (target 200–500) |
| **Eval pass/fail by class** | Rates for `abort_definite` / `probable` / `forward` / `infra_abort` from `npm run eval` |
| **Broadcast hashes** | Public success send hashes (needs D1) — else `0` / none |
| **Agent decisions** | Count from internal agent loop (needs D2) — else `0` |
| **Buildathon** | `ON-TRACK` \| `AT-RISK` \| `SKIP` |
| **Freeze breaches** | Always `0` or list; must stay `0` |

## Log

| Week (ET) | Users/teams | Sims | Definite aborts | Fail-opens | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-15 | 0 | 0 | 0 | 0 | CoS GO 2026-09-19: CI + GFI issues + soft-WTP drafts; offline demo verified. No external users yet. |
| 2026-09-22 | 0 | 1+ (Base abort) | 1 live Base abort | 0 | Delta A+C: burner `0xB055…dFA0`; faucet blocked (0 broadcast hashes); agent decisions=200 (`docs/agent-decisions.jsonl`); eval corpus=310; freezeBreaches=0; Buildathon=AT-RISK |

## Export schema (optional)

```json
{
  "weekStartEt": "2026-09-15",
  "usersTeams": 0,
  "sims": 0,
  "definiteAborts": 0,
  "failOpens": 0,
  "chains": { "arb-sepolia": 0, "op-sepolia": 0, "base-sepolia": 0 },
  "evalCorpusPath": "evaluation/fixtures/corpus.jsonl",
  "evalCorpusSize": 0,
  "evalByDecisionClass": {
    "abort_definite": { "n": 0, "passRate": 0, "failRate": 0 },
    "probable": { "n": 0, "passRate": 0, "failRate": 0 },
    "forward": { "n": 0, "passRate": 0, "failRate": 0 },
    "infra_abort": { "n": 0, "passRate": 0, "failRate": 0 }
  },
  "broadcastHashes": [],
  "agentDecisions": 0,
  "buildathon": "AT-RISK",
  "freezeBreaches": 0,
  "notes": ""
}
```
