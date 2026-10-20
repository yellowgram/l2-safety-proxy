# Policy reference

A policy is one JSON file. Unknown keys are errors, addresses are case-insensitive, and every amount is a
decimal **string** of raw units (wei for ETH, the token's smallest unit for tokens: `"1000000"` is 1 USDC).
Check a file with `npx l2-send-guard check-policy policy.json`.

Anything the policy doesn't allow is refused. An empty policy `{}` refuses every send.

```json
{
  "chains": [8453],
  "window": { "seconds": 86400 },
  "native": { "maxPerTxWei": "…", "windowMaxWei": "…" },
  "destinations": { "0x…": { "maxNativeWei": "…", "selectors": ["0x", "deposit()"], "note": "…" } },
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
  "universalRouter": { "recipients": ["0x…"] },
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
| `…selectors` | any function | Functions that may be called, as 4-byte selectors or signatures. `"0x"` allows plain ETH transfers |
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
| `accounts` | none | Smart accounts the agent owns (its Safe, its 4337 wallet). Calls they make are checked one by one, they don't need to be destinations, and their admin functions (modules, owners, threshold, guards, fallback handler) are always refused. So is any other function called on the account itself (or on the sender) that is not a wrapper the guard unpacks (`execute`, `executeBatch`, 7579 `execute`, `multicall`), such as `upgradeToAndCall` or `addOwnerAddress`. An address can't be both an account and a destination |
| `universalRouter.recipients` | none | Extra addresses a swap's output may go to (the sender and the router always may) |
| `allowContractCreation` | `false` | Allow deploying contracts |
| `typedData.allowUnknown` | `false` | Let the guarded signer sign EIP-712 messages it can't check |
| `note` | — | Free text on destinations and tokens, ignored |

## How a transaction is judged

1. 7702 authorizations: clearing a delegation (delegate `0x0`) is always allowed. Otherwise the authorization
   must be for this chain (or chain 0 with `allowAnyChain`) and name an allowed delegate.
2. The call is flattened. Multicall3 (`aggregate*`, `tryAggregate`, `blockAndAggregate`), `multicall(...)`,
   Safe `execTransaction` and `multiSend`, `execute`/`executeBatch` in their common forms, ERC-7821 / ERC-7579
   `execute(bytes32,bytes)` and Universal Router `execute` are unpacked, up to a nesting limit (`TOO_DEEP`).
   A wrapper must itself be an allowed destination unless it's the sender or one of `accounts`, and the
   destination's own `selectors` and `maxNativeWei` apply to the wrapper call too. Account-style wrappers
   (`execute`, `executeBatch`) are only unpacked on the sender or one of `accounts`; on any other contract
   they're an ordinary call to that destination. ERC-7579 modes other than plain call/batch with exec type
   `00` or `01` and a zero mode selector are refused (`MALFORMED_BATCH`).
3. Each inner call is judged:
   - a self-call with no data and no value (cancelling a stuck nonce) is allowed;
   - calls to Permit2 use the `approve` rules and the expiry cap; unknown Permit2 functions are refused;
   - token calls (`transfer`, `transferFrom`, `safeTransferFrom`, `safeBatchTransferFrom`, `approve`,
     `increaseAllowance`, `approveAndCall`, `permit`, `setApprovalForAll`) use the `tokens` rules.
     `decreaseAllowance`, approvals of 0 and `setApprovalForAll(false)` are allowed on any token listed in
     `tokens` or `destinations` (a "reducing" call to an unknown contract is just an unknown call);
   - anything else must go to a listed destination, within its `selectors` and `maxNativeWei`.
4. ETH moved across the whole transaction is checked against `maxPerTxWei`, then the rolling caps are reserved.

An approval of ≥ 2^128 (≥ 2^160 − 1 for Permit2's `uint160`) counts as unlimited and is always refused, as is a
DAI-style `permit(..., allowed=true)`.

**Don't list a token contract under `destinations`** unless you need a function the guard doesn't decode, and
then set `selectors`. A destination entry without `selectors` allows any undecoded function on that contract,
such as `transferWithAuthorization`. `check-policy` warns about this.

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
| `SELECTOR_NOT_ALLOWED` | Function not in the destination's `selectors` |
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
| `NON_CANONICAL_ABI` | Calldata that decodes two ways (padding tricks) |
| `DELEGATECALL_DENIED` | A delegatecall other than a Safe's call to MultiSend |
| `TOO_DEEP` | Batches nested too deeply |
| `MALFORMED_BATCH` | A batch that doesn't decode cleanly |
| `ROUTER_COMMAND_UNCHECKED` | A Universal Router command the guard can't check |
| `ROUTER_RECIPIENT_NOT_ALLOWED` | Swap output going to someone else |
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
