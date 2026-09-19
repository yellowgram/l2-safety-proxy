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

## Log

| Week (ET) | Users/teams | Sims | Definite aborts | Fail-opens | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-15 | 0 | 0 | 0 | 0 | Template seeded; offline demo + docs ship. No external users yet. |
| YYYY-MM-DD |  |  |  |  |  |

## Export schema (optional)

```json
{
  "weekStartEt": "2026-09-15",
  "usersTeams": 0,
  "sims": 0,
  "definiteAborts": 0,
  "failOpens": 0,
  "chains": { "arb-sepolia": 0, "op-sepolia": 0, "base-sepolia": 0 },
  "notes": ""
}
```
