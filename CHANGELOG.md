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
  It also converts 1.x files: every cap, token, account and recipient is kept as is, and each destination
  without `selectors` becomes `"type": "eoa"`. It refuses, writing nothing, a file with an unknown key (0.x or
  1.x), a 0.x destination that only one chain overlay allowed, or a file that mixes the two formats.
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
- The proxy refuses to start with a policy that has `"allowAnySelector": true` unless `GUARD_ALLOW_ANY_SELECTOR=1`
  is also set, in either `GUARD_MODE`.
- `accounts` and `universalRouter.recipients` refuse `0x…01` and `0x…02` (the router's `MSG_SENDER` and
  `ADDRESS_THIS` constants).
- A policy file with a key written twice in one object is refused (`check-policy`, `serve`, `migrate-policy`,
  `loadPolicyFile`). Before, JSON parsing kept the last one, so a later entry could silently replace a stricter one.
- A payout to one of `accounts` is allowed even when that account isn't part of the transaction (in 1.x only
  when it was a wrapper in it).
- Every input the guard decodes must be the exact canonical encoding the target contract reads: the guard
  decodes it as the contract does, re-encodes it and requires the same bytes. Anything else is refused with
  `NON_CANONICAL_ABI`. This covers ERC-20 and Permit2 calls; Multicall3, router `multicall`, Safe
  `execTransaction` and MultiSend; ERC-7579 `execute`; 7702 and smart-account batches; Universal Router
  `execute` and each command's input. New in 2.0:
  - Trailing bytes after a known function's arguments are refused (1.x ignored them, as Solidity does). Tools
    that append a suffix to calldata, such as an attribution tag, must not do so for calls the guard checks.
  - Universal Router command inputs must round-trip exactly (1.x decoded them leniently).
  - A Universal Router V3 path must be 20 + 23·k bytes (k ≥ 1): a token, then fee + token per pool. The router
    reads a path shorter than 66 bytes as one pool and ignores the rest, so a padded path's last token need
    not be what the swap produces, and the router balance tracking above would be judging the wrong token.
  - A Universal Router command byte with bit `0x40` set is refused. It is unused in Universal Router 1.x and 2.0
    (command type mask `0x3f`) and selects new commands in 2.1 (mask `0x7f`), which the guard doesn't model.
  - An ERC-7579 `execute` with a non-zero mode payload is refused; an ERC-7579 batch must be canonical ABI.
- Calldata over 128 KiB is refused with the new deny code `CALLDATA_TOO_LARGE`, before anything is decoded.
  ABI offsets and lengths are checked for the canonical layout before any value is expanded. Before, offsets
  that all pointed at one large value made the decoder expand it again for each one, so a crafted batch of
  about 250 KB could exhaust the proxy's memory. It failed closed, but the proxy went down.

### Known limitations

- The guard reads the Universal Router 1.x and 2.0 command layout only. Swaps built for Universal Router 2.1 or
  later (a sixth `minHopPriceX36` swap argument, commands in the `0x40` range) are refused with
  `NON_CANONICAL_ABI`. As of October 2026 the Uniswap Trading API builds 2.1.2 calldata by default, so most
  current Uniswap swaps are refused. V4 swaps (command `0x10`) are refused on every version. See the README's
  limits section.

### Added

- `"allowAnySelector": true` per destination: the explicit opt-in to allow every function. The proxy also needs
  the operator's acknowledgement `GUARD_ALLOW_ANY_SELECTOR=1` (alias `L2SG_ALLOW_ANY_SELECTOR`), independent of
  `GUARD_MODE`. It prints a `WARNING` line for each such destination at startup and for every call
  it lets through only because of it, and `check-policy` prints it and counts them in its summary.
- `Verdict.warnings` and `warnings` on a forwarded `Guard.check` result: one line per call `allowAnySelector`
  let through.
- `"type": "eoa"` per destination (`"contract"` is also accepted and is the default).
- `selectorWarnings(policy)` in the library, for callers that load policies themselves.
- A `hint` for `SELECTORS_REQUIRED` in `error.data`.
- Hints for `ROUTER_PAYOUT_TO_WRAPPER`, `ROUTER_OUTPUT_STRANDED`, `NON_CANONICAL_ABI` and `CALLDATA_TOO_LARGE` in
  `error.data`.

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
