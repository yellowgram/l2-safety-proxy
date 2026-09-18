# Sepolia live smoke

**Run time:** 2026-09-18 16:22–16:24 EDT  
**Result:** PASS for proxy startup, health, and read-only RPC forwarding; the guarded-send attempt was safely not broadcast and exposed a live `eth_simulateV1` compatibility limitation.

## Configuration

- Created a local, gitignored `.env` from `.env.example`.
- Configured the public, no-key endpoints by name:
  - **Arbitrum Sepolia public RPC:** `https://sepolia-rollup.arbitrum.io/rpc`
  - **Base Sepolia public RPC:** `https://sepolia.base.org`
- No API keys, user private keys, funded accounts, or mainnet endpoints were used. `.env` was not committed.

## Checks run

The proxy was built with `npm run build` and started locally at `http://127.0.0.1:8545`.

| Check | Result |
| --- | --- |
| `GET /health` | **PASS** — `ok: true`, chains `arb-sepolia,base-sepolia`, default `arb-sepolia`, `failOpen: true` |
| `eth_chainId` via proxy, default Arb chain | **PASS** — `0x66eee` (421614) |
| `eth_blockNumber` via proxy, default Arb chain | **PASS** — `0x127ec8a4` (310298788 at capture) |
| `eth_chainId` via proxy with `x-l2sg-chain: base-sepolia` | **PASS** — `0x14a34` (84532) |
| `eth_blockNumber` via proxy with Base header | **PASS** — `0x2cd1f5f` (46997343 at capture) |

The same read-only calls also succeeded directly against both named public endpoints. No rate limiting or HTTP failures occurred during this run.

## Safe revert/simulation attempt

To exercise the guarded send path without capital, an ephemeral, unfunded signer was created in memory and discarded after the request. It signed a zero-value EIP-1559 transaction for Base Sepolia with:

- target: Base Sepolia USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`)
- calldata: `0xdeadbeef` (a known-reverting selector for this contract)
- value: `0`
- no transaction was broadcast

As a control, the equivalent `eth_call` through the proxy returned the expected upstream JSON-RPC error `code: 3, message: execution reverted`.

The `eth_sendRawTransaction` guard attempt reached the simulation path, but Base Sepolia returned `-32602 Invalid params` for the proxy's `eth_simulateV1` request. The guard correctly classified that as uncertain and fail-opened; the subsequent upstream send was rejected for insufficient funds (`-32003`). This is a **safe outcome**: no funds existed and no transaction hash was returned. It is not evidence that the definite-revert abort branch fired.

## Limitations / follow-up

- Public RPC behavior and rate limits can change. This run saw no rate limiting.
- The Base Sepolia endpoint's current `eth_simulateV1` parameter behavior is incompatible with the proxy's expected request shape, so this live run did not produce the intended `-32080` definite-revert guard response.
- The unit and mocked integration tests cover the definite-revert abort branch; a future live check should be repeated after upstream `eth_simulateV1` compatibility is resolved (or with an endpoint that supports the expected shape).
- The smoke used only read calls and a deliberately unfunded, zero-value simulation request; no private key was stored or committed and no mainnet value transfer was attempted.
