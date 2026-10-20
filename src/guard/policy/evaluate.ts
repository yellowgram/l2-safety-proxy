import { toFunctionSelector, zeroAddress, type Address, type Hex } from "viem";
import { EFFECTIVELY_UNLIMITED, MAX_CALLDATA_BYTES, NonCanonicalAbi, UINT160_MAX, decodeKnown, selectorOf } from "../abi.js";
import { DecodeDenied, UR_WETH, flattenCalls, routerCalldataTag, ur21Routers, type Leaf } from "../calls.js";
import type { Authorization } from "../tx.js";
import { permit2For } from "./load.js";
import type { DenyCode, DestinationRule, Policy, Spend, TokenRule, Verdict } from "./types.js";

export interface TxInput {
  from?: Address;
  to?: Address;
  value: bigint;
  data: Hex;
  chainId?: number;
  authorizationList?: Authorization[];
}

export interface EvaluateOptions {
  /** Chain the tx is being sent on. Required for 7702 and Permit2 checks. */
  chainId: number;
  /** Unix seconds. Default: now. */
  now?: number;
  /** Addresses flagged by the receive watch (address poisoning). Lowercase. */
  poisoned?: Set<string>;
}

class Deny extends Error {
  constructor(public code: DenyCode, message: string, public path?: string) {
    super(message);
  }
}

const lc = (a: string) => a.toLowerCase();

/** Safe and ERC-7579 functions that change who controls an account. */
const ACCOUNT_ADMIN_SELECTORS = new Map<string, string>(
  [
    "enableModule(address)",
    "disableModule(address,address)",
    "addOwnerWithThreshold(address,uint256)",
    "removeOwner(address,address,uint256)",
    "swapOwner(address,address,address)",
    "changeThreshold(uint256)",
    "setGuard(address)",
    "setModuleGuard(address)",
    "setFallbackHandler(address)",
    "installModule(uint256,address,bytes)",
    "uninstallModule(uint256,address,bytes)",
  ].map((sig) => [toFunctionSelector(`function ${sig}`).toLowerCase(), sig])
);

/**
 * Judge one transaction against the policy. Pure: no network, no state.
 * Rolling caps are applied separately (see `checkWindow`) using `verdict.spend`.
 */
export function evaluateTx(policy: Policy, tx: TxInput, opts: EvaluateOptions): Verdict {
  const spend: Spend = { native: 0n, tokens: new Map() };
  const outer = warnings;
  const outerNotes = notes;
  warnings = [];
  notes = [];
  const withNotes = (v: Verdict): Verdict => (notes.length > 0 ? { ...v, notes } : v);
  try {
    run(policy, tx, opts, spend);
    return withNotes(warnings.length > 0 ? { allow: true, spend, warnings } : { allow: true, spend });
  } catch (err) {
    if (err instanceof Deny) return withNotes({ allow: false, code: err.code, reason: err.message, path: err.path, spend });
    if (err instanceof DecodeDenied) return withNotes({ allow: false, code: err.code as DenyCode, reason: err.message, path: err.path, spend });
    throw err;
  } finally {
    warnings = outer;
    notes = outerNotes;
  }
}

/** Collects per-call warnings while evaluateTx runs (it is synchronous). */
let warnings: string[] = [];
/** Collects notes (Verdict.notes) the same way. */
let notes: string[] = [];

function run(policy: Policy, tx: TxInput, opts: EvaluateOptions, spend: Spend) {
  // Checked before anything is decoded: no legitimate send needs more, and decoding is the expensive part.
  const bytes = (tx.data.length - 2) / 2;
  if (bytes > MAX_CALLDATA_BYTES) {
    throw new Deny("CALLDATA_TOO_LARGE", `calldata is ${bytes} bytes; the guard decodes at most ${MAX_CALLDATA_BYTES}`);
  }
  const chainId = opts.chainId;
  if (policy.chains.size > 0 && !policy.chains.has(chainId)) {
    throw new Deny("CHAIN_NOT_ALLOWED", `chain ${chainId} is not in the policy's chains list`);
  }
  checkAuthorizations(policy, tx.authorizationList ?? [], chainId);

  const permit2 = permit2For(policy, chainId);
  // The Trading API's calldata tag on a direct call to a 2.1 router: the router never reads it, so it is
  // taken off before the arguments are decoded and must then be the exact canonical encoding. Only the
  // transaction's own calldata is looked at; a tag anywhere else is trailing bytes like any other.
  let data = tx.data;
  const tagged = policy.universalRouter.calldataTag === "strip" ? routerCalldataTag(tx.to, tx.data, chainId) : undefined;
  if (tagged) {
    data = tagged.data;
    notes.push(`stripped the Universal Router calldata tag ${tagged.tag} (${(tagged.tag.length - 2) / 2} bytes) after the arguments before decoding`);
  }
  const flat = flattenCalls(
    { to: tx.to, value: tx.value, data },
    { sender: tx.from, accounts: policy.accounts, permit2, weth: UR_WETH[chainId], ur21: ur21Routers(chainId), v4Hooks: policy.universalRouter.v4Hooks }
  );
  const sender = tx.from ? lc(tx.from) : undefined;

  // A wrapper (Multicall3, a router, someone else's Safe) must itself be an allowed
  // destination unless it is the agent's own account, and that destination's own rule
  // (selectors, maxNativeWei) applies to the wrapper call before its contents are judged.
  for (const w of flat.wrappers) {
    const t = lc(w.to);
    if (t === sender || policy.accounts.has(t)) continue;
    withinDestination(destination(policy, t, w.path, opts.poisoned), t, { data: w.selector, value: w.value }, w.path, w.name);
  }

  spend.native += tx.value;
  for (const leaf of flat.leaves) {
    if (leaf.kind === "payout") {
      // A payout may go to the sender, one of the agent's accounts, a listed recipient, or, as a
      // step inside the plan, the router that runs the command (ADDRESS_THIS): flattenCalls already
      // denied any plan that leaves funds there at its end (ROUTER_OUTPUT_STRANDED). Never to another
      // contract in the same transaction (Multicall3, a second router): anyone can take funds left there.
      const r = lc(leaf.recipient);
      const router = lc(leaf.router);
      if (r !== sender && r !== router && !policy.accounts.has(r) && !policy.universalRouter.recipients.has(r)) {
        if (flat.wrappers.some((w) => lc(w.to) === r)) {
          throw new Deny(
            "ROUTER_PAYOUT_TO_WRAPPER",
            `router ${router} pays out to ${r}, another contract in this transaction; funds left there can be taken by anyone. Pay the sender instead`,
            leaf.path
          );
        }
        throw new Deny("ROUTER_RECIPIENT_NOT_ALLOWED", `router ${router} pays out to ${leaf.recipient}, which is not the sender or an allowed recipient`, leaf.path);
      }
      continue;
    }
    if (leaf.path !== "tx" && leaf.fromAccount) spend.native += leaf.value;
    judgeLeaf(policy, leaf, { sender, permit2, now: opts.now ?? Math.floor(Date.now() / 1000), poisoned: opts.poisoned }, spend);
  }

  if (policy.native.maxPerTxWei !== undefined && spend.native > policy.native.maxPerTxWei) {
    throw new Deny("OVER_CAP", `moves ${spend.native} wei; the per-transaction cap is ${policy.native.maxPerTxWei}`);
  }
}

function checkAuthorizations(policy: Policy, list: Authorization[], chainId: number) {
  list.forEach((a, i) => {
    const path = `authorizationList[${i}]`;
    if (!a.authority) throw new Deny("AUTHORIZATION_UNRECOVERABLE", "7702 authorization signature does not recover", path);
    const delegate = lc(a.delegate);
    if (delegate === zeroAddress) return; // removing a delegation is always allowed
    if (a.chainId === 0 && !policy.delegation.allowAnyChain) {
      throw new Deny("AUTHORIZATION_ANY_CHAIN", `7702 authorization for ${a.authority} is valid on every chain (chainId 0)`, path);
    }
    if (a.chainId !== 0 && a.chainId !== chainId) {
      throw new Deny("AUTHORIZATION_WRONG_CHAIN", `7702 authorization is for chain ${a.chainId}, not ${chainId}`, path);
    }
    if (policy.delegation.mode === "deny" || !policy.delegation.delegates.has(delegate)) {
      throw new Deny("AUTHORIZATION_DENIED", `7702 authorization delegates ${a.authority} to ${a.delegate}, which is not an allowed delegate`, path);
    }
  });
}

function destination(policy: Policy, to: string, path: string, poisoned?: Set<string>) {
  if (poisoned?.has(to)) throw new Deny("POISONED_ADDRESS", `${to} sent the agent look-alike dust (address poisoning)`, path);
  const rule = policy.destinations.get(to);
  if (!rule) throw new Deny("DESTINATION_NOT_ALLOWED", `${to} is not an allowed destination`, path);
  return rule;
}

interface LeafCtx {
  sender?: string;
  permit2: string;
  now: number;
  poisoned?: Set<string>;
}

function add(spend: Spend, token: string, amount: bigint) {
  spend.tokens.set(token, (spend.tokens.get(token) ?? 0n) + amount);
}

function decode(data: Hex, group: "token" | "permit2", path: string) {
  try {
    return decodeKnown(data, group);
  } catch (err) {
    if (err instanceof NonCanonicalAbi) throw new Deny("NON_CANONICAL_ABI", err.message, path);
    throw err;
  }
}

function judgeLeaf(policy: Policy, leaf: Extract<Leaf, { kind: "call" }>, ctx: LeafCtx, spend: Spend) {
  const { path } = leaf;
  if (!leaf.to) {
    if (!policy.allowContractCreation) throw new Deny("CONTRACT_CREATION_DENIED", "contract creation is not allowed", path);
    return;
  }
  const to = lc(leaf.to);
  if (ctx.poisoned?.has(to)) throw new Deny("POISONED_ADDRESS", `${to} sent the agent look-alike dust (address poisoning)`, path);

  // Self-call with no data and no value: the standard way to cancel a stuck nonce.
  if (to === ctx.sender && leaf.data === "0x" && leaf.value === 0n) return;

  // The agent's own account changing who controls it (owners, threshold, modules, guards,
  // fallback handler) is never something a spend policy should allow.
  const sel0 = (selectorOf(leaf.data) ?? "0x").toLowerCase();
  const ownAccount = to === ctx.sender || policy.accounts.has(to);
  if (ownAccount && ACCOUNT_ADMIN_SELECTORS.has(sel0)) {
    throw new Deny("ACCOUNT_ADMIN_DENIED", `${ACCOUNT_ADMIN_SELECTORS.get(sel0)} on the agent's account ${to} changes who controls it and is always denied`, path);
  }
  // Wrappers on the agent's own account (execute, executeBatch, 7579 execute, multicall) were
  // unpacked into their inner calls before this point, so any other function reaching here runs
  // the account's (or its 7702 delegate's) own code: upgradeToAndCall, addOwner*, validator
  // installs and the like. The guard can't know them all, so none is allowed, even when the
  // account is also listed as a destination.
  if (ownAccount && leaf.data !== "0x") {
    throw new Deny("ACCOUNT_ADMIN_DENIED", `function ${sel0} on the agent's own account ${to} is not a wrapper the guard can see into (execute, executeBatch, multicall); other account functions can change who controls it and are always denied`, path);
  }

  if (to === ctx.permit2) return judgePermit2(policy, leaf, ctx, spend);

  const tok = decode(leaf.data, "token", path);
  if (tok) return judgeToken(policy, to, tok.name, tok.signature, tok.args, leaf, ctx, spend);

  withinDestination(destination(policy, to, path, ctx.poisoned), to, leaf, path);
}

/**
 * A listed destination's own limits: which functions may be called on it, and its maxNativeWei.
 *
 * Fail closed: a call with calldata runs code at `to` (a contract, or an account with a 7702
 * delegation), so it needs its selector in `selectors`, or the destination's explicit
 * `allowAnySelector: true`. Without either it is denied. Only a plain value transfer (empty
 * calldata) needs no list. Whether `to` is a contract is never looked up: the guard is offline,
 * and code can appear at an address later (CREATE2, 7702), so calldata presence decides.
 */
function withinDestination(rule: DestinationRule, to: string, leaf: { data: Hex; value: bigint }, path: string, name?: string) {
  if (rule.anySelector && leaf.data.length > 2) {
    const sel = selectorOf(leaf.data) ?? leaf.data;
    warnings.push(`allowAnySelector: function ${sel}${name ? ` (${name})` : ""} on ${to} at ${path} was allowed without a selectors list`);
  }
  if (!rule.anySelector) {
    const plain = leaf.data.length <= 2;
    const sel = plain ? "0x" : selectorOf(leaf.data);
    const fn = `function ${sel ?? leaf.data}${name ? ` (${name})` : ""}`;
    if (rule.selectors) {
      if (sel === undefined) {
        throw new Deny("SELECTOR_NOT_ALLOWED", `calldata ${leaf.data} to ${to} is shorter than a 4-byte selector (it would run the contract's fallback); not allowed`, path);
      }
      if (!rule.selectors.has(sel)) throw new Deny("SELECTOR_NOT_ALLOWED", `${fn} on ${to} is not in its allowed selectors`, path);
    } else if (!plain) {
      if (rule.eoa) {
        throw new Deny("SELECTOR_NOT_ALLOWED", `${to} is declared "type": "eoa" (plain ETH transfers only), so ${fn} on it is denied`, path);
      }
      throw new Deny(
        "SELECTORS_REQUIRED",
        `${to} has no "selectors" list, so ${fn} on it is denied. List the functions it may be called with in "selectors", or set "allowAnySelector": true`,
        path
      );
    }
  }
  if (rule.maxNativeWei !== undefined && leaf.value > rule.maxNativeWei) {
    throw new Deny("OVER_CAP", `sends ${leaf.value} wei to ${to}; its cap is ${rule.maxNativeWei}`, path);
  }
}

function tokenRule(policy: Policy, token: string, path: string): TokenRule {
  const rule = policy.tokens.get(token);
  if (!rule) throw new Deny("TOKEN_NOT_ALLOWED", `${token} is not in the policy's tokens; transfers and approvals on it are denied`, path);
  return rule;
}

function transfer(policy: Policy, token: string, recipient: string, amt: bigint, ctx: LeafCtx, spend: Spend, path: string) {
  const rule = tokenRule(policy, token, path);
  if (ctx.poisoned?.has(recipient)) throw new Deny("POISONED_ADDRESS", `${recipient} sent the agent look-alike dust (address poisoning)`, path);
  if (recipient !== ctx.sender && !rule.transfer.recipients.has(recipient)) {
    throw new Deny("RECIPIENT_NOT_ALLOWED", `${recipient} is not an allowed recipient of ${token}`, path);
  }
  if (rule.transfer.maxAmountRaw !== undefined && amt > rule.transfer.maxAmountRaw) {
    throw new Deny("TRANSFER_OVER_CAP", `transfer of ${amt} ${token} is over its cap ${rule.transfer.maxAmountRaw}`, path);
  }
  if (recipient !== ctx.sender) add(spend, token, amt);
}

/**
 * A call that only reduces a permission (revoke, decreaseAllowance, setApprovalForAll(false))
 * is allowed without token caps, but only on a contract the policy knows: on an unknown
 * contract the same selector could be any function.
 */
function reducing(policy: Policy, token: string, path: string, poisoned: Set<string> | undefined, leaf: { data: Hex; value: bigint }) {
  if (policy.tokens.has(token)) return;
  // Not a listed token, so it is a listed destination, and that destination's own selectors
  // and maxNativeWei still apply (value can reach a contract through its fallback).
  withinDestination(destination(policy, token, path, poisoned), token, leaf, path);
}

function approval(policy: Policy, token: string, spender: string, amt: bigint, spend: Spend, path: string, unlimitedAt = EFFECTIVELY_UNLIMITED, poisoned?: Set<string>, leaf?: { data: Hex; value: bigint }) {
  if (amt === 0n) {
    // A Permit2 revoke (UINT160 scale) is a call to the pinned Permit2 contract, not to `token`.
    if (unlimitedAt !== UINT160_MAX) reducing(policy, token, path, poisoned, leaf ?? { data: "0x", value: 0n });
    return;
  }
  const rule = tokenRule(policy, token, path);
  if (amt >= unlimitedAt) throw new Deny("APPROVAL_UNLIMITED", `unlimited approval of ${token} to ${spender}`, path);
  if (!rule.approve.spenders.has(spender)) throw new Deny("SPENDER_NOT_ALLOWED", `${spender} is not an allowed spender of ${token}`, path);
  if (rule.approve.maxAmountRaw === undefined || amt > rule.approve.maxAmountRaw) {
    throw new Deny("APPROVAL_OVER_CAP", `approval of ${amt} ${token} to ${spender} is over its cap ${rule.approve.maxAmountRaw ?? "(none set)"}`, path);
  }
  add(spend, token, amt);
}

function judgeToken(
  policy: Policy,
  token: string,
  name: string,
  signature: string,
  args: readonly unknown[],
  leaf: Extract<Leaf, { kind: "call" }>,
  ctx: LeafCtx,
  spend: Spend
) {
  const { path } = leaf;
  const a = (i: number) => args[i] as string;
  const n = (i: number) => args[i] as bigint;
  // ETH sent along with a token call reaches the token contract: it must be a listed destination
  // whose own function list and maxNativeWei allow it.
  if (leaf.value > 0n) withinDestination(destination(policy, token, path, ctx.poisoned), token, leaf, path);
  switch (signature) {
    case "transfer(address,uint256)":
      return transfer(policy, token, lc(a(0)), n(1), ctx, spend, path);
    case "transferFrom(address,address,uint256)":
    case "safeTransferFrom(address,address,uint256)":
    case "safeTransferFrom(address,address,uint256,bytes)":
      // ERC-721 shares the transferFrom selector; amount is a tokenId there, so the
      // recipient rule is what protects it. Count 1 per NFT for caps.
      return transfer(policy, token, lc(a(1)), signature.startsWith("safe") ? 1n : n(2), ctx, spend, path);
    case "safeTransferFrom(address,address,uint256,uint256,bytes)":
      return transfer(policy, token, lc(a(1)), n(3), ctx, spend, path);
    case "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)":
      return transfer(policy, token, lc(a(1)), (args[3] as bigint[]).reduce((x, y) => x + y, 0n), ctx, spend, path);
    case "approve(address,uint256)":
    case "increaseAllowance(address,uint256)":
    case "increaseApproval(address,uint256)":
    case "approveAndCall(address,uint256,bytes)":
      return approval(policy, token, lc(a(0)), n(1), spend, path, EFFECTIVELY_UNLIMITED, ctx.poisoned, leaf);
    case "decreaseAllowance(address,uint256)":
      return reducing(policy, token, path, ctx.poisoned, leaf);
    case "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)":
      return approval(policy, token, lc(a(1)), n(2), spend, path, EFFECTIVELY_UNLIMITED, ctx.poisoned, leaf);
    case "permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)":
      // DAI-style permit: allowed=true is an unlimited approval.
      if (args[4] === true) throw new Deny("APPROVAL_UNLIMITED", `DAI-style permit grants ${a(1)} unlimited ${token}`, path);
      return reducing(policy, token, path, ctx.poisoned, leaf);
    case "setApprovalForAll(address,bool)": {
      if (args[1] === false) return reducing(policy, token, path, ctx.poisoned, leaf);
      const rule = tokenRule(policy, token, path);
      if (!rule.approve.operators.has(lc(a(0)))) {
        throw new Deny("OPERATOR_APPROVAL_DENIED", `setApprovalForAll(true) for ${a(0)} on ${token} (operator not listed)`, path);
      }
      return;
    }
  }
  throw new Deny("TOKEN_NOT_ALLOWED", `unhandled token function ${name}`, path);
}

function judgePermit2(policy: Policy, leaf: Extract<Leaf, { kind: "call" }>, ctx: LeafCtx, spend: Spend) {
  const { path } = leaf;
  const d = decode(leaf.data, "permit2", path);
  if (!d) throw new Deny("PERMIT2_CALL_UNKNOWN", `unknown Permit2 function ${selectorOf(leaf.data) ?? "(none)"}`, path);
  const expiry = (e: bigint, what: string) => {
    // Permit2 treats expiration 0 as "expires at the end of this block".
    if (e !== 0n && e > BigInt(ctx.now + policy.permit2.maxExpirySeconds)) {
      throw new Deny("PERMIT2_EXPIRY_TOO_LONG", `${what} expires at ${e}, beyond the policy's ${policy.permit2.maxExpirySeconds}s limit`, path);
    }
  };
  type Details = { token: string; amount: bigint; expiration: bigint };
  switch (d.signature) {
    case "approve(address,address,uint160,uint48)": {
      const [token, spender, amount, expiration] = d.args as [string, string, bigint, bigint];
      expiry(expiration, "Permit2 approval");
      return approval(policy, lc(token), lc(spender), amount, spend, path, UINT160_MAX);
    }
    case "permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)": {
      const [, p] = d.args as [string, { details: Details; spender: string; sigDeadline: bigint }];
      expiry(p.details.expiration, "Permit2 permit");
      return approval(policy, lc(p.details.token), lc(p.spender), p.details.amount, spend, path, UINT160_MAX);
    }
    case "permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)": {
      const [, p] = d.args as [string, { details: Details[]; spender: string }];
      for (const x of p.details) {
        expiry(x.expiration, "Permit2 permit");
        approval(policy, lc(x.token), lc(p.spender), x.amount, spend, path, UINT160_MAX);
      }
      return;
    }
    case "transferFrom(address,address,uint160,address)": {
      const [, to, amount, token] = d.args as [string, string, bigint, string];
      return transfer(policy, lc(token), lc(to), amount, ctx, spend, path);
    }
    case "transferFrom((address,address,uint160,address)[])": {
      for (const x of d.args[0] as { to: string; amount: bigint; token: string }[]) transfer(policy, lc(x.token), lc(x.to), x.amount, ctx, spend, path);
      return;
    }
    case "permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)":
    case "permitWitnessTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes32,string,bytes)": {
      const [p, t] = d.args as [{ permitted: { token: string } }, { to: string; requestedAmount: bigint }];
      return transfer(policy, lc(p.permitted.token), lc(t.to), t.requestedAmount, ctx, spend, path);
    }
    case "permitTransferFrom(((address,uint256)[],uint256,uint256),(address,uint256)[],address,bytes)":
    case "permitWitnessTransferFrom(((address,uint256)[],uint256,uint256),(address,uint256)[],address,bytes32,string,bytes)": {
      const [p, ts] = d.args as [{ permitted: { token: string }[] }, { to: string; requestedAmount: bigint }[]];
      if (p.permitted.length !== ts.length) throw new Deny("MALFORMED_BATCH", "Permit2 batch length mismatch", path);
      ts.forEach((t, i) => transfer(policy, lc(p.permitted[i]!.token), lc(t.to), t.requestedAmount, ctx, spend, path));
      return;
    }
    case "lockdown((address,address)[])":
    case "invalidateNonces(address,address,uint48)":
    case "invalidateUnorderedNonces(uint256,uint256)":
      return; // these only reduce permissions
  }
  throw new Deny("PERMIT2_CALL_UNKNOWN", `unhandled Permit2 function ${d.name}`, path);
}
