# Phase 1 — reth#27342 engagement designs (L2 Send Guard)

**Repo:** yellowgram/l2-safety-proxy  
**Issue:** paradigmxyz/reth#27342 (`eth_estimateGas` not bounded by `--rpc.gascap`; `eth_call`/traces are)  
**Traction:** a command people run + a comment that links this repo  
**Hard constraints:** no `src/` guard changes; no Reth PR; do not club #27242/#27279; no keys/Sepolia/`eth_sendRawTransaction` in the probe.

---

## Iteration 1 — Base / smallest pasteable proof

**Thesis:** The cheapest credible engagement is a single local command that prints JSON showing `eth_call` failing under `--rpc.gascap` while `eth_estimateGas` returns gas above the cap. Traction is the script URL in one issue comment after a live fill — not a product surface and not a Reth patch.

**What would be built:** `scripts/check-rpc-gascap.sh` (attach HTTP or spawn `reth --dev --rpc.gascap 100000`), pure `isGascapSplit` helper + offline vitest, draft comment with placeholders, one README “Client probes” blurb, `npm run probe:gascap`. Payload: contract-create + `0x5b600056`. Comment posted only after live numbers.

**Main risk / how it dies:** No Reth binary in the environment → unfilled placeholders → cannot post; PR ships dormant proof. Mitigate by documenting exit 1 infra path and still merging the command.

**Why not the others:** Smallest artifact set; no Geth contrast; no docs-only retreat; comment-after-live-run only.

---

## Iteration 2 — Bull / stronger evidence without a product feature

**Thesis:** Maintainers discount a single-client anecdote. Stronger traction is the same create payload run against **Reth with gascap** and a **same-payload Geth** (or Reth without the knob) contrast table in the comment — still zero `src/` changes, still no Reth PR — proving the split is Reth-specific behavior relative to Geth’s `DoEstimateGas` gasCap.

**What would be built:** Base probe **plus** optional `GETH_BIN` / second HTTP URL path that runs identical JSON-RPC and prints `contrast: { reth, geth }` in stdout; comment template includes both client versions and both estimate results. Still no matrix CI, no Docker productization — local optional contrast only.

**Main risk / how it dies:** Scope creep into “multi-client product”; Geth absent → contrast empty and looks unfinished. Also tempts clubbing unrelated estimate bugs.

**Why not the others:** Explicitly adds a second client for evidence; larger than Base; more than Bear’s docs-only. Disagrees with Base on artifact shape (dual-client JSON) and with Bear on shipping a runnable probe now.

---

## Iteration 3 — Bear / “docs not a bug”; what still ships here

**Thesis:** Upstream may close #27342 as intended/docs. This repo still needs an honest internal note that **wallet `eth_estimateGas` ≠ guard `eth_call`/`simulate` gas world** under `--rpc.gascap`, so operators do not misread sim aborts as matching wallet pricing. Traction is weaker: docs + deferred comment, or a comment that only states the product implication without claiming a fresh reproduction number.

**What would be built:** `docs/drafts/reth-27342-comment.md` framed as “operator implication + ask for docs clarification” **or** a short `docs/` note linked from README Evidence — **no** spawn script in v1. Optionally stub `probe:gascap` as “coming once Reth available.”

**Main risk / how it dies:** Looks like drive-by noise; fails the traction rule (“command people run”). Does not prove the split.

**Why not the others:** Docs/comment-first vs runnable proof; accepts “not a bug” framing; disagrees with Base/Bull on shipping the shell probe in this slice.

---

## Consolidation — locked design (pick, do not average)

**Pick: Iteration 1 (Base).** Bull’s Geth contrast is valuable later but violates “smallest pasteable proof” and invites scope the founder already froze (no multi-client matrix). Bear fails the traction mechanism (command + link).

### Files that may change
1. `scripts/check-rpc-gascap.sh` (executable)  
2. `scripts/gascap-split.mjs` — `export function isGascapSplit(...)`  
3. `tests/gascap-probe.test.ts` — offline vitest only  
4. `docs/drafts/reth-27342-comment.md`  
5. `docs/drafts/27342-design.md` (this Phase 1 record)  
6. `README.md` — short `## Client probes` only  
7. `package.json` — `"probe:gascap": "bash scripts/check-rpc-gascap.sh"`

### JSON contract and exit codes
```json
{
  "issue": 27342,
  "rpc_gascap": 100000,
  "client_version": "<web3_clientVersion or null>",
  "from": "0x...",
  "eth_call": { "ok": false, "error": "..." },
  "eth_estimateGas": { "ok": true, "gas": 123, "error": null },
  "split": true
}
```
- `split = !eth_call.ok && eth_estimateGas.ok && gas > rpc_gascap`  
- Exit **2** split · **0** same bound · **1** infra  

### Probe behavior
- Use `HTTP_URL` if `eth_blockNumber` works; else spawn `$RETH_BIN node --dev --http --http.api eth --rpc.gascap ${RPC_GASCAP:-100000}`  
- Cap default **100000**  
- Payload: create (no `to`), data `0x5b600056`  
- `from`: `eth_accounts[0]` or `0x0000…0001`  
- Kill spawned reth on exit  

### Explicitly forbidden
- Any `src/**` change  
- Reth PR; clubbing #27242 / #27279  
- Keys, Sepolia, `eth_sendRawTransaction`  
- GitHub Action / Docker matrix / new npm deps  
- Posting on #27342 with empty placeholders  
- Marketing / agent / Gate-2 pitch in the comment  

### Comment policy
**Allowed only after a live run fills** reth version, `eth_call` error, and estimate gas number in the draft.

---

## Phase 2/3 status
Implement locked design below; verify; one commit + PR. No issue comment without live JSON.
