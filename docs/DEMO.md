# Demo — local against public testnets (no secrets)

This demo uses **public** Sepolia RPCs. Do not commit API keys. Copy `.env.example` → `.env` only if you override URLs.

## 1. Install & test

```bash
cd /workspace/blockchain/prototype   # or your clone root
npm install
npm test
npm run build
```

## 2. Run the proxy

```bash
cp .env.example .env   # optional
npm start
# → http://127.0.0.1:8545
```

Health check:

```bash
curl -s http://127.0.0.1:8545/health | jq .
```

Expected: `chains` includes `arb-sepolia`, `op-sepolia`, and `base-sepolia`, `failOpen: true`.

## 3. Pass-through smoke (public RPC)

```bash
# Default chain = arb-sepolia
curl -s http://127.0.0.1:8545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'

# Base Sepolia via header
curl -s http://127.0.0.1:8545 -H 'content-type: application/json' \
  -H 'x-l2sg-chain: base-sepolia' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'

# OP Sepolia via header
curl -s http://127.0.0.1:8545 -H 'content-type: application/json' \
  -H 'x-l2sg-chain: op-sepolia' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

## 4. Send path (simulation)

Point your wallet / viem / ethers **HTTP RPC URL** at `http://127.0.0.1:8545`.

- Broadcasts still use **your** signed txs (guard never sees keys).
- If simulation reports a **definite** revert, you get JSON-RPC error **`-32080`** with `data.l2SendGuard`, `confidence`, and decoded `reason` — tx is **not** forwarded.
- If simulation is uncertain, the tx is **forwarded** (fail-open).

Docker alternative:

```bash
docker compose up --build
```

## 5. What not to do

- Do not put private keys or mnemonic in `.env`
- Do not commit `.env`
- Do not treat simulation as absolute on-chain truth — read `confidence`
