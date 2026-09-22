# Evaluation harness (offline)

Synthetic corpus + runner for L2 Send Guard decision classes. **No live broadcast** (D1 not required).

## Corpus

| | |
| --- | --- |
| **Path** | `evaluation/fixtures/corpus.jsonl` |
| **Size** | 300 fixtures (band 200–500) |
| **Source** | Deterministic generator: `npm run eval:generate` |

Decision classes (weekly METRICS):

| Class | Meaning |
| --- | --- |
| `abort_definite` | Definite revert aborted (`-32080`) |
| `probable` | Uncertain revert → `fail_open` (open) or abort (strict) |
| `forward` | Sim success → forward |
| `infra_abort` | Sim infra failure / throw aborted (strict) |

## Run

```bash
npm install
npm run eval:generate   # refresh corpus.jsonl (committed)
npm run eval            # run offline harness → evaluation/report/latest.{json,md}
```

Optional: `npx tsx evaluation/run.ts --corpus=/abs/path/corpus.jsonl`

## Report fields (METRICS)

- `corpusPath` / `corpusSize`
- `totals.passRate` / `totals.failRate`
- `byDecisionClass.*.passRate|failRate` for each class above
- `offline: true`, `liveBroadcast: false`

## Tests

`tests/evaluation.harness.test.ts` asserts the harness loads the corpus and runs fully offline (mocked simulate/forward).
