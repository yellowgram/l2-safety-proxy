#!/usr/bin/env bash
# Prove paradigmxyz/reth#27342: eth_call honors --rpc.gascap; eth_estimateGas may not.
# No keys. No broadcast. No Sepolia.
set -euo pipefail

RPC_GASCAP="${RPC_GASCAP:-100000}"
HTTP_URL="${HTTP_URL:-http://127.0.0.1:8545}"
RETH_BIN="${RETH_BIN:-}"
RETH_PID=""
DATADIR=""
CLEANUP_DONE=0

usage() {
  cat >&2 <<'USAGE'
Usage:
  HTTP_URL=http://127.0.0.1:8545 ./scripts/check-rpc-gascap.sh
  RETH_BIN=$(which reth) ./scripts/check-rpc-gascap.sh

Env:
  HTTP_URL     Existing JSON-RPC endpoint (default http://127.0.0.1:8545)
  RETH_BIN     Path to reth; used only if HTTP_URL does not answer eth_blockNumber
  RPC_GASCAP   Cap to pass to reth --rpc.gascap (default 100000)

Exit: 0 same bound | 1 infra | 2 split (call fails, estimate ok & gas > cap)
USAGE
}

cleanup() {
  if [[ "$CLEANUP_DONE" -eq 1 ]]; then return; fi
  CLEANUP_DONE=1
  if [[ -n "${RETH_PID}" ]] && kill -0 "$RETH_PID" 2>/dev/null; then
    kill "$RETH_PID" 2>/dev/null || true
    wait "$RETH_PID" 2>/dev/null || true
  fi
  if [[ -n "${DATADIR}" && -d "${DATADIR}" ]]; then
    rm -rf "${DATADIR}"
  fi
}
trap cleanup EXIT INT TERM

rpc() {
  local method="$1"
  local params="$2"
  curl -sS --max-time 30 -X POST "$HTTP_URL" \
    -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}"
}

alive=0
if out=$(rpc eth_blockNumber '[]' 2>/dev/null); then
  if echo "$out" | grep -q '"result"'; then
    alive=1
  fi
fi

if [[ "$alive" -eq 0 ]]; then
  if [[ -z "$RETH_BIN" || ! -x "$RETH_BIN" ]]; then
    usage
    echo '{"issue":27342,"error":"infra: HTTP_URL dead and RETH_BIN missing/unexecutable"}' >&2
    exit 1
  fi
  DATADIR=$(mktemp -d -t reth-gascap-XXXXXX)
  "$RETH_BIN" node --dev --http --http.api eth --http.addr 127.0.0.1 --http.port 8545 \
    --rpc.gascap "$RPC_GASCAP" --datadir "$DATADIR" >/dev/null 2>&1 &
  RETH_PID=$!
  HTTP_URL="http://127.0.0.1:8545"
  for _i in $(seq 1 40); do
    if out=$(rpc eth_blockNumber '[]' 2>/dev/null) && echo "$out" | grep -q '"result"'; then
      alive=1
      break
    fi
    sleep 0.25
  done
  if [[ "$alive" -eq 0 ]]; then
    usage
    echo '{"issue":27342,"error":"infra: spawned reth did not become ready"}' >&2
    exit 1
  fi
fi

FROM=$(rpc eth_accounts '[]' | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
  acc=(d.get("result") or [])
  print(acc[0] if acc else "0x0000000000000000000000000000000000000001")
except Exception:
  print("0x0000000000000000000000000000000000000001")
')

CLIENT=$(rpc web3_clientVersion '[]' | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
  print(d.get("result") or "")
except Exception:
  print("")
')

DATA="0x5b600056"
CALL_OBJ=$(python3 -c "import json; print(json.dumps({\"from\":\"$FROM\",\"data\":\"$DATA\"}))")

CALL_RAW=$(rpc eth_call "[${CALL_OBJ},\"latest\"]")
EST_RAW=$(rpc eth_estimateGas "[${CALL_OBJ}]")

python3 - "$RPC_GASCAP" "$FROM" "$CLIENT" "$CALL_RAW" "$EST_RAW" <<'PY'
import json, sys

cap = int(sys.argv[1])
frm = sys.argv[2]
client = sys.argv[3]
call_raw = sys.argv[4]
est_raw = sys.argv[5]

def parse(raw):
    try:
        return json.loads(raw)
    except Exception as e:
        return {"error": {"message": f"parse: {e}"}}

call = parse(call_raw)
est = parse(est_raw)

call_err = None
if isinstance(call, dict) and "result" in call and call.get("error") is None:
    call_ok = True
else:
    call_ok = False
    err = (call.get("error") if isinstance(call, dict) else None) or {}
    call_err = err.get("message") if isinstance(err, dict) else (str(err) if err else "unknown eth_call error")
    if isinstance(err, dict) and not call_err:
        call_err = json.dumps(err)

est_ok = False
est_gas = None
est_err = None
if isinstance(est, dict) and "result" in est and est.get("error") is None:
    try:
        est_gas = int(est["result"], 16) if isinstance(est["result"], str) else int(est["result"])
        est_ok = True
    except Exception as e:
        est_err = f"bad gas: {e}"
else:
    err = (est.get("error") if isinstance(est, dict) else None) or {}
    est_err = err.get("message") if isinstance(err, dict) else (str(err) if err else "unknown eth_estimateGas error")
    if isinstance(err, dict) and not est_err:
        est_err = json.dumps(err)

split = (not call_ok) and est_ok and (est_gas is not None) and (est_gas > cap)

out = {
    "issue": 27342,
    "rpc_gascap": cap,
    "client_version": client or None,
    "from": frm,
    "eth_call": {"ok": call_ok, "error": None if call_ok else call_err},
    "eth_estimateGas": {"ok": est_ok, "gas": est_gas, "error": None if est_ok else est_err},
    "split": split,
}
print(json.dumps(out, separators=(",", ":")))
sys.exit(2 if split else 0)
PY
