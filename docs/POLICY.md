# Policy reference

A policy is one JSON file. Unknown keys and keys written twice in one object are errors, addresses are case-insensitive, and every amount is a
decimal **string** of raw units (wei for ETH, the token's smallest unit for tokens: `"1000000"` is 1 USDC).
Check a file with `npx l2-send-guard check-policy policy.json`.

Anything the policy doesn't allow is refused. An empty policy `{}` refuses every send.

Every destination must say what may be sent to it: a `selectors` list, `"type": "eoa"`, or the explicit
`"allowAnySelector": true`. A file with a destination that has none of these doesn't load, and the error names
every such destination. See [Contract destinations](#contract-destinations).

```json
{
  "chains": [8453],
  "window": { "seconds": 86400 },
  "native": { "maxPerTxWei": "…", "windowMaxWei": "…" },
  "destinations": {
    "0x…": { "maxNativeWei": "…", "selectors": ["0x", "deposit()"], "note": "a contract: only these functions" },
    "0x…": { "maxNativeWei": "…", "type": "eoa", "note": "a plain account: ETH transfers only" }
  },
  "tokens": {
    "0x…": {
      "transfer": { "recipients": ["0x…"], "maxAmountRaw": "…" },
      "approve": { "spenders": ["0x…"], "maxAmountRaw": "…", "operators": ["0x…"] },
      "windowMaxAmountRaw": "…",
      "note": "…"
    }
  },
  "permit2": { "maxExpirySeconds": 2592000, "address": "0x…" },
  "delegation": { "mode": "deny", "delegates": ["0x…"], "allowAnyChain": false },
  "accounts": ["0x…"],
  "universalRouter": { "recipients": ["0x…"], "v4Hooks": [], "calldataTag": "strip" },
  "allowContractCreation": false,
  "typedData": { "allowUnknown": false }
}
```

## Keys

| Key | Default | Meaning |
| --- | --- | --- |
| `chains` | any chain | Chain ids this policy may send on. Others → `CHAIN_NOT_ALLOWED` |
| `window.seconds` | `86400` | Length of the rolling window for `windowMaxWei` and `windowMaxAmountRaw` |
| `native.maxPerTxWei` | no cap | ETH one transaction may move, summed over every call inside it |
| `native.windowMaxWei` | no cap | ETH one sender may move per window, across transactions and across all chains in the policy (amounts are summed in wei regardless of chain) |
| `destinations.<address>` | — | A contract or account the agent may call or pay |
| `…maxNativeWei` | no cap | ETH per call to this destination |
| `…selectors` | — (required for contracts) | Functions that may be called, as 4-byte selectors or signatures. `"0x"` allows plain ETH transfers (empty calldata) |
| `…type` | — | `"eoa"`: a plain account. Only plain ETH transfers (empty calldata); takes no `selectors`. `"contract"` is accepted and means the default: a `selectors` list or `allowAnySelector` is required |
| `…allowAnySelector` | `false` | `true` allows **every** function on this destination. Explicit opt-in. The proxy refuses to start with it unless `GUARD_ALLOW_ANY_SELECTOR=1` is also set (in either `GUARD_MODE`), then prints a `WARNING` at startup, in `check-policy`, and for every call it lets through. Can't be combined with `selectors` |
| `tokens.<address>` | — | A token the agent may transfer or approve. Token calls are judged here, not under `destinations` |
| `…transfer.recipients` | none | Who may receive the token (the sender itself always may) |
| `…transfer.maxAmountRaw` | no cap | Per transfer |
| `…approve.spenders` | none | Who may be approved (ERC-20 `approve`/`increaseAllowance`, EIP-2612 `permit`, Permit2) |
| `…approve.maxAmountRaw` | **none allowed** | Approval cap. Without it, every non-zero approval is refused |
| `…approve.operators` | none | Who may get `setApprovalForAll(true)` (NFT collections). A single ERC-721 `approve` uses `spenders` like an ERC-20 approval |
| `…windowMaxAmountRaw` | no cap | Transfers plus approvals of this token per sender per window |
| `permit2.maxExpirySeconds` | 30 days | Longest Permit2 allowance or permit the agent may grant |
| `permit2.address` | canonical Permit2 (zkSync's on 324/300) | Override if your chain uses another deployment |
| `delegation.mode` | `deny` | `deny` refuses every EIP-7702 delegation; `allowlist` allows `delegates` |
| `delegation.delegates` | none | Contracts the account may delegate to |
| `delegation.allowAnyChain` | `false` | Allow authorizations signed for chain id 0 (valid on every chain) |
| `accounts` | none | Smart accounts the agent owns (its Safe, its 4337 wallet). Calls they make are checked one by one, they don't need to be destinations, and their admin functions (modules, owners, threshold, guards, fallback handler) are always refused. So is any other function called on the account itself (or on the sender) that is not a wrapper the guard unpacks (`execute`, `executeBatch`, 7579 `execute`, `multicall`), such as `upgradeToAndCall` or `addOwnerAddress`. An address can't be both an account and a destination, and the router constants `0x…01`/`0x…02` can't be accounts |
| `universalRouter.recipients` | none | Extra addresses a swap's output may go to. The sender and one of `accounts` always may; any other contract in the same transaction (Multicall3, another router) may not (`ROUTER_PAYOUT_TO_WRAPPER`) unless listed here. The router that runs the command (`ADDRESS_THIS`) is only an intermediate step: what a plan puts there must leave in the same plan (`ROUTER_OUTPUT_STRANDED`). `0x…01`/`0x…02` can't be listed |
| `universalRouter.calldataTag` | `"strip"` | `"strip"` takes Uniswap's `unix` calldata tag off a direct call to a Universal Router 2.1.1/2.1.2 before decoding (see [below](#universal-router-calldata-tag)) and names it in the decision log's `notes`. `"refuse"` refuses it like any other trailing bytes (`NON_CANONICAL_ABI`) |
| `universalRouter.v4Hooks` | none | Uniswap v4 hook contracts a swap on a Universal Router 2.1 router may route through. A v4 pool with a hook runs that hook's code inside the swap, and the hook can change the amounts, so a pool key or path hop naming any other non-zero hook is refused (`ROUTER_V4_HOOK_NOT_ALLOWED`). Pools without a hook (the zero address) are always allowed, and the zero address can't be listed. List a hook only if you have read its code |
| `allowContractCreation` | `false` | Allow deploying contracts |
| `typedData.allowUnknown` | `false` | Let the guarded signer sign EIP-712 messages it can't check |
| `note` | — | Free text on destinations and tokens, ignored |

## Contract destinations

A destination is fail-closed: unless you say otherwise, the agent may not call any function on it.

- **How the guard tells a contract call from a transfer.** By calldata, not by looking at the chain. The guard
  is offline, and code can appear at an address later (CREATE2, EIP-7702 delegation), so "is this a
  contract?" can't be answered safely ahead of time. A send with empty calldata (`0x`) is a plain transfer.
  Anything else runs code at the destination and is a contract call.
- **Plain transfers** need no function list. They are allowed to a destination with `"type": "eoa"`, with a
  `selectors` list that contains `"0x"`, or with `allowAnySelector`, within `maxNativeWei`. A plain transfer
  to a contract still runs its `receive`/fallback code; cap it with `maxNativeWei`.
- **Contract calls** need their 4-byte selector in the destination's `selectors`, or `"allowAnySelector": true`.
  Calldata shorter than four bytes runs the contract's fallback and matches nothing, not even `"0x"`. A call
  with calldata to a `"type": "eoa"` destination is refused (`SELECTOR_NOT_ALLOWED`), even if that account
  has since been given code by a 7702 delegation. A destination with no list at all (possible only in a policy
  built in code) refuses every call with calldata (`SELECTORS_REQUIRED`).
- **Wrappers and nesting.** The same check applies to a wrapper call (Multicall3 `aggregate3`, a router's
  `multicall`, Universal Router `execute`) and to each call inside it, at every depth. A router's own
  `multicall(bytes[])` entries run on the router, so each entry's selector must be in the router's list as
  well. Calls inside the agent's own Safe, smart account or 7702 batch are judged against their destinations
  the same way.
- **Why `allowAnySelector` is a separate key** and not `"selectors": "*"`: every other loosening in the policy
  is an explicit `allow…: true` boolean (`allowContractCreation`, `typedData.allowUnknown`,
  `delegation.allowAnyChain`), a boolean can't be mistaken for a selector or a typo in a list, and it can't
  silently mix with a list (both together are an error). `"selectors": "*"` is refused with a pointer to it.
- **Why it also needs `GUARD_ALLOW_ANY_SELECTOR=1`:** whoever runs the proxy has to agree to it, not only whoever
  edits the policy file. It is an environment variable like `GUARD_MODE` but independent of it, so accepting one
  wildcard destination never forces fail-open simulation (`GUARD_MODE=open`), and `open` doesn't accept it either.

## How a transaction is judged

1. 7702 authorizations: clearing a delegation (delegate `0x0`) is always allowed. Otherwise the authorization
   must be for this chain (or chain 0 with `allowAnyChain`) and name an allowed delegate.
2. The call is flattened. Multicall3 (`aggregate*`, `tryAggregate`, `blockAndAggregate`), `multicall(...)`,
   Safe `execTransaction` and `multiSend`, `execute`/`executeBatch` in their common forms, ERC-7821 / ERC-7579
   `execute(bytes32,bytes)` and Universal Router `execute` are unpacked, up to a nesting limit (`TOO_DEEP`).
   A wrapper must itself be an allowed destination unless it's the sender or one of `accounts`, and the
   destination's own function list and `maxNativeWei` apply to the wrapper call too. Account-style wrappers
   (`execute`, `executeBatch`) are only unpacked on the sender or one of `accounts`; on any other contract
   they're an ordinary call to that destination. ERC-7579 modes other than plain call/batch with exec type
   `00` or `01` and a zero mode selector are refused (`MALFORMED_BATCH`). In a Universal Router plan, every
   payout's recipient is recorded, and funds the plan puts into the router itself must leave it by the end of
   that plan (`ROUTER_OUTPUT_STRANDED`). Every input the guard unpacks (each wrapper's arguments, each
   Universal Router command input, ERC-7579 execution data, token and Permit2 calls) is decoded as the target
   contract decodes it, re-encoded and compared byte for byte; anything else is `NON_CANONICAL_ABI`. A V3
   path must be a token followed by whole pools (fee + token), 20 + 23·k bytes. Universal Router inputs are
   read with the 1.x/2.0 layout, except on the official Universal Router 2.1.1 and 2.1.2 addresses of the
   built-in chains, which are read with the 2.1 layout: command mask `0x7f`, a sixth `minHopPriceX36` argument
   on V2/V3 swaps (empty or one per hop), `PAY_PORTION_FULL_PRECISION` (`0x07`, a payout), and `V4_SWAP`
   (`0x10`). In a `V4_SWAP` each action's params are decoded with the 2.1 structs and must round-trip; only the
   swap, `SETTLE`, `SETTLE_ALL`, `TAKE`, `TAKE_ALL` and `TAKE_PORTION` actions are accepted. Takes are payouts
   (`TAKE_ALL` pays the router's caller), and a take into the router is put on the plan's ledger. A settle the
   router pays (`payerIsUser` false, or native ETH) counts as spending what the router holds when it pays
   `CONTRACT_BALANCE`, an explicit amount, or the open delta of a currency used in that `V4_SWAP` only as the
   input of exact-input swaps with explicit amounts and settled once (then the debt is their sum). Pools with
   a hook need `universalRouter.v4Hooks`. `ACROSS_V4_DEPOSIT_V3` (`0x40`) and the rest of `0x40`–`0x7f` are
   refused (`ROUTER_COMMAND_UNCHECKED`). `executeSigned` is unpacked like `execute`. WETH is recognised by the router's own WETH address on the chains the
   proxy ships templates for; on other chains, `SWEEP` the WETH instead of `UNWRAP_WETH`.
   One Uniswap calldata tag may be taken off a direct call to a 2.1 router before it is decoded (see
   [below](#universal-router-calldata-tag)).
3. Each inner call is judged:
   - a Universal Router payout must go to the sender, one of `accounts` or a `universalRouter.recipients` entry
     (`ADDRESS_THIS` only as an intermediate step, see above);
   - a self-call with no data and no value (cancelling a stuck nonce) is allowed;
   - calls to Permit2 use the `approve` rules and the expiry cap; unknown Permit2 functions are refused;
   - token calls (`transfer`, `transferFrom`, `safeTransferFrom`, `safeBatchTransferFrom`, `approve`,
     `increaseAllowance`, `approveAndCall`, `permit`, `setApprovalForAll`) use the `tokens` rules.
     `decreaseAllowance`, approvals of 0 and `setApprovalForAll(false)` are allowed on any token listed in
     `tokens` or `destinations` (a "reducing" call to an unknown contract is just an unknown call);
   - ETH sent along with a token call must be allowed by the token's own destination entry (its function list
     and `maxNativeWei`);
   - anything else must go to a listed destination, within its function list (see
     [Contract destinations](#contract-destinations)) and `maxNativeWei`.
4. ETH moved across the whole transaction is checked against `maxPerTxWei`, then the rolling caps are reserved.

An approval of ≥ 2^128 (≥ 2^160 − 1 for Permit2's `uint160`) counts as unlimited and is always refused, as is a
DAI-style `permit(..., allowed=true)`.

**Don't list a token contract under `destinations`** unless you need a function the guard doesn't decode, and
then list just that function in `selectors`. With `allowAnySelector` on a token, any undecoded function on it,
such as `transferWithAuthorization`, is allowed. `check-policy` warns about this.


## Universal Router calldata tag

Most Universal Router 2.1.2 transactions built by Uniswap's Trading API end in a tag after the ABI-encoded
arguments. It is taken off before decoding (with `universalRouter.calldataTag` `"strip"`, the default) only when:

- the transaction's `to` is one of the built-in Universal Router 2.1.1/2.1.2 addresses for the chain it is sent
  on, and its selector is `execute(bytes,bytes[],uint256)` (`0x3593564c`), `execute(bytes,bytes[])`
  (`0x24856bc3`) or `executeSigned(bytes,bytes[],bytes32,bytes32,bool,bytes32,bytes,uint256)` (`0x44684dc3`);
- the calldata is 4 + 32·k + 10 or 4 + 32·k + 22 bytes long (canonical calldata is 4 + 32·k, so a canonical
  call is never cut), and its last 10 or 22 bytes are exactly one of:

  | Length | Bytes | Value |
  |---|---|---|
  | 10 | 0–9 | `756e697800000000000c` exactly |
  | 22 | 0–3 | `756e6978` (ASCII `unix`) |
  | | 4–11 | uint64 big-endian milliseconds since 1970, at least 1 600 000 000 000 (2020-09-13) and below 2^48 |
  | | 12–13 | `8000` |
  | | 14–19 | any |
  | | 20 | `01` or `02` |
  | | 21 | `00` |

- what is left is then decoded and must be the exact canonical encoding, as for any other call.

The decision log line (and the `l2sg` metadata of the response) gets a `notes` entry naming the stripped tag. The
transaction is forwarded as signed, tag included.

Anything else after the arguments is `NON_CANONICAL_ABI`, including two tags, a tag next to other bytes, a tag
on a router call made through Multicall3 or a smart account (the tag is only looked for on the transaction's own
calldata), a tag inside a command input or v4 action, and a tag on a 2.0 router or any other contract.

Why this is safe: the 2.1.1 and 2.1.2 contracts (verified on Sourcify for all twelve built-in addresses,
identical to Uniswap/universal-router `802fe4c`) never read `msg.data`, `calldatasize` or `calldatacopy`;
`execute` and `executeSigned` read only their ABI arguments, and `executeSigned`'s EIP-712 signature covers
the decoded arguments, not the calldata. Bytes after the arguments cost gas and nothing else. The tag's origin is
not documented by Uniswap; the two forms above are the only ones seen in a sample of 96 transactions on four
chains, and anything outside them is refused until it is understood.

## Deny codes

`error.data.policyCode` on `-32083` (and on `-32087` / `-32088` for the last four):

| Code | Meaning |
| --- | --- |
| `TX_UNPARSEABLE` | The raw transaction didn't decode |
| `SENDER_UNRECOVERABLE` | The signature doesn't recover a sender |
| `CHAIN_NOT_ALLOWED` | Chain id not in `chains` |
| `METHOD_NOT_GATED` | A submit method the guard can't check (e.g. `eth_sendUserOperation`) |
| `CONTRACT_CREATION_DENIED` | Deploying a contract without `allowContractCreation` |
| `DESTINATION_NOT_ALLOWED` | Call or payment to an address that isn't listed |
| `SELECTOR_NOT_ALLOWED` | Function not in the destination's `selectors`, calldata shorter than a selector, or calldata to a `"type": "eoa"` destination |
| `SELECTORS_REQUIRED` | Calldata to a destination that has no function list (a policy built in code; a policy file can't load without one) |
| `OVER_CAP` | Over `maxPerTxWei` or a destination's `maxNativeWei` |
| `TOKEN_NOT_ALLOWED` | Token not in `tokens`, or a token function the guard doesn't handle |
| `RECIPIENT_NOT_ALLOWED` | Token recipient not in `transfer.recipients` |
| `TRANSFER_OVER_CAP` | Over `transfer.maxAmountRaw` |
| `SPENDER_NOT_ALLOWED` | Spender not in `approve.spenders` |
| `APPROVAL_UNLIMITED` | An effectively unlimited approval |
| `APPROVAL_OVER_CAP` | Over `approve.maxAmountRaw` (or no cap set) |
| `OPERATOR_APPROVAL_DENIED` | `setApprovalForAll` / NFT approval to an unlisted operator |
| `PERMIT2_EXPIRY_TOO_LONG` | Permit2 expiry beyond `permit2.maxExpirySeconds` |
| `PERMIT2_CALL_UNKNOWN` | A Permit2 function the guard doesn't decode |
| `AUTHORIZATION_DENIED` | 7702 delegation to a contract that isn't allowed |
| `AUTHORIZATION_ANY_CHAIN` | 7702 authorization for chain 0 without `allowAnyChain` |
| `AUTHORIZATION_WRONG_CHAIN` | 7702 authorization for another chain |
| `AUTHORIZATION_UNRECOVERABLE` | 7702 authorization signature doesn't recover |
| `POISONED_ADDRESS` | The receive watch flagged this address as a look-alike |
| `NON_CANONICAL_ABI` | Calldata the target would read differently from the guard or partly ignore: not the exact standard ABI encoding (trailing bytes other than one [Universal Router calldata tag](#universal-router-calldata-tag), unusual offsets or lengths, dirty padding), a Universal Router input that doesn't round-trip, a V3 path that isn't 20 + 23·k bytes, an ERC-7579 mode with a payload, or Universal Router calldata built for the other layout (2.0 inputs sent to a 2.1 router, or the reverse). On a 2.0 router: a command byte with bit `0x40`. On a 2.1 router: a `minHopPriceX36` whose length is neither 0 nor the hop count, or an empty v4 path |
| `CALLDATA_TOO_LARGE` | The transaction's calldata is over 128 KiB; refused before anything is decoded |
| `DELEGATECALL_DENIED` | A delegatecall other than a Safe's call to MultiSend |
| `TOO_DEEP` | Batches nested too deeply |
| `MALFORMED_BATCH` | A batch that doesn't decode cleanly |
| `ROUTER_COMMAND_UNCHECKED` | A Universal Router command the guard can't check |
| `ROUTER_RECIPIENT_NOT_ALLOWED` | Swap output (including a v4 `TAKE`/`TAKE_PORTION`/`TAKE_ALL`) going to someone else |
| `ROUTER_PAYOUT_TO_WRAPPER` | Swap output (including a v4 `TAKE`/`TAKE_PORTION`/`TAKE_ALL`) going to another contract in the same transaction (e.g. the Multicall3 that called the router, directly or through the `MSG_SENDER` constant), where anyone could take it |
| `ROUTER_OUTPUT_STRANDED` | A Universal Router plan leaves funds in the router itself: a swap, `WRAP_ETH`/`UNWRAP_WETH`, Permit2 pull or v4 `TAKE`/`TAKE_PORTION` to `ADDRESS_THIS`, or ETH sent with the call, with no later `SWEEP`/`UNWRAP_WETH` to an allowed payee (or swap spending the whole balance). Anyone can take a balance left in the router. A sweep back to `ADDRESS_THIS`, a partial `TRANSFER`/`PAY_PORTION` and commands flagged "allow revert" don't count. The check assumes an exact-input swap spends its whole `amountIn`. If a pool runs out of liquidity (or a listed v4 hook changes the amounts), the unspent rest stays in the router. Set `amountOutMinimum` so a partial fill reverts |
| `ROUTER_V4_HOOK_NOT_ALLOWED` | A Universal Router 2.1 v4 swap routes through a pool whose hook isn't in `universalRouter.v4Hooks` |
| `WINDOW_CAP_EXCEEDED` | Over a rolling cap |
| `TYPED_DATA_UNKNOWN` | (guarded signer) EIP-712 message it can't check |
| `TYPED_DATA_AUTHORIZES_TX` | (guarded signer) `SafeTx`, `SafeMessage` or a 4337 user operation: always refused |
| `MESSAGE_SIGNING_DENIED` | (guarded signer) `signMessage` without a matching `allowMessage` |
| `ACCOUNT_ADMIN_DENIED` | A call with data on the sender or one of `accounts` that is not a wrapper the guard unpacks: an admin call (module, owner, threshold, guard, fallback handler) or any other account function (`upgradeToAndCall`, `addOwnerAddress`, validator installs). Applies even if the sender is listed as a destination. |
| `REPLAYABLE_TX` | A legacy transaction without a chain id |
| `INTERNAL_ERROR` | The policy check itself failed unexpectedly; nothing was sent |
| `IDEMPOTENCY_CONFLICT` | `-32087`: key already sent another transaction |
| `STORE_DOWN` | `-32087`: the state store failed, so nothing was sent |
| `CHAIN_READ_FAILED` | `-32087`: the RPC didn't answer the bypass check's nonce read, so nothing was sent |
| `BYPASS_LOCKED` | `-32088`: sender locked after a transaction landed without the guard |
