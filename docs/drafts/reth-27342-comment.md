## Reproduction: `eth_estimateGas` ignores `--rpc.gascap` (vs `eth_call`)

Reproduced a split against current Reth with `--rpc.gascap` applied:

- **reth version:** `{{RETH_VERSION}}` (`web3_clientVersion`)
- **Payload:** contract-create (`to` omitted), `data = 0x5b600056` (`JUMPDEST PUSH1 0x00 JUMP`)
- **`eth_call`:** errors — `{{ETH_CALL_ERROR}}`
- **`eth_estimateGas`:** succeeds with gas `{{ESTIMATE_GAS}}` which is **greater than** `--rpc.gascap` (`100000`)

This matches the report that `prepare_call_env` / `eth_call` honor `--rpc.gascap`, while `EstimateCall::estimate_gas_with` bounds only on tx gas + block gas limit (unlike Geth’s `DoEstimateGas`, which applies `gasCap`).

### Command

```bash
RETH_BIN=$(which reth) ./scripts/check-rpc-gascap.sh
```

Probe script:  
https://github.com/yellowgram/l2-safety-proxy/blob/main/scripts/check-rpc-gascap.sh

Exit code `2` + `"split": true` in JSON stdout indicates the disagreement.

*(Do not post until placeholders are filled from a live run.)*
