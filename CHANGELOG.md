# Changelog

## 2.0.0

Contract destinations are fail closed. In 1.x a destination without a `selectors` list allowed every function
on it, so allowlisting a contract such as a DEX router allowed all of its functions, not just the swap. See
[README#migrating](./README.md#from-l2-send-guard-1x-to-20) for the upgrade steps.

### Breaking

- Every entry in `destinations` must have a `selectors` list, `"type": "eoa"` (a plain account: ETH transfers
  only), or `"allowAnySelector": true`. A policy with an entry that has none of these doesn't load: the proxy
  refuses to start and `check-policy` fails, and the error names every such destination at once.
- A call with calldata to a destination without a function list is refused with the new deny code
  `SELECTORS_REQUIRED` (a policy built in code can still have such an entry). Plain ETH transfers with empty
  calldata need no list.
- A call with calldata to a `"type": "eoa"` destination is refused (`SELECTOR_NOT_ALLOWED`).
- Calldata of one to three bytes is no longer treated as a plain transfer: `"0x"` in `selectors` doesn't cover it.
- ETH sent along with a token call must be allowed by the token's own destination entry (`selectors` and
  `maxNativeWei`). Before, any listing of the token as a destination was enough.
- `migrate-policy` writes 0.x destinations as `"type": "eoa"`, with a note to add `selectors` for contracts.
- `"selectors": "*"` is refused with a pointer to `allowAnySelector`.
- Universal Router payouts are bound to the router that runs the command. A payout may go to the sender, one of
  `accounts`, or a `universalRouter.recipients` entry. In 1.x a payout to
  any other wrapper in the same transaction was accepted, so `Multicall3 → router` could sweep tokens into
  Multicall3, where anyone can take them. That is now refused with the new deny code `ROUTER_PAYOUT_TO_WRAPPER`.
  The router's `MSG_SENDER` recipient now resolves to the router's actual caller (Multicall3, the agent's Safe,
  a MultiSend contract), not always to the transaction's sender; in 1.x `MSG_SENDER` inside `Multicall3 → router`
  was judged as "the sender" while the funds went to Multicall3.
- Funds a Universal Router plan puts into the router itself must leave it in the same plan. A swap's output
  sent to `ADDRESS_THIS`, `WRAP_ETH`/`UNWRAP_WETH` to `ADDRESS_THIS`, tokens pulled in with Permit2 and ETH
  sent with the call have to be moved out by a later `SWEEP` or `UNWRAP_WETH` to an allowed payee, or spent in
  full by a later swap the router pays for. Otherwise the plan is refused with the new deny code
  `ROUTER_OUTPUT_STRANDED`: `SWEEP` and `execute` have no caller check, so anyone can take a balance left in
  the router. A sweep back to `ADDRESS_THIS`, a `TRANSFER` or `PAY_PORTION` of part of the balance, and a
  command flagged "allow revert" don't count. In 1.x a swap to `ADDRESS_THIS` with nothing after it was allowed.
- A payout to one of `accounts` is allowed even when that account isn't part of the transaction (in 1.x only
  when it was a wrapper in it).

### Added

- `"allowAnySelector": true` per destination: the explicit opt-in to allow every function. The proxy prints a
  `WARNING` line for each such destination at startup, and `check-policy` prints it and counts them in its
  summary.
- `"type": "eoa"` per destination (`"contract"` is also accepted and is the default).
- `selectorWarnings(policy)` in the library, for callers that load policies themselves.
- A `hint` for `SELECTORS_REQUIRED` in `error.data`.
- Hints for `ROUTER_PAYOUT_TO_WRAPPER` and `ROUTER_OUTPUT_STRANDED` in `error.data`.

### Changed

- `check-policy` no longer warns "any function may be called" about destinations without `selectors`, since such
  a policy no longer loads. The warning about a token that is also an unrestricted destination now applies to
  `allowAnySelector` entries.
- The offline demo, the evaluation harness and every example policy declare a function list or `"type": "eoa"`
  for each destination.

### Other

- Tests: Panic `0x22` (storage encoding error) is in the revert-decode table. Thanks @littfed (#14).
- Docs: the README lists every `/health` `policy` and `decisions` field. Thanks @wufangyong973 (#21).

## 1.0.0

l2-send-guard becomes one policy guard for agent wallets. It absorbs six single-purpose packages
(`send-allow`, `send-approve-bound`, `send-permit2-bound`, `send-idempotency`, `recv-sweep-brake`,
`recv-approval-watch`) and replaces the 0.x "thin Layer 2" policy. See [README#migrating](./README.md#migrating).

### Breaking

- New policy format (one file: destinations, tokens, Permit2, 7702 delegation, rolling caps). A 0.x file is
  refused at startup with a pointer to `l2-send-guard migrate-policy`.
- `L2SG_POLICY_ENABLED` and the other `L2SG_POLICY_*` variables are removed and refused at startup.
- A policy is required to start. `L2SG_POLICY=off` runs simulation only, with a warning.
- `GUARD_MODE` defaults to `strict`. An invalid `GUARD_MODE` is an error.
- An unknown chain in `L2SG_CHAINS`, or a chain with no RPC, is an error (0.x skipped it with a warning).
- Signing methods (`eth_sign`, `personal_sign`, `eth_signTypedData*`, `wallet_sendCalls`) are refused with
  `-32081` like `eth_sendTransaction`. Unknown submit-like methods (e.g. `eth_sendUserOperation`) are refused
  with `-32083 METHOD_NOT_GATED`.
- The guarded signer refuses `signMessage` unless you pass `allowMessage`, and always refuses `SafeTx`,
  `SafeMessage` and ERC-4337 user-operation typed data.
- An address can't be in both `accounts` and `destinations`. Admin calls on the agent's own accounts
  (modules, owners, threshold, guards, fallback handler) are refused (`ACCOUNT_ADMIN_DENIED`), and so is any
  other call with data on the sender or an account that is not a wrapper the guard unpacks
  (`upgradeToAndCall`, `addOwnerAddress`, …), even if the sender is listed as a destination.
- Legacy transactions without a chain id are refused (`REPLAYABLE_TX`).
- Requests with keys that differ only in case are refused (`-32600`), and only `jsonrpc`, `id`, `method` and
  `params` are forwarded.
- The params of every gated send method are rebuilt from an exact-key allowlist before they are forwarded. A
  key that is not exactly one the method takes (for example `Tx` beside `bundle` in a `mev_sendBundle` item, or
  `txſ` beside `txs` in `eth_sendBundle`) is refused with `-32602`, and a non-ASCII key anywhere in params is
  refused with `-32600`, because Go-based upstreams fold such keys onto the real field names.
- A reducing call (`approve(x, 0)`, `decreaseAllowance`, `setApprovalForAll(false)`) to a listed destination that
  is not a listed token is held to that destination's `selectors` and `maxNativeWei`.
- The `policy:check`, `demo:dual-layer`, `demo:safe-exec` and `demo:offline` scripts are replaced by
  `l2-send-guard check-policy` and `npm run demo`.

### Added

- Calls inside Multicall3, `multicall`, Safe `execTransaction`/`multiSend`, smart-account `execute`/`executeBatch`,
  ERC-7821/7579 `execute` and Universal Router are decoded and checked one by one.
- ERC-20/721/1155 transfer calldata, approvals (`approve`, `increaseAllowance`, EIP-2612 and DAI `permit`,
  `setApprovalForAll`) and every Permit2 entry point are checked against per-token rules. Any approval
  ≥ 2^128 counts as unlimited and is refused.
- EIP-7702: `authorizationList` policy (delegate allowlist, chain-0 authorizations refused by default), and
  simulation with the delegation applied (`eth_simulateV1` state overrides; `eth_call` only if the RPC honours them).
- Rolling caps per sender for ETH and each token.
- `Idempotency-Key` header, persistent, with a TTL, and in-flight recovery that asks the chain before reusing a key.
  New error `-32087`.
- Bypass detection: a nonce that moves without the guard locks the sender (`-32088`) until
  `l2-send-guard unlock`. `L2SG_BYPASS=alert|off` and `L2SG_ALERT_WEBHOOK`.
- State stores: file (default), Postgres (`L2SG_STORE=postgres://…`, optional `pg` peer dependency), memory.
- Every submit method is checked: `eth_sendRawTransactionConditional`, `eth_sendPrivateRawTransaction`,
  `eth_sendPrivateTransaction`, `eth_sendBundle`, `mev_sendBundle`.
- Receive-side watch (`L2SG_WATCH_AGENTS`): inbound transfers labelled clear/quarantine/toxic, address
  poisoners refused as destinations, unexpected approvals lock the sender and come with revoke calldata.
- Library: `Guard`, `createGuardedSigner` (policy enforced at signing, including EIP-2612/Permit2 typed data),
  `evaluateTx`, `flattenCalls`, `watchInbound`, stores.
- SDK: `sendRawTransaction({ raw, idempotencyKey })`, `GuardRpcError`, `-32087`/`-32088` in `classifyGuardError`.
- `l2-send-guard check-policy`, `migrate-policy` and `unlock` commands. Chain templates for `ethereum`,
  `arbitrum`, `optimism`, `base` and `sepolia` (bring your own RPC).
- `npm run demo`: an offline walk-through of seven sends.

### Fixed

- `migrate-policy` never widens access: `requireApproval` destinations stay refused, and contract creation
  allowed by one chain overlay isn't carried over to all chains.
- `unlock` resets the sender's baseline from the chain, so the next send isn't locked again.
- Only a definite upstream rejection frees a reservation and an idempotency key. A Sync timeout (code 4), a
  network error or an unrecognised error keeps them. "Nonce too low" no longer erases the nonce's record, so
  rebroadcasting a mined transaction doesn't lock the sender.
- A destination's `selectors` and `maxNativeWei` apply when it's called as a wrapper; account-style
  `execute`/`executeBatch` is only unpacked on the agent's own accounts. Revokes (`approve(…, 0)`,
  `decreaseAllowance`, `setApprovalForAll(false)`) are only allowed on listed contracts.
- Rolling ETH caps are per sender across all chains, as documented (they were per chain).
- `mev_sendBundle` items must have exactly one of `tx` or `hash`.
- ERC-7579 modes with an unknown exec type or a non-zero mode selector are refused.
- A 7702 authorization for another chain is refused by the guarded signer.
- An unexpected error inside the policy check is reported as `INTERNAL_ERROR`, not `STORE_DOWN`.
- `check-policy` warns about a destination with no `selectors`.
- The example agent policy no longer lists the agent's Safe as a destination, and narrows the router to `execute`.

### Removed

- The 0.x policy engine, the `agent:loop` script, and internal planning documents.

## 0.5.0

Chain-id mismatch error `-32084`; startup refusals for a missing, invalid or placeholder policy;
`TX_UNPARSEABLE` under policy; stable `error.data` fields; optional decision log; compose binds to localhost.
Safe `execTransaction` inner `ExecutionFailure` aborts as a definite revert.

## 0.4.0

SDK helpers, a `/health` policy summary and an offline demo.

## 0.3.0

Optional Layer 2 allowlist and native caps (`-32083`), default off, beside Layer 1 simulation.
