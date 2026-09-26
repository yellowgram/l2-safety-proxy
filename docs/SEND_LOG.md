# Send Guard evidence log

Runtime decision JSONL (what to grep in production) is specified in [DECISION_LOG.md](./DECISION_LOG.md): one JSON object per line, including `policy_denied`, `fail_open`, `abort`, and `chainId`. Set `L2SG_DECISION_LOG` to enable it. The tables below are historical evidence, not that schema.



Columns: `ts` · `chain` · `mode` · `decision` · `confidence` · `txHash|simId` · `notes`

**Policy:** no invented hashes. Live forward broadcast hashes require Sepolia ETH; if faucet blocks, log and stop that slice.

## Counts

| Slice | Count |
| --- | --- |
| Local / mocked sim rows | 24 |
| Live Arb Sepolia abort rows (simId) | 5 |
| Live Base Sepolia abort rows (simId) | **1** (Delta A 2026-09-22) |
| Live broadcast tx hashes (success receipt) | **1** (Arb Sepolia 2026-09-22 via Guard proxy) |

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
| 2026-09-22T12:22:12 ET | arb-sepolia | open | forward | eth_call | `0xcb430b1551af27e407ab80c2d01c53ce052ba501e983725426431c421b7caac4` | SUCCESS-PATH self-transfer value=0 via Guard proxy; receipt status=1 (0x1); block=311608205; gasUsed=22086; burner=0x2C9c87139D41C6cE90c6c6A39Fe0C4bd64d3108D; balanceBefore=0.001 ETH (RPC-verified); explorer=https://sepolia.arbiscan.io/tx/0xcb430b1551af27e407ab80c2d01c53ce052ba501e983725426431c421b7caac4 |

### Success-path forward broadcast (Arb Sepolia — 2026-09-22)

| Field | Value |
| --- | --- |
| burner (public) | `0x2C9c87139D41C6cE90c6c6A39Fe0C4bd64d3108D` |
| path | Guard proxy (`eth_sendRawTransaction` → decision=forward, certainty=definite, simMethod=eth_call) |
| txHash | `0xcb430b1551af27e407ab80c2d01c53ce052ba501e983725426431c421b7caac4` |
| receipt status | **1** (`0x1` success) |
| blockNumber | 311608205 |
| gasUsed | 22086 |
| explorer | https://sepolia.arbiscan.io/tx/0xcb430b1551af27e407ab80c2d01c53ce052ba501e983725426431c421b7caac4 |
| note | Faucet funded 0.001 ETH verified on public Arb Sepolia RPC (`eth_getBalance` → `0x38d7ea4c68000`). Minimal EIP-1559 self-transfer (to=self, value=0). Real hash only — no invented hashes. Machine-readable: [`docs/success-path-evidence.json`](./success-path-evidence.json) (local). |

## Live Base Sepolia — Delta A (2026-09-22)

**Burner address (public):** `0xB055a37C207EbC1F7BD882353d513303B577dFA0`  
**Private key:** stored only in local gitignored `.env` as `L2SG_BURNER_KEY` — **never committed**.

### Definite-abort (sim-only, not broadcast)

| ts | chain | mode | decision | confidence | txHash\|simId | notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-22T11:42:42 ET | base-sepolia | open | abort | eth_call | `sim:0x0af1f8557e542856aa8335eb08c32e00c269ff9c45583ca62036adee5627e5c0` | live abort via Guard proxy; certainty=definite; decoded=execution reverted; code=-32080 |

Reproduce: `npm run build && npm run demo:delta-a` (requires `.env` with `L2SG_BURNER_KEY`).

### Success-path forward broadcast

| Field | Value |
| --- | --- |
| txHash | — (none) |
| receipt status | — |
| note | FAUCET BLOCKED — all public drips failed/suspended/captcha. Forward live-hash slice STOPPED. No invented hashes. |

**Feasibility:** public faucet drips for Base/Arb/OP Sepolia are blocked for headless agents (triangle 503 Service Suspended ×2 on Base; Arb 503; OP Cloudflare 429; Chainlink captcha 400; LearnWeb3 503; QuickNode HTML-only). No CDP/Alchemy API keys in environment. **No invented hashes.** Forward live-hash remains blocked until a human faucet drip or CDP key funds the burner.

### Faucet attempt log (Delta A)

| ts | faucet | chain | status | note |
| --- | --- | --- | --- | --- |
| 2026-09-22T11:42:34 ET | triangle-base | base-sepolia | 503 | HTTP 503 <!DOCTYPE html> <html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-widt |
| 2026-09-22T11:42:34 ET | triangle-base-retry | base-sepolia | 503 | HTTP 503 <!DOCTYPE html> <html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-widt |
| 2026-09-22T11:42:34 ET | triangle-arb | arb-sepolia | 503 | HTTP 503 <!DOCTYPE html> <html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-widt |
| 2026-09-22T11:42:34 ET | triangle-op | op-sepolia | 429 | HTTP 429 <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content= |
| 2026-09-22T11:42:35 ET | chainlink | base-sepolia | 400 | HTTP 400 {"success":false,"message":"Could not verify if you are human."} |
| 2026-09-22T11:42:35 ET | quicknode-page | base-sepolia | 200 | HTTP 200 <!DOCTYPE html><!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" content="width |
| 2026-09-22T11:42:35 ET | learnweb3 | base-sepolia | 503 | HTTP 503 <!DOCTYPE html> <html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-widt |

Machine-readable evidence: [`docs/delta-a-evidence.json`](./delta-a-evidence.json).

## Reproduce

```bash
npm run build
node scripts/gen-send-log-local.mjs   # local ≥20
npm run demo:sepolia                  # live abort (+ forward if funded)
node scripts/live-send-log.mjs        # live abort batch + faucet attempt
```


## Soft WTP (founder-sent)

| # | target | URL | date ET | status | notes |
| --- | --- | --- | --- | --- | --- |
| 1/5 | Coinbase AgentKit | https://github.com/coinbase/agentkit/issues/1512 | 2026-09-22 | **SENT** (founder) | Do **not** bump unless they reply |
| 2/5 | Safe{Core} SDK | https://github.com/safe-global/safe-core-sdk/discussions/1437 | 2026-09-22 | **SENT** (founder) | Discussion; do **not** bump |

**Hold:** Soft WTP 3–5 not sent. Freeze/grants still off.
