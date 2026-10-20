import { encodeFunctionData, getAddress, hexToBigInt, sliceHex, size, type Address, type Hex } from "viem";
import {
  MAX_DEPTH,
  MULTICALL3,
  NonCanonicalAbi,
  PERMIT2_ABI,
  SAFE_MULTISEND,
  SAFE_MULTISEND_CALL_ONLY,
  decodeExact,
  decodeKnown,
} from "./abi.js";

/**
 * One effect the transaction can have. `call` is an ordinary contract call or
 * value transfer. `payout` is a Universal Router command that sends router-held
 * funds to `recipient`.
 */
export type Leaf =
  | { kind: "call"; to?: Address; value: bigint; data: Hex; path: string; fromAccount: boolean }
  | {
      kind: "payout";
      recipient: Address;
      /** The Universal Router that runs the command. A payout may go to it (ADDRESS_THIS), never to another contract in the tx. */
      router: Address;
      path: string;
    };

/** A wrapper the guard opened, and who it ran as. */
export interface Wrapper {
  to: Address;
  name: string;
  /** Native value sent to the wrapper call itself, and its 4-byte selector. */
  value: bigint;
  selector: Hex;
  /** "account": runs as the agent (Safe, smart wallet, 7702 self-call). "router": runs as the router. */
  as: "account" | "router";
  path: string;
}

export interface Flattened {
  leaves: Leaf[];
  wrappers: Wrapper[];
}

export class DecodeDenied extends Error {
  constructor(public code: string, message: string, public path: string) {
    super(message);
  }
}

export interface FlattenContext {
  sender?: Address;
  /** Agent-owned smart accounts (Safe, 4337 wallet), lowercase. */
  accounts: Set<string>;
  permit2: string;
  /**
   * The wrapped native token the Universal Router uses on this chain (its WETH9), lowercase.
   * Lets UNWRAP_WETH settle a swap output that is WETH. Unknown: only SWEEP settles it.
   */
  weth?: string;
}

/** WETH9 as configured in Uniswap's Universal Router deployments, by chain id. */
export const UR_WETH: Readonly<Record<number, string>> = {
  1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  10: "0x4200000000000000000000000000000000000006",
  8453: "0x4200000000000000000000000000000000000006",
  42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  11155111: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14",
  11155420: "0x4200000000000000000000000000000000000006",
  84532: "0x4200000000000000000000000000000000000006",
  421614: "0x980b62da83eff3d4576c647993b0c1d7faf17c73",
};

const lc = (a?: string) => a?.toLowerCase();

/**
 * Turn a transaction into the list of leaf effects it can have, opening every
 * wrapper the guard knows. Leaves are judged by the policy as if the agent made them.
 */
export function flattenCalls(
  tx: { to?: Address; value: bigint; data: Hex },
  ctx: FlattenContext
): Flattened {
  const out: Flattened = { leaves: [], wrappers: [] };
  walk({ to: tx.to, value: tx.value, data: tx.data }, ctx, out, 0, "tx", true, ctx.sender);
  return out;
}

function walk(
  /** msgValue: the msg.value code at `to` sees, when it differs from `value` (delegatecalled multicall entries). */
  call: { to?: Address; value: bigint; data: Hex; msgValue?: bigint },
  ctx: FlattenContext,
  out: Flattened,
  depth: number,
  path: string,
  fromAccount: boolean,
  /** msg.sender of this call: the sender at the top level, else the wrapper that makes the call. */
  caller: Address | undefined
): void {
  if (depth > MAX_DEPTH) throw new DecodeDenied("TOO_DEEP", `wrappers nested deeper than ${MAX_DEPTH}`, path);
  const leaf = (): void => void out.leaves.push({ kind: "call", to: call.to, value: call.value, data: call.data, path, fromAccount });
  if (!call.to || call.data === "0x" || size(call.data) < 4) return leaf();

  const d = decodeWrapper(call.data, path);
  if (!d) return leaf();

  const to = call.to;
  const isSelf = lc(to) === lc(ctx.sender);
  const isAccount = isSelf || ctx.accounts.has(lc(to)!);
  const wrap = (as: Wrapper["as"]) =>
    out.wrappers.push({ to, name: d!.name, as, path, value: call.value, selector: call.data.slice(0, 10).toLowerCase() as Hex });
  // Account-style wrappers (execute/executeBatch/7579) only mean "run these calls as the
  // agent" on the agent's own account. On any other contract they are an ordinary call,
  // judged by that destination's rule.
  const accountOnly = d.signature.startsWith("execute(address") || d.signature.startsWith("executeBatch") || d.signature === "execute(bytes32,bytes)" || d.signature === "execute((address,uint256,bytes)[])";
  if (accountOnly && !isAccount) return leaf();
  // Inner calls of a wrapper are made by the wrapper itself (msg.sender = to), except
  // multicall(bytes[]) entries, which are delegatecalled and keep this call's msg.sender.
  const sub = (i: number, c: { to?: Address; value: bigint; data: Hex; msgValue?: bigint }, asAccount: boolean, innerCaller: Address | undefined = to) =>
    walk(c, ctx, out, depth + 1, `${path}>${d!.name}[${i}]`, asAccount, innerCaller);

  switch (d.signature) {
    case "aggregate((address,bytes)[])":
    case "blockAndAggregate((address,bytes)[])": {
      wrap(isAccount ? "account" : "router");
      (d.args[0] as { target: Address; callData: Hex }[]).forEach((c, i) => sub(i, { to: c.target, value: 0n, data: c.callData }, isAccount));
      return;
    }
    case "tryAggregate(bool,(address,bytes)[])":
    case "tryBlockAndAggregate(bool,(address,bytes)[])": {
      wrap(isAccount ? "account" : "router");
      (d.args[1] as { target: Address; callData: Hex }[]).forEach((c, i) => sub(i, { to: c.target, value: 0n, data: c.callData }, isAccount));
      return;
    }
    case "aggregate3((address,bool,bytes)[])": {
      wrap(isAccount ? "account" : "router");
      (d.args[0] as { target: Address; callData: Hex }[]).forEach((c, i) => sub(i, { to: c.target, value: 0n, data: c.callData }, isAccount));
      return;
    }
    case "aggregate3Value((address,bool,uint256,bytes)[])": {
      wrap(isAccount ? "account" : "router");
      (d.args[0] as { target: Address; value: bigint; callData: Hex }[]).forEach((c, i) =>
        sub(i, { to: c.target, value: c.value, data: c.callData }, isAccount)
      );
      return;
    }
    case "multicall(bytes[])":
    case "multicall(uint256,bytes[])":
    case "multicall(bytes32,bytes[])": {
      // Each entry is delegatecalled on the same contract.
      wrap(isAccount ? "account" : "router");
      const items = d.args[d.args.length - 1] as Hex[];
      items.forEach((data, i) => sub(i, { to, value: 0n, data, msgValue: call.msgValue ?? call.value }, isAccount, caller));
      return;
    }
    case "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)": {
      wrap("account");
      const [innerTo, value, data, operation] = d.args as [Address, bigint, Hex, number];
      if (operation === 1) {
        const target = lc(innerTo)!;
        if (!SAFE_MULTISEND_CALL_ONLY.has(target) && !SAFE_MULTISEND.has(target)) {
          throw new DecodeDenied("DELEGATECALL_DENIED", `Safe DELEGATECALL to ${innerTo} (only Safe MultiSend is allowed)`, path);
        }
        const inner = decodeWrapper(data, `${path}>execTransaction`);
        if (!inner || inner.name !== "multiSend") {
          throw new DecodeDenied("DELEGATECALL_DENIED", "Safe DELEGATECALL to MultiSend without multiSend calldata", path);
        }
        // DELEGATECALL: the entries run as the Safe.
        unpackMultiSend(inner.args[0] as Hex, `${path}>execTransaction>multiSend`, ctx, out, depth + 1, true, to);
        return;
      }
      sub(0, { to: innerTo, value, data }, true);
      return;
    }
    case "multiSend(bytes)": {
      // Called directly (not via Safe DELEGATECALL): runs as the MultiSend contract.
      wrap(isAccount ? "account" : "router");
      unpackMultiSend(d.args[0] as Hex, `${path}>multiSend`, ctx, out, depth + 1, isAccount, to);
      return;
    }
    case "execute(address,uint256,bytes)": {
      wrap("account");
      const [target, value, data] = d.args as [Address, bigint, Hex];
      sub(0, { to: target, value, data }, true);
      return;
    }
    case "executeBatch((address,uint256,bytes)[])":
    case "execute((address,uint256,bytes)[])": {
      wrap("account");
      (d.args[0] as { target?: Address; to?: Address; value: bigint; data: Hex }[]).forEach((c, i) =>
        sub(i, { to: c.target ?? c.to, value: c.value, data: c.data }, true)
      );
      return;
    }
    case "executeBatch(address[],uint256[],bytes[])": {
      wrap("account");
      const [dest, values, funcs] = d.args as [Address[], bigint[], Hex[]];
      if (values.length !== 0 && values.length !== dest.length) throw new DecodeDenied("MALFORMED_BATCH", "executeBatch length mismatch", path);
      if (funcs.length !== dest.length) throw new DecodeDenied("MALFORMED_BATCH", "executeBatch length mismatch", path);
      dest.forEach((t, i) => sub(i, { to: t, value: values[i] ?? 0n, data: funcs[i]! }, true));
      return;
    }
    case "executeBatch(address[],bytes[])": {
      wrap("account");
      const [dest, funcs] = d.args as [Address[], Hex[]];
      if (funcs.length !== dest.length) throw new DecodeDenied("MALFORMED_BATCH", "executeBatch length mismatch", path);
      dest.forEach((t, i) => sub(i, { to: t, value: 0n, data: funcs[i]! }, true));
      return;
    }
    case "execute(bytes32,bytes)": {
      wrap("account");
      const [mode, exec] = d.args as [Hex, Hex];
      // ERC-7579 mode: callType(1) execType(1) unused(4) modeSelector(4) payload(22).
      const callType = mode.slice(2, 4);
      const execType = mode.slice(4, 6);
      const unusedAndSelector = mode.slice(6, 22);
      if (execType !== "00" && execType !== "01") {
        throw new DecodeDenied("MALFORMED_BATCH", `ERC-7579 exec type 0x${execType} is not supported`, path);
      }
      if (!/^0+$/.test(unusedAndSelector)) {
        throw new DecodeDenied("MALFORMED_BATCH", "ERC-7579 mode has a mode selector or reserved bytes the guard can't interpret", path);
      }
      // The default mode ignores the payload, so a non-zero payload is bytes the account never reads.
      if (!/^0+$/.test(mode.slice(22))) {
        throw new DecodeDenied("NON_CANONICAL_ABI", "ERC-7579 mode payload must be zero for the default mode", path);
      }
      if (callType === "00") {
        if (size(exec) < 52) throw new DecodeDenied("MALFORMED_BATCH", "ERC-7579 single execution too short", path);
        const target = getAddress(sliceHex(exec, 0, 20));
        const value = hexToBigInt(sliceHex(exec, 20, 52));
        const data = size(exec) > 52 ? sliceHex(exec, 52) : "0x";
        sub(0, { to: target, value, data }, true);
        return;
      }
      if (callType === "01") {
        let batch: readonly { target: Address; value: bigint; callData: Hex }[];
        try {
          batch = (decodeExact("(address target, uint256 value, bytes callData)[]", exec) as unknown as [typeof batch])[0];
        } catch {
          throw new DecodeDenied("NON_CANONICAL_ABI", "ERC-7579 batch execution does not decode canonically", path);
        }
        batch.forEach((c, i) => sub(i, { to: c.target, value: c.value, data: c.callData }, true));
        return;
      }
      throw new DecodeDenied("DELEGATECALL_DENIED", `ERC-7579 call type 0x${callType} is not allowed (only single and batch calls)`, path);
    }
    case "execute(bytes,bytes[])":
    case "execute(bytes,bytes[],uint256)": {
      wrap("router");
      universalRouter(d.args[0] as Hex, d.args[1] as Hex[], to, caller, ctx, out, depth + 1, `${path}>execute`, call.msgValue ?? call.value);
      return;
    }
  }
  leaf();
}

/** decodeKnown for wrapper selectors, with a non-canonical encoding turned into a denial at `path`. */
function decodeWrapper(data: Hex, path: string) {
  try {
    return decodeKnown(data, "wrapper");
  } catch (err) {
    if (err instanceof NonCanonicalAbi) throw new DecodeDenied("NON_CANONICAL_ABI", err.message, path);
    throw err;
  }
}

function unpackMultiSend(packed: Hex, path: string, ctx: FlattenContext, out: Flattened, depth: number, asAccount: boolean, caller: Address) {
  const n = size(packed);
  let off = 0;
  let i = 0;
  while (off < n) {
    if (off + 85 > n) throw new DecodeDenied("MALFORMED_BATCH", "truncated multiSend entry", path);
    const op = Number(hexToBigInt(sliceHex(packed, off, off + 1)));
    const to = getAddress(sliceHex(packed, off + 1, off + 21));
    const value = hexToBigInt(sliceHex(packed, off + 21, off + 53));
    const len = Number(hexToBigInt(sliceHex(packed, off + 53, off + 85)));
    if (off + 85 + len > n) throw new DecodeDenied("MALFORMED_BATCH", "truncated multiSend data", path);
    const data = len === 0 ? "0x" : sliceHex(packed, off + 85, off + 85 + len);
    if (op !== 0) throw new DecodeDenied("DELEGATECALL_DENIED", `multiSend entry ${i} uses DELEGATECALL`, `${path}[${i}]`);
    walk({ to, value, data }, ctx, out, depth, `${path}[${i}]`, asAccount, caller);
    off += 85 + len;
    i++;
  }
}

/** Universal Router recipient constants (Constants.sol). */
const UR_MSG_SENDER = "0x0000000000000000000000000000000000000001";
const UR_ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

const UR = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  PERMIT2_PERMIT_BATCH: 0x03,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  PERMIT2_TRANSFER_FROM_BATCH: 0x0d,
  BALANCE_CHECK_ERC20: 0x0e,
  EXECUTE_SUB_PLAN: 0x21,
} as const;

/**
 * Decode one Universal Router command input. The router reads inputs with its own calldata decoder,
 * which agrees with the ABI only for the standard encoding, and ignores anything after it. So the
 * input must round-trip exactly: decode, re-encode, byte-equal.
 */
function urDecode(types: string, input: Hex, path: string): readonly unknown[] {
  try {
    return decodeExact(types, input);
  } catch {
    throw new DecodeDenied("NON_CANONICAL_ABI", `Universal Router input is not the canonical encoding of (${types})`, path);
  }
}

/** V3 path layout (V3Path.sol): token (20) then one or more fee (3) + token (20) hops. */
const V3_ADDR = 20;
const V3_HOP = 23;
const V3_ONE_POOL = V3_ADDR + V3_HOP; // 43
/**
 * The tokens a V3 path really swaps between, decoded as the router does. The router treats a path
 * shorter than two pools (66 bytes) as exactly one pool and ignores whatever follows the first 43
 * bytes, and walks longer paths 23 bytes at a time. A path whose length isn't 20 + 23·k (k ≥ 1) is
 * therefore read differently by the router than by its last 20 bytes, so it is refused outright.
 */
export function v3PathEnds(route: Hex, path: string): { first: string; last: string } {
  const n = size(route);
  if (n < V3_ONE_POOL || (n - V3_ADDR) % V3_HOP !== 0) {
    throw new DecodeDenied("NON_CANONICAL_ABI", `Universal Router V3 path of ${n} bytes is not token + (fee + token) hops`, path);
  }
  return { first: lc(sliceHex(route, 0, V3_ADDR))!, last: lc(sliceHex(route, n - V3_ADDR, n))! };
}

/** Universal Router amount constant: "the router's whole balance of this token" (Constants.CONTRACT_BALANCE). */
const UR_CONTRACT_BALANCE = 1n << 255n;
/** Universal Router's name for native ETH in SWEEP and friends (Constants.ETH). */
const UR_ETH = "0x0000000000000000000000000000000000000000";

/**
 * Funds the plan puts into the router itself (a swap or transfer to ADDRESS_THIS, WRAP_ETH or
 * UNWRAP_WETH to ADDRESS_THIS, ETH sent with the call). Anyone can sweep a balance left in the
 * router, so each one must leave again before the plan ends. Keyed by token address (UR_ETH for
 * ETH); `amount` is known only for ETH sent with the call.
 */
type RouterHeld = Map<string, { what: string; path: string; amount?: bigint }>;

/**
 * `caller` is the router's msg.sender: the sender for a direct call, or the wrapper (Multicall3, the
 * agent's Safe, …) that calls the router. Universal Router's MSG_SENDER recipient means that address.
 *
 * Every payout becomes a `payout` leaf for the policy to judge. Funds paid to the router itself are
 * tracked, and must be moved out by a later command of the same plan: SWEEP of that token, UNWRAP_WETH
 * for WETH (both pay the router's whole balance), WRAP_ETH for ETH, or an exact-input swap the router
 * pays for, when its amount is CONTRACT_BALANCE or covers every known amount put there. A command flagged "allow revert", or anything in such a sub-plan, may
 * silently fail, so it never counts as moving funds out. Whatever is left: ROUTER_OUTPUT_STRANDED.
 */
function universalRouter(
  commands: Hex,
  inputs: Hex[],
  router: Address,
  caller: Address | undefined,
  ctx: FlattenContext,
  out: Flattened,
  depth: number,
  path: string,
  msgValue = 0n,
  held?: RouterHeld,
  revertible = false
) {
  if (depth > MAX_DEPTH) throw new DecodeDenied("TOO_DEEP", `wrappers nested deeper than ${MAX_DEPTH}`, path);
  const n = size(commands);
  if (n !== inputs.length) throw new DecodeDenied("MALFORMED_BATCH", "Universal Router commands/inputs length mismatch", path);
  const root = held === undefined;
  const funds: RouterHeld = held ?? new Map();
  if (root && msgValue > 0n) funds.set(UR_ETH, { what: `${msgValue} wei of ETH sent with the call`, path, amount: msgValue });
  const weth = ctx.weth ?? "weth";
  const recipient = (r: Address): Address => {
    const l = lc(r);
    if (l === UR_MSG_SENDER) return (caller ?? r) as Address;
    if (l === UR_ADDRESS_THIS) return router;
    return r;
  };
  const toRouter = (r: Address) => lc(recipient(r)) === lc(router);
  const payout = (r: Address, p: string) => out.leaves.push({ kind: "payout", recipient: recipient(r), router, path: p });
  const permit2Leaf = (data: Hex, p: string) =>
    out.leaves.push({ kind: "call", to: ctx.permit2 as Address, value: 0n, data, path: p, fromAccount: true });
  const credit = (token: string, what: string, p: string, amount?: bigint) => {
    const k = lc(token)!;
    const h = funds.get(k);
    if (!h) funds.set(k, { what, path: p, amount });
    else h.amount = h.amount !== undefined && amount !== undefined ? h.amount + amount : undefined;
  };
  // The router pays `amount` of `token` out of its own balance. Counts only when it surely empties
  // what the plan put there: the whole balance (CONTRACT_BALANCE), or at least the known amount.
  const spend = (token: string, amount: bigint, settles: boolean) => {
    const k = lc(token)!;
    const h = funds.get(k);
    if (!h || !settles) return;
    if (amount === UR_CONTRACT_BALANCE || (h.amount !== undefined && amount >= h.amount)) funds.delete(k);
    else if (h.amount !== undefined) h.amount -= amount;
  };

  for (let i = 0; i < n; i++) {
    const raw = Number(hexToBigInt(sliceHex(commands, i, i + 1)));
    // 0x80 is the allow-revert flag. Universal Router 1.x and 2.0 take the command type from the low
    // six bits (mask 0x3f), so bit 0x40 is unused there; 2.1 widens the mask to 0x7f and uses 0x40 for
    // new commands. The guard models the 1.x/2.0 commands only, so any byte with 0x40 is refused.
    const cmd = raw & 0x3f;
    const input = inputs[i]!;
    const p = `${path}[${i}:0x${cmd.toString(16).padStart(2, "0")}]`;
    if (raw & 0x40) {
      throw new DecodeDenied("NON_CANONICAL_ABI", `Universal Router command byte 0x${raw.toString(16).padStart(2, "0")} sets bit 0x40, which the guard does not support (unused before Universal Router 2.1, other commands from 2.1)`, p);
    }
    // Only a command that can't silently fail may count as moving funds out of the router.
    const settles = !revertible && (raw & 0x80) === 0;
    switch (cmd) {
      case UR.V3_SWAP_EXACT_IN:
      case UR.V3_SWAP_EXACT_OUT: {
        const [r, amount, , route, payerIsUser] = urDecode("address, uint256, uint256, bytes, bool", input, p) as [Address, bigint, bigint, Hex, boolean];
        payout(r, p);
        // Exact-in paths run input → output; exact-out paths are reversed.
        const exactIn = cmd === UR.V3_SWAP_EXACT_IN;
        const ends = v3PathEnds(route, p);
        if (exactIn && !payerIsUser) spend(ends.first, amount, settles);
        if (toRouter(r)) credit(exactIn ? ends.last : ends.first, `the output of swap ${p}`, p);
        break;
      }
      case UR.V2_SWAP_EXACT_IN:
      case UR.V2_SWAP_EXACT_OUT: {
        const [r, amount, , route, payerIsUser] = urDecode("address, uint256, uint256, address[], bool", input, p) as [Address, bigint, bigint, Address[], boolean];
        payout(r, p);
        if (route.length < 2) throw new DecodeDenied("NON_CANONICAL_ABI", "Universal Router V2 path has fewer than two tokens", p);
        if (cmd === UR.V2_SWAP_EXACT_IN && !payerIsUser) spend(route[0]!, amount, settles);
        if (toRouter(r)) credit(route[route.length - 1]!, `the output of swap ${p}`, p);
        break;
      }
      case UR.SWEEP: {
        // SWEEP pays out the router's whole balance of the token. To the router itself it moves nothing.
        const [token, r] = urDecode("address, address, uint256", input, p) as [Address, Address, bigint];
        payout(r, p);
        if (!toRouter(r) && settles) funds.delete(lc(token)!);
        break;
      }
      case UR.TRANSFER:
      case UR.PAY_PORTION:
        // A fixed amount or a share of the balance: never counts as emptying it.
        payout(urDecode("address, address, uint256", input, p)[1] as Address, p);
        break;
      case UR.WRAP_ETH: {
        const [r, amount] = urDecode("address, uint256", input, p) as [Address, bigint];
        payout(r, p);
        const known = amount === UR_CONTRACT_BALANCE ? funds.get(UR_ETH)?.amount : amount;
        spend(UR_ETH, amount, settles);
        if (toRouter(r)) credit(weth, `WETH from WRAP_ETH at ${p}`, p, known);
        break;
      }
      case UR.UNWRAP_WETH: {
        // Unwraps the router's whole WETH balance and pays the ETH to the recipient.
        const [r] = urDecode("address, uint256", input, p) as [Address, bigint];
        payout(r, p);
        if (settles) funds.delete(weth);
        if (toRouter(r)) credit(UR_ETH, `ETH from UNWRAP_WETH at ${p}`, p);
        break;
      }
      case UR.BALANCE_CHECK_ERC20:
        break;
      case UR.PERMIT2_TRANSFER_FROM: {
        const [token, to, amount] = urDecode("address, address, uint160", input, p) as [Address, Address, bigint];
        permit2Leaf(
          encodeFunctionData({ abi: PERMIT2_ABI, functionName: "transferFrom", args: [ctx.sender ?? UR_MSG_SENDER, recipient(to), amount, token] }),
          p
        );
        if (toRouter(to)) credit(token, `tokens pulled into the router at ${p}`, p, amount);
        break;
      }
      case UR.PERMIT2_TRANSFER_FROM_BATCH: {
        const [details] = urDecode("(address from, address to, uint160 amount, address token)[]", input, p) as [
          { from: Address; to: Address; amount: bigint; token: Address }[],
        ];
        permit2Leaf(
          encodeFunctionData({
            abi: PERMIT2_ABI,
            functionName: "transferFrom",
            args: [details.map((x) => ({ ...x, to: recipient(x.to) }))],
          }),
          p
        );
        for (const x of details) if (toRouter(x.to)) credit(x.token, `tokens pulled into the router at ${p}`, p, x.amount);
        break;
      }
      case UR.PERMIT2_PERMIT: {
        const [permitSingle, sig] = urDecode(
          "((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline), bytes",
          input,
          p
        ) as [never, Hex];
        permit2Leaf(encodeFunctionData({ abi: PERMIT2_ABI, functionName: "permit", args: [ctx.sender ?? UR_MSG_SENDER, permitSingle, sig] }), p);
        break;
      }
      case UR.PERMIT2_PERMIT_BATCH: {
        const [permitBatch, sig] = urDecode(
          "((address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline), bytes",
          input,
          p
        ) as [never, Hex];
        permit2Leaf(encodeFunctionData({ abi: PERMIT2_ABI, functionName: "permit", args: [ctx.sender ?? UR_MSG_SENDER, permitBatch, sig] }), p);
        break;
      }
      case UR.EXECUTE_SUB_PLAN: {
        // A sub-plan shares the router's balances with the plan that runs it.
        const [subCommands, subInputs] = urDecode("bytes, bytes[]", input, p) as [Hex, Hex[]];
        universalRouter(subCommands, subInputs, router, caller, ctx, out, depth + 1, `${p}>subplan`, 0n, funds, !settles);
        break;
      }
      default:
        throw new DecodeDenied(
          "ROUTER_COMMAND_UNCHECKED",
          `Universal Router command 0x${cmd.toString(16).padStart(2, "0")} can't be checked by the guard`,
          p
        );
    }
  }

  if (root) {
    for (const [token, h] of funds) {
      const name = token === UR_ETH ? "ETH" : token === weth ? "WETH" : `token ${token}`;
      throw new DecodeDenied(
        "ROUTER_OUTPUT_STRANDED",
        `${h.what} (${name}) is left in router ${router} when the plan ends, and anyone can take a balance left in the router. ` +
          `End the plan with SWEEP${token === weth ? " or UNWRAP_WETH" : ""} to MSG_SENDER`,
        h.path
      );
    }
  }
}

export { MULTICALL3 };
