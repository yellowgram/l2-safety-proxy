# Decision log (JSONL)

Optional. Set `L2SG_DECISION_LOG` to a file path. Each send decision appends one JSON object and a newline. Unset means the proxy writes nothing.

Grep the file for `policy_denied`, `fail_open`, `abort`, `chain_mismatch`, or `unsigned_refused`. The proxy does not log the raw transaction or the allowlist.

```json
{
  "ts": "2026-09-26T00:00:00.000Z",
  "decision": "policy_denied",
  "code": -32083,
  "chainId": 421614,
  "chainKey": "arb-sepolia",
  "layer": 2,
  "policyCode": "DESTINATION_NOT_ALLOWLISTED",
  "certainty": "definite",
  "confidence": "unknown",
  "failOpen": false,
  "method": "eth_sendRawTransaction"
}
```

| Field | Values |
| --- | --- |
| `decision` | `abort`, `fail_open`, `forward`, `policy_denied`, `unsigned_refused`, `chain_mismatch` |
| `code` | JSON-RPC code, or `null` on forward / fail-open success |
| `chainId` | Selected chain (header or default) |
| `chainKey` | Template key (`arb-sepolia`, `op-sepolia`, `base-sepolia`) |
| `layer` | `1` simulation, `2` policy, `null` otherwise |
| `policyCode` | Layer 2 code such as `DESTINATION_NOT_ALLOWLISTED` or `TX_UNPARSEABLE`, or `null` |
| `certainty` | `definite` or `uncertain` |
| `confidence` | `simulate_v1`, `eth_call`, or `unknown` |
| `failOpen` | `true` only when an uncertain sim was forwarded |
| `method` | JSON-RPC method |
| `signedChainId` | Present on `chain_mismatch` only |

`/health` `decisions` counters are process-lifetime totals for the same decision names. They reset on restart. The JSONL file does not.

You choose retention. Guard does not ship a log sink.
