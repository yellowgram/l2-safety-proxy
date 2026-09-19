# Send Guard evidence log

Columns: `ts` · `chain` · `mode` · `decision` · `confidence` · `txHash|simId` · `notes`

**Policy:** no invented hashes. Live forward broadcast hashes require Sepolia ETH; if faucet blocks, log and stop that slice.

## Counts

| Slice | Count |
| --- | --- |
| Local / mocked sim rows | 24 |
| Live Arb Sepolia abort rows (simId) | 5 |
| Live Arb Sepolia broadcast tx hashes | **0** (faucet blocked) |

## Local / sim

| ts | chain | mode | decision | confidence | txHash\|simId | notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | abort | eth_call | `0x08c379a000000000` | local abort revert #1 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | abort | eth_call | `0x08c379a000000000` | local abort revert #2 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | abort | eth_call | `0x08c379a000000000` | local abort revert #3 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | abort | eth_call | `0x08c379a000000000` | local abort revert #4 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | abort | eth_call | `0x08c379a000000000` | local abort revert #5 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | abort | eth_call | `0x08c379a000000000` | local abort revert #6 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | abort | eth_call | `0x08c379a000000000` | local abort revert #7 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | abort | eth_call | `0x08c379a000000000` | local abort revert #8 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | fail_open | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82ccd1` | local fail_open glitch #1 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | fail_open | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82cd61` | local fail_open glitch #2 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | fail_open | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82cdf1` | local fail_open glitch #3 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | fail_open | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82ce91` | local fail_open glitch #4 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | fail_open | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82cf21` | local fail_open glitch #5 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | fail_open | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82cfc1` | local fail_open glitch #6 |
| 2026-09-19T09:08:18 ET | arb-sepolia | strict | abort | eth_call | `sim-local strict abort glitch #1` | local strict abort glitch #1 |
| 2026-09-19T09:08:18 ET | arb-sepolia | strict | abort | eth_call | `sim-local strict abort glitch #2` | local strict abort glitch #2 |
| 2026-09-19T09:08:18 ET | arb-sepolia | strict | abort | eth_call | `sim-local strict abort glitch #3` | local strict abort glitch #3 |
| 2026-09-19T09:08:18 ET | arb-sepolia | strict | abort | eth_call | `sim-local strict abort glitch #4` | local strict abort glitch #4 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | forward | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82d221` | local forward ok #1 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | forward | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82d2a1` | local forward ok #2 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | forward | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82d321` | local forward ok #3 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | forward | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82d3a1` | local forward ok #4 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | forward | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82d421` | local forward ok #5 |
| 2026-09-19T09:08:18 ET | arb-sepolia | open | forward | eth_call | `0x00000000000000000000000000000000000000000000000000001a0b9c82d4c1` | local forward ok #6 |

## Live Arb Sepolia

| ts | chain | mode | decision | confidence | txHash\|simId | notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-19T09:07:17 ET | arb-sepolia | open | abort | eth_call | `sim:0x9da4deea7bb54261ae6eca2dcf94d6d9a7842e62ac425f76d8edac90fd4558fe` | live abort #1 decoded=execution reverted (no data) code=-32080 |
| 2026-09-19T09:07:17 ET | arb-sepolia | open | abort | eth_call | `sim:0x3aed5c539200987df62ca4fc247d7288a4f47d3120f2141fc38186c806109c99` | live abort #2 decoded=execution reverted (no data) code=-32080 |
| 2026-09-19T09:07:17 ET | arb-sepolia | open | abort | eth_call | `sim:0x05fe205a97639472b9f1bcfca92c07982213a2a89c7dbc46ecc48ab2d4c2bf42` | live abort #3 decoded=execution reverted (no data) code=-32080 |
| 2026-09-19T09:07:18 ET | arb-sepolia | open | abort | eth_call | `sim:0xa69a9e6cdb7a8e8da80cf6cfcc8f88c4ca69033bbbd7b6adfc770d22e364facc` | live abort #4 decoded=execution reverted (no data) code=-32080 |
| 2026-09-19T09:07:18 ET | arb-sepolia | open | abort | eth_call | `sim:0x9d146b8e8e9a4525c07dc8062fc02002c25ff1efb26f3f212f014eb7594d069d` | live abort #5 decoded=execution reverted (no data) code=-32080 |
| 2026-09-19T09:07:51 ET | arb-sepolia | open | n/a | n/a | — | FAUCET BLOCKED — triangle HTTP 503 Service Suspended; learnweb3 HTML-only (no drip API). Forward live-hash slice STOPPED. No invented hashes. Abort live simIds above are keccak256(signed raw) against public Arb Sepolia RPC (not broadcast). |

## Reproduce

```bash
npm run build
node scripts/gen-send-log-local.mjs   # local ≥20
npm run demo:sepolia                  # live abort (+ forward if funded)
node scripts/live-send-log.mjs        # live abort batch + faucet attempt
```

