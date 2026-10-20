# l2-send-guard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A policy guard for wallets that software controls: AI agents, bots, payout jobs.
Every signed EVM transaction is checked against a policy file you write, then simulated, before
your RPC sees it. It never holds keys.

What it checks, in one pass:

- **Where money goes.** An allowlist of destinations, with per-transaction and rolling (per-window) caps
  on ETH and on each token. ERC-20 `transfer`/`transferFrom` calldata is decoded, so a token transfer to
  a stranger is caught even though the transaction's `to` is the token contract.
- **What gets approved.** `approve`, `increaseAllowance`, `setApprovalForAll`, EIP-2612 `permit` and
  every Permit2 entry point, with a spender allowlist, an amount cap and a Permit2 expiry cap.
  "Unlimited" means any amount ≥ 2^128, not just `2^256-1`.
- **What's hidden inside batches.** Multicall3, `multicall`, Safe `execTransaction` and `multiSend`,
  smart-account `execute`/`executeBatch`, ERC-7821 / EIP-7702 batch `execute`, and Uniswap Universal Router
  are unpacked and every inner call is judged by the same rules. Delegatecall is refused, except a Safe's
  call to MultiSend, whose entries are each checked.
- **EIP-7702 delegation.** A type-4 transaction's `authorizationList` is checked: delegating the account is
  refused unless the delegate is on your list, and an authorization valid on every chain (`chainId 0`) is
  refused unless you allow it. Simulation runs with the delegation applied.
- **Retries.** An `Idempotency-Key` makes "send invoice 1009" happen once, across retries, restarts and
  re-signed transactions.
- **Every way to submit.** `eth_sendRawTransaction`, `…Sync`, `…Conditional`, `eth_sendPrivateRawTransaction`,
  `eth_sendPrivateTransaction` and bundles (`eth_sendBundle`, `mev_sendBundle`) are all checked. Unknown
  submit-like methods and anything that asks the node to sign (`eth_sendTransaction`, `eth_sign`, …) are refused.
- **What arrives.** Optionally, inbound transfers and on-chain approvals are watched. A sender that imitates
  one of your addresses (address poisoning) is blocked as a destination from then on.

It runs as a JSON-RPC proxy in front of your RPC (no code changes: point your client at it), or as a
library around your signer.

## Quickstart (five minutes)

You need Node 20 or later.

**1. See it work, offline.** No keys, no network, no funds:

```bash
git clone https://github.com/yellowgram/l2-safety-proxy.git && cd l2-safety-proxy
npm ci && npm run demo
```

```
1. 0.05 ETH to an allowed payee                  forwarded, hash 0xabababab…
2. 0.05 ETH to an address not in the policy      -32083 DESTINATION_NOT_ALLOWED — 0x2222… is not an allowed destination (at tx)
3. unlimited approve hidden inside Multicall3    -32083 APPROVAL_UNLIMITED — unlimited approval of 0x3333… to 0x2222… (at tx>aggregate3[0])
4. a call that would revert                      -32080 DEFINITE_REVERT — Not enough balance
5. EIP-7702: delegate this account to a stranger -32083 AUTHORIZATION_DENIED — … which is not an allowed delegate (at authorizationList[0])
6a. pay invoice 1009 (Idempotency-Key)           forwarded, hash 0xabababab…
6b. agent retries with a fresh nonce             -32087 IDEMPOTENCY_CONFLICT — idempotency key already used for 0xb135… That transaction was sent; don't send a second one under this key.
```

**2. Write your policy.** Start from [`policy.example.json`](./policy.example.json) and put in your own
addresses. Amounts are decimal strings in raw units (wei, or the token's smallest unit). This one lets the
agent pay one address up to 0.05 ETH at a time and 0.2 ETH a day, and send it up to 250 USDC at a time and
1,000 a day. Everything else is refused.

The payee is `"type": "eoa"`: a plain account that receives ETH, so no call with calldata may go to it. Every
contract you call needs a `"selectors"` list of the functions the agent may call on it (see
[`policy.agent.example.json`](./policy.agent.example.json)). A destination with neither is refused at startup.

```json
{
  "chains": [84532],
  "window": { "seconds": 86400 },
  "native": { "maxPerTxWei": "50000000000000000", "windowMaxWei": "200000000000000000" },
  "destinations": {
    "0xYourPayee…": { "type": "eoa", "maxNativeWei": "50000000000000000" }
  },
  "tokens": {
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e": {
      "transfer": { "recipients": ["0xYourPayee…"], "maxAmountRaw": "250000000" },
      "windowMaxAmountRaw": "1000000000"
    }
  }
}
```

```bash
npx l2-send-guard check-policy ./policy.json
```

Every key is in [docs/POLICY.md](./docs/POLICY.md).

**3. Run the proxy.**

```bash
npm install l2-send-guard
L2SG_POLICY_FILE=./policy.json L2SG_CHAINS=base-sepolia npx l2-send-guard
# [l2-send-guard] listening on http://127.0.0.1:8545
```

**4. Point your client at it.** Sign as you do today; send through the proxy.

```ts
import { createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const wallet = createWalletClient({ account, chain: baseSepolia, transport: http("http://127.0.0.1:8545") });
await wallet.sendTransaction({ to: payee, value: 10n ** 15n }); // checked, simulated, then forwarded
```

For a send that must happen once, use an idempotency key:

```ts
import { sendRawTransaction } from "l2-send-guard/sdk";

const raw = await account.signTransaction(request);
const hash = await sendRawTransaction({ proxyUrl: "http://127.0.0.1:8545", raw, idempotencyKey: "invoice-1009" });
```

Errors come back as JSON-RPC errors with a stable `error.data` (see [Errors](#errors)). An agent should stop
on `-32083`, `-32087` and `-32088` and not rebroadcast after `-32080`.

## How it works

For each signed transaction, in order:

0. **Rebuild the request.** Only `jsonrpc`, `id`, `method` and `params` are kept. For the send methods the
   guard gates (`eth_sendRawTransaction*`, `eth_sendPrivateRawTransaction`, `eth_sendPrivateTransaction`,
   `eth_sendBundle`, `mev_sendBundle`), `params` is rebuilt too, from an exact list of the fields each method
   takes, and a key that is not exactly one of them (`Tx`, `TXS`, `txſ`) is refused, not dropped. Any request
   whose params contain a non-ASCII key, or two keys that differ only in case (`params` and `Params`,
   `tx` and `Tx`), is refused. Geth-based nodes, builders and relays match keys case-insensitively and fold
   some Unicode letters onto ASCII, so the upstream could otherwise act on a different value from the one
   the guard judged. Side effect: a pass-through request such as an `eth_call` state override keyed by both
   the checksummed and the lowercase form of one address is refused too; use one form.
1. **Parse and recover.** Decode the raw transaction, recover the sender and every 7702 authority.
   Unparseable or unrecoverable → refused. A legacy transaction without a chain id (pre-EIP-155) is refused,
   because it can be replayed on every chain.
2. **Chain.** The signed `chainId` must match the chain you selected (`x-l2sg-chain` header or the default).
3. **Bypass lock.** If this sender is locked (see [Threat model](#threat-model-and-limits)), refuse.
4. **Idempotency.** With a key: the same transaction again returns the first result; a different transaction
   under a key that already sent is refused.
5. **Policy.** Flatten batches into leaf calls and judge each one: destination, selector, token transfer,
   approval, Permit2, NFT approval, 7702 authorization, contract creation. One failing leaf refuses the whole
   transaction, and the error names where it is (`tx>execTransaction>multiSend[2]`).
6. **Rolling caps.** Reserve this transaction's spend against the window in the state store. Over the cap → refused.
7. **Simulation.** `eth_simulateV1` (with 7702 code overrides), falling back to `eth_call`. A definite revert is
   refused. If simulation can't decide, `GUARD_MODE=strict` (the default) refuses and `open` forwards.
   Bundles skip this step: the builder simulates them.
8. **Forward and settle.** Send upstream. Only a definite rejection (a malformed request, insufficient funds,
   gas or fee errors, a replacement that's underpriced) releases the reserved spend and the key. A timeout, a
   network error, an unrecognised error, or an `eth_sendRawTransactionSync` "in the mempool but not processed
   in time" (code 4) are unknown outcomes: the spend stays reserved and the key stays taken until the chain
   shows what happened. "Nonce too low" releases this send's spend but keeps the record of the nonce.

Transactions are not forwarded unless every step passes; a deny is never "fail-open". With `GUARD_MODE=open`
(step 7), a transaction that passed every policy check is forwarded when simulation can't decide.

## Library use

The proxy can only judge what's sent through it. If your agent holds the key itself, it can send through any
RPC. The binding way to use the guard is to give the agent a **guarded signer** instead of the key:

```ts
import { Guard, FileStore, loadPolicyFile, createGuardedSigner } from "l2-send-guard";
import { privateKeyToAccount } from "viem/accounts";

const guard = new Guard({ policy: loadPolicyFile("./policy.json"), store: new FileStore("./guard-state.jsonl") });
const account = createGuardedSigner(privateKeyToAccount(process.env.KEY as `0x${string}`), guard, { chainId: 84532 });
// account.signTransaction refuses anything the policy refuses (throws GuardDenied).
// Typed data is checked too: EIP-2612 Permit and Permit2 messages against the approve rules;
// Safe transactions and ERC-4337 user operations are always refused; any other typed data is
// refused unless the policy sets typedData.allowUnknown.
// signMessage is refused unless you pass allowMessage (see below).
```

`signMessage` (`personal_sign`) is refused by default. A signature over a 32-byte hash can approve a Safe
transaction or a user operation, which the policy never sees, and even a text message can be made to hash to
the same thing. If your agent must sign specific messages (a login, say), pass a predicate:
`createGuardedSigner(key, guard, { chainId, allowMessage: (m) => m === expectedLoginText })`.

Keep the key in a different process (or a KMS / enclave) from the agent's tools, and hand the agent only
this account. Signatures count against the rolling caps, so an agent can't stockpile small signatures and
send them later.

Lower-level pieces are exported too: `guard.check(raw, { chainId, idempotencyKey })` / `guard.settle(...)`,
`evaluateTx`, `flattenCalls`, `parseSignedTx`, and the stores (`MemoryStore`, `FileStore`, `PostgresStore`).
`check(raw)` from `l2-send-guard/agent` is a dry run that reserves nothing.

## Idempotency

Send `Idempotency-Key: <your id>` with the request (or pass `idempotencyKey` to `sendRawTransaction`).

| Situation | Result |
| --- | --- |
| First send under the key | Checked and forwarded normally |
| Same signed transaction again | Its hash is returned without simulating again. If the first send's outcome was unknown (timeout), the same bytes are rebroadcast; they can only land once |
| Different transaction, same key, earlier one sent or still pending | `-32087`, with the earlier hash in `error.data.priorTxHash` |
| Re-signed with the **same nonce** (e.g. a gas bump) | Allowed: only one of them can land |
| The earlier transaction was dropped and its nonce used by something else | The key is free again |
| The upstream definitely rejected the earlier one | The key is free again |

Keys are kept for `L2SG_IDEMPOTENCY_TTL_SECONDS` (default 24 hours) after they settle. A key whose transaction
is still in flight never expires silently: the guard asks the chain what happened before it reuses it. For
bundles, the key applies per transaction as `key#0`, `key#1`, ….

## Receive-side watch

Set `L2SG_WATCH_AGENTS=0xYourAgent,…` and the proxy also polls each configured chain for:

- **Inbound token transfers.** Each is labeled `clear`, `quarantine` (a token not in your policy, or a sender
  outside `L2SG_WATCH_EXPECTED_SENDERS`) or `toxic` (dust, or a sender whose address shares the first and last
  four hex characters with one of your addresses). A toxic sender is added to the poisoned set, and the policy
  refuses it as a destination (`POISONED_ADDRESS`) even if someone later pastes it into the allowlist.
- **Approvals granted by the agent** (`Approval`, `ApprovalForAll`, Permit2 `Approval`/`Permit`) that the
  policy would not allow. These lock the sender like a bypass, and the finding includes unsigned revoke
  calldata (`approve(spender, 0)`, `setApprovalForAll(op, false)`, Permit2 `lockdown`). The guard never signs it.

Anything not `clear` is logged as a `RECEIVE:` line and POSTed to `L2SG_ALERT_WEBHOOK`. The watch waits two
blocks for reorgs and keeps its cursor in the state store, so a restart resumes where it stopped. Library users
call `watchInbound(...)` or `scanOnce(...)`.

Tokens that aren't in your policy can't be moved anyway, because they aren't allowed destinations. That is the
"sweep brake": quarantined funds stay put until you add the token to the policy on purpose.

## Errors

| Code | `error.data.decision` | Meaning | Agent should |
| --- | --- | --- | --- |
| -32080 | `abort` | Simulation says it would revert. Not sent | Not rebroadcast the same transaction |
| -32081 | `unsigned_refused` | A method that asks the node to sign (`eth_sendTransaction`, `eth_sign`, …). The guard never holds keys | Sign locally and use `eth_sendRawTransaction` |
| -32082 | `abort` | Simulation couldn't decide and `GUARD_MODE=strict` | Retry later, or fix the RPC |
| -32083 | `policy_denied` | The policy refused it. `data.policyCode` says why, `data.path` says where | Stop. Change the policy if it should be allowed |
| -32084 | `chain_mismatch` | Signed for a different chain than the one selected | Fix the chain |
| -32087 | `idempotency_conflict` | The key already sent another transaction (`data.priorTxHash`), or the guard's state is unavailable: store down (`STORE_DOWN`) or the RPC couldn't be read for the bypass check (`CHAIN_READ_FAILED`). Nothing was sent | On a conflict, stop: don't send a second payment. On `STORE_DOWN` / `CHAIN_READ_FAILED`, retry later |
| -32088 | `bypass_locked` | This sender is locked after a transaction landed without the guard | Stop and alert a human |

Every error carries `data.l2SendGuard: true`, `decision`, `policyCode`, `reason`, `hint` and, where it applies,
`path`, `priorTxHash` and `index` (the transaction's position in a bundle). The SDK has
`classifyGuardError(err)` and `isPolicyDeniedError(err)`-style helpers. The full list of `policyCode` values is
in [docs/POLICY.md](./docs/POLICY.md#deny-codes).

## Threat model and limits

**Who it protects against.** Software that has authority to send but shouldn't be fully trusted: an agent that
can be prompt-injected, a bot with a bug, a compromised dependency in the process that builds transactions. The
policy bounds what such software can do with the wallet.

**The key holder can go around the proxy.** If the process that holds the private key is the one you don't
trust, it can sign a transaction and send it through any other RPC. A proxy can't prevent that. Two things
close the gap:

1. **Prevention: the guarded signer.** Give the agent `createGuardedSigner(...)` and keep the raw key in a
   separate process, KMS or enclave. Then nothing the policy refuses gets signed at all, whichever RPC the agent
   uses. This is the only configuration in which the policy holds against the key holder, and only for what
   the signer signs: if the agent's Safe has other owners or modules, those are outside the guard.
2. **Detection: the bypass lock.** On every send, the proxy compares the sender's on-chain nonce with the nonces
   it forwarded. If a transaction it never saw has landed, it logs `BYPASS`, POSTs `bypass_detected` to
   `L2SG_ALERT_WEBHOOK`, and (with `L2SG_BYPASS=lock`, the default) refuses that sender with `-32088` until you
   run `l2-send-guard unlock <address> --chain <id>`. Detection happens on the sender's next send through the
   proxy, after the bypassing transaction has already landed. Detection is by nonce only: it notices that a
   transaction it didn't forward used one of the sender's nonces. It can't see actions that don't use the
   sender's nonce, such as a signed permit or a Safe signature used by someone else. The receive watch
   separately flags approvals the policy wouldn't allow.

**Other limits, stated plainly:**

- **Calls it can't see into.** It decodes the wrappers listed above. A call to an allowlisted contract with
  calldata it doesn't decode is judged by that destination's `selectors` list: only the functions you list
  may be called, and a destination without a list takes no calldata at all (`SELECTORS_REQUIRED`). Within a
  listed function, the guard doesn't know what the contract does with the arguments: listing a general-purpose
  router's `swap` lets the agent swap through it. `"allowAnySelector": true` lifts the function list for one
  destination, and is rarely what you want: the proxy refuses to start with it unless whoever runs it also sets
  `GUARD_ALLOW_ANY_SELECTOR=1`, in either `GUARD_MODE`. It then prints a `WARNING` at startup, in
  `check-policy`, and for every call it lets through.
- **Contract or account.** The guard is offline and never asks the chain whether an address has code (code can
  appear later through CREATE2 or an EIP-7702 delegation). Calldata decides: a send with empty calldata is a
  plain transfer and needs no function list; anything with calldata needs one. A plain transfer to a contract
  still runs its `receive`/fallback code (WETH's deposits, for example), so cap it with `maxNativeWei`.
- **Swaps.** Universal Router commands are checked for recipients: the output must go to the sender, one of
  `accounts`, or a listed recipient. Each payout is bound to its own router, and `MSG_SENDER` means the router's
  real caller, so a swap inside Multicall3 can't pay Multicall3 (or another contract in the transaction)
  (`ROUTER_PAYOUT_TO_WRAPPER`). The router itself (`ADDRESS_THIS`) is only a step: whatever a plan puts there
  (a swap's output, wrapped or unwrapped ETH, tokens pulled in with Permit2, ETH sent with the call) must leave
  again in the same plan, through `SWEEP` or `UNWRAP_WETH` to an allowed payee or a later swap that spends the
  whole balance; otherwise the plan is refused (`ROUTER_OUTPUT_STRANDED`). Commands flagged "allow revert" don't
  count as moving funds out. Unknown commands are refused. Within those rules the guard doesn't track amounts:
  prices and slippage are not checked, and the amount a swap spends is bounded only by the token approvals the
  router (or Permit2) holds. Keep those approvals capped.
- **Your own accounts.** Calls the agent's Safe or smart account makes are judged one by one, and the account's
  own admin functions (`enableModule`, `addOwnerWithThreshold`, `swapOwner`, `changeThreshold`, `setGuard`,
  `setFallbackHandler`, `installModule`, …) are always refused, so the agent can't take over the account.
  So is every other call with data on the account or on the sender itself (`upgradeToAndCall`, Coinbase
  `addOwnerAddress`, Kernel validators, …) unless it is a wrapper the guard unpacks (`execute`,
  `executeBatch`, `multicall`), even when the sender's own 7702 address is listed as a destination.
  The plain nonce cancel (a 0-value self-send with no data) still passes.
  An address can't be in both `accounts` and `destinations`.
- **Off-chain signatures** (EIP-2612 Permit, Permit2, other EIP-712 messages) are only checked when signed
  through the guarded signer. The proxy never sees them.
- **Simulation is advisory.** State can change between simulation and inclusion. A clean simulation is not a
  guarantee, and `GUARD_MODE=open` forwards when simulation can't decide.
- **One policy per process.** To give two agents different policies, run two proxies (or two `Guard`s).
- **State.** Rolling caps, idempotency and the bypass lock need the state store. The default file store is for
  one process on one machine (it takes a lock file). For several processes, use Postgres. If the store fails,
  sends are refused (`STORE_DOWN`), not let through. `memory` forgets everything on restart.
- **Network exposure.** The proxy has no authentication. It listens on `127.0.0.1` by default; on `0.0.0.0`
  anyone who can reach it can broadcast through your RPC (it warns when you do this).
- **Chains.** Built-in names: `arb-sepolia`, `op-sepolia`, `base-sepolia` (public RPC defaults), and
  `ethereum`, `arbitrum`, `optimism`, `base`, `sepolia` (you must set `L2SG_RPC_<NAME>`). Any EVM chain works
  through the library. Mainnet use is at your own risk; there is no warranty (MIT).
- **Account abstraction.** ERC-4337 UserOperations (`eth_sendUserOperation`) are refused, not checked.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `L2SG_POLICY_FILE` | — (required) | Path to the policy file |
| `L2SG_POLICY` | — | `off` runs simulation only, with no policy (prints a warning) |
| `L2SG_CHAINS` | `arb-sepolia,op-sepolia,base-sepolia` | Chains to serve. An unknown name, or a mainnet with no RPC, is an error |
| `L2SG_DEFAULT_CHAIN` | first in the list | Chain used when the request has no `x-l2sg-chain` header |
| `L2SG_RPC_<NAME>` | public testnet RPC | Upstream RPC, e.g. `L2SG_RPC_BASE`, `L2SG_RPC_ARB_SEPOLIA` |
| `L2SG_RPC_FALLBACK_<NAME>` | — | Second RPC used only for simulation |
| `GUARD_MODE` | `strict` | `strict` refuses when simulation can't decide; `open` forwards |
| `GUARD_ALLOW_ANY_SELECTOR` | `0` | `1` accepts `"allowAnySelector": true` in the policy (in either `GUARD_MODE`); without it the proxy refuses to start with such a policy. Alias `L2SG_ALLOW_ANY_SELECTOR` |
| `L2SG_STORE` | `file:./l2-send-guard-state.jsonl` | `file:<path>`, `postgres://…` (needs `npm i pg`), or `memory` |
| `L2SG_IDEMPOTENCY_TTL_SECONDS` | `86400` | How long settled keys are kept |
| `L2SG_BYPASS` | `lock` | `lock`, `alert` (log and webhook only) or `off` |
| `L2SG_ALERT_WEBHOOK` | — | URL that receives `bypass_detected` and `receive_finding` POSTs |
| `L2SG_WATCH_AGENTS` | — | Addresses to watch for inbound funds and approvals |
| `L2SG_WATCH_EXPECTED_SENDERS` | — | Senders you expect money from; others are quarantined |
| `L2SG_WATCH_DUST_RAW` | `0` | Inbound amounts at or below this are dust |
| `L2SG_WATCH_INTERVAL_SECONDS` | `15` | Poll interval |
| `L2SG_DECISION_LOG` | — | Append one JSON line per decision to this file |
| `L2SG_HOST` / `L2SG_PORT` | `127.0.0.1` / `8545` | Listen address |

Configuration errors stop the process at startup with a message; the proxy never runs with a policy silently off.
`GET /health` is a read-only endpoint for monitoring. It also returns `ok`, `service`, `version`, `chains`, `chainDetails`,
`defaultChain`, `guardMode`, `failOpen`, `submit` and `confidence`. Two objects matter when you poll it:

| Object | Field | Meaning |
|---|---|---|
| `policy` | `enabled` | `true` when a policy is loaded; `false` with `L2SG_POLICY=off` |
| | `source` | `file`, or `off` for simulation only |
| | `store` | State store kind: `file`, `postgres` or `memory` (`null` when the policy is off) |
| | `bypass` | `lock`, `alert` or `off` (`null` when the policy is off) |
| | `destinationCount`, `tokenCount` | How many destinations and tokens the policy lists. Counts only: the addresses are never shown |
| | `delegation` | EIP-7702 delegation mode: `deny` or `allowlist` (`null` when the policy is off) |
| | `allowContractCreation` | Whether contract deployments are allowed |
| | `windowSeconds` | Length of the rolling-cap window (`null` when the policy is off) |
| `decisions` | `forward`, `abort`, `fail_open`, `policy_denied`, `chain_mismatch`, `unsigned_refused`, `idempotency_conflict`, `bypass_locked` | How many send requests ended each way since the process started (not per request; reset on restart) |
| | `totalSendDecisions` | Sum of the above. Non-send methods are not counted |

```bash
curl -s http://127.0.0.1:8545/health | jq '.policy, .decisions'
```

Commands:

```
l2-send-guard [serve]                          start the proxy
l2-send-guard check-policy <file>              validate a policy and print a summary and warnings
l2-send-guard migrate-policy <old-file>        print the 2.0 form of a 0.x or 1.x policy file
l2-send-guard unlock <address> --chain <id>    clear a bypass lock (stop the proxy first if you use the file store)
```

## Docker

```bash
cp policy.example.json policy.json   # then edit it
docker compose up --build
curl http://127.0.0.1:8545/health
```

The compose file publishes the port on `127.0.0.1` only and keeps state in a volume.

## Migrating

### From l2-send-guard 1.x to 2.0

2.0 makes contract destinations fail closed. In 1.x a destination without `selectors` allowed every function
on it, so allowlisting a DEX router allowed its admin and sweep functions too. In 2.0:

- Every destination must say what may be sent to it. The proxy refuses to start, and `check-policy` fails,
  naming every destination that doesn't. For each one, add one of:
  - `"selectors": [...]`: the functions the agent may call (4-byte selectors or signatures; `"0x"` also allows
    plain ETH transfers). Use this for every contract, including Multicall3 and routers you call through.
  - `"type": "eoa"`: a plain account that only receives ETH. Calls with calldata to it are refused.
  - `"allowAnySelector": true`: every function, as in 1.x. Only if you really mean it: the proxy refuses to start
    with it unless you also set `GUARD_ALLOW_ANY_SELECTOR=1`. That acknowledgement is separate from
    `GUARD_MODE`: `strict` stays strict, and `open` doesn't accept it on its own. It then prints a `WARNING` at
    startup, in `check-policy`, and for every call it lets through.
  - `npx l2-send-guard migrate-policy old-policy.json > policy.json` does this for a whole 1.x file: it keeps
    every cap, token, account and recipient as they are and writes each destination without `selectors` as
    `"type": "eoa"`, with a note listing them. Then add `selectors` for the contracts among them.
- A call with calldata to a destination that has no function list is refused with the new code
  `SELECTORS_REQUIRED`. This only arises for policies built in code; a policy file can't load without a list.
- Calldata of one to three bytes is no longer treated as a plain transfer, so `"0x"` in `selectors` no longer
  covers it (it runs the contract's fallback).
- ETH sent along with a token call (`transfer`, `approve`, …) must be allowed by the token's own destination
  entry, its `selectors` and `maxNativeWei`. Before, any listing of the token as a destination was enough.
- Universal Router payouts are bound to their own router. A swap, sweep or transfer that pays another contract
  in the same transaction (the Multicall3 that called the router, a second router) is refused
  (`ROUTER_PAYOUT_TO_WRAPPER`), and `MSG_SENDER` now means the router's real caller. Inside Multicall3, pay the
  sender's address explicitly. Payouts to your `accounts` are allowed.
- Funds a Universal Router plan leaves in the router itself (a swap to `ADDRESS_THIS` with nothing sweeping it
  out) are refused (`ROUTER_OUTPUT_STRANDED`): anyone can take a balance left in the router. End such a plan
  with `SWEEP` or `UNWRAP_WETH` to `MSG_SENDER`, as Uniswap's own SDK does.
- A key written twice in one object of a policy file (for example the same destination twice) is refused.
  Before, the last one silently won.
- `accounts` and `universalRouter.recipients` can't list `0x…01` or `0x…02`, the router's `MSG_SENDER` and
  `ADDRESS_THIS` constants.
- `migrate-policy` writes 0.x destinations, and 1.x destinations without `selectors`, as `"type": "eoa"`.
  Replace that with a `selectors` list for any contract you call.
- Library: `selectorWarnings(policy)` returns the warnings for `allowAnySelector` destinations, and an allowed
  `Verdict` (and a forwarded `Guard.check` result) carries `warnings` for each call `allowAnySelector` let
  through; log them if you load policies yourself. `DestinationRule` has new optional fields `anySelector` and `eoa`.

A 1.x entry such as

```json
"0xRouter…": { "maxNativeWei": "0" }
```

becomes, for a router the agent swaps through,

```json
"0xRouter…": { "maxNativeWei": "0", "selectors": ["execute(bytes,bytes[],uint256)"] }
```

### From l2-send-guard 0.x

1.0 replaces the 0.x policy with the format above. The process refuses to start with a 0.x file or the old
variables, and says what to do.

- Convert your file: `npx l2-send-guard migrate-policy old-policy.json > policy.json`. It prints notes for
  anything it can't carry over. It never widens access: `requireApproval` destinations are left out (so still
  refused), per-chain caps become the lowest one, and contract creation allowed by only one chain overlay is not
  carried over. It refuses, and writes nothing, when the file has a key it doesn't know (it could be a limit) or
  a destination that only one chain overlay allows (2.0 would allow it on every chain); split such a file into
  one policy per chain.
- `L2SG_POLICY_ENABLED`, `L2SG_POLICY_ALLOWLIST`, `L2SG_POLICY_GLOBAL_MAX_WEI` and the other `L2SG_POLICY_*`
  variables are gone. Put the rules in the file and set `L2SG_POLICY_FILE`.
- A policy is now required. `L2SG_POLICY=off` keeps the 0.x "simulation only" behaviour.
- `GUARD_MODE` now defaults to `strict`. Set `GUARD_MODE=open` for the old behaviour.
- New error codes `-32087` and `-32088`. `-32080` to `-32084` keep their meanings.
- More methods are checked or refused (private and conditional sends, bundles, signing methods).

### From the single-purpose packages

These six packages are merged into l2-send-guard 1.x. Their final 0.2.0 versions behave like 0.1.0 and print a
deprecation warning.

| Old package | In l2-send-guard 1.x | Old error | New error |
| --- | --- | --- | --- |
| `send-allow` | `destinations`, `native.maxPerTxWei`, `native.windowMaxWei` | -32083 | -32083 |
| `send-approve-bound` | `tokens.<token>.approve` (`spenders`, `maxAmountRaw`, `operators`) | -32085 | -32083 (`APPROVAL_*`, `SPENDER_NOT_ALLOWED`) |
| `send-permit2-bound` | the same `approve` rules, applied to Permit2, plus `permit2.maxExpirySeconds` | -32086 | -32083 (`PERMIT2_*`, `APPROVAL_*`) |
| `send-idempotency` | `Idempotency-Key` header, or `guard.check(raw, { idempotencyKey })` | -32087 | -32087 |
| `recv-sweep-brake` | `L2SG_WATCH_AGENTS`; quarantined tokens stay unspendable because they aren't in the policy; `maySpend()` for asset-keyed callers | — | -32083 `POISONED_ADDRESS` |
| `recv-approval-watch` | `L2SG_WATCH_AGENTS` (approval findings with revoke calldata) | — | -32088 after an unexpected approval |

Each was one slice of the same job and shared the same blind spots: no decoding inside batches, no 7702
checks, per-transaction limits only, other submit methods unchecked, and in-memory state.

## Contributing and support

Bugs with a way to reproduce them offline go to [Issues](https://github.com/yellowgram/l2-safety-proxy/issues);
questions to [Discussions](https://github.com/yellowgram/l2-safety-proxy/discussions). Security reports: see
[SECURITY.md](./SECURITY.md). [CHANGELOG](./CHANGELOG.md) · [Troubleshooting](./docs/TROUBLESHOOTING.md).

## License

MIT. See [LICENSE](./LICENSE).
