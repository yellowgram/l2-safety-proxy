import { encodeFunctionData, getAddress, hexToBigInt, sliceHex, size, toFunctionSelector, type Address, type Hex } from "viem";
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
  /**
   * Universal Routers on this chain that read the 2.1 input layout (2.1.1 and 2.1.2), lowercase.
   * Any other address that is called with execute() is read with the 1.x/2.0 layout.
   */
  ur21?: ReadonlySet<string>;
  /** V4 hook contracts the policy allows in a pool key (universalRouter.v4Hooks), lowercase. */
  v4Hooks?: ReadonlySet<string>;
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

/**
 * Universal Router 2.1.1 and 2.1.2 deployments, by chain id, from Uniswap/universal-router
 * deploy-addresses/*.json (2.1.1: cb222d3 and fa3f856; 2.1.2: 64027f3). Both read the same inputs: the
 * contracts are identical between the two tags. Only the chains the proxy ships templates for are
 * listed. OP Sepolia and Arbitrum Sepolia have no Universal Router.
 */
export const UR_V2_1: Readonly<Record<number, readonly string[]>> = {
  1: ["0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca", "0x23617e59a5925b2a4bf75d73ff6711cd0b29de85"],
  10: ["0x8b844f885672f333bc0042cb669255f93a4c1e6b", "0xc09255d86db563cbc11c2fcf4a0c512e160111b4"],
  8453: ["0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7", "0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40"],
  42161: ["0x8b844f885672f333bc0042cb669255f93a4c1e6b", "0x2d01411773c8c24805306e89a41f7855c3c4fe65"],
  11155111: ["0x7dfd4f31be6814d2906bde155c3e1b146eac1468", "0x7e4f6c5e954da5c61b3423d81e2277431ac043f3"],
  84532: ["0x8b844f885672f333bc0042cb669255f93a4c1e6b", "0x8702463e73f74d0b6765abceb314ef07acb92650"],
};

/** The 2.1 routers on `chainId`, as a set for FlattenContext.ur21. */
export function ur21Routers(chainId: number | undefined): ReadonlySet<string> {
  return new Set(chainId === undefined ? [] : UR_V2_1[chainId] ?? []);
}

/**
 * Selectors of the Universal Router entry points whose calldata may end in a calldata tag:
 * execute(bytes,bytes[],uint256), execute(bytes,bytes[]) and
 * executeSigned(bytes,bytes[],bytes32,bytes32,bool,bytes32,bytes,uint256).
 */
const UR_TAGGED_SELECTORS: ReadonlySet<string> = new Set(
  ["execute(bytes,bytes[],uint256)", "execute(bytes,bytes[])", "executeSigned(bytes,bytes[],bytes32,bytes32,bool,bytes32,bytes,uint256)"].map((sig) =>
    toFunctionSelector(`function ${sig}`).toLowerCase()
  )
);
/** ASCII "unix", the first four bytes of every calldata tag. */
const UR_TAG_MAGIC = "756e6978";
/** The 10-byte tag, observed only with this exact value. */
const UR_TAG_SHORT = "756e697800000000000c";
/** A millisecond Unix time before this (2020-09-13) isn't a plausible tag timestamp. */
const UR_TAG_MIN_MS = 1_600_000_000_000n;

/**
 * The calldata tag found after the ABI-encoded arguments of most Universal Router 2.1.2 transactions
 * built by Uniswap's Trading API. Two forms, and nothing else:
 *
 *   10 bytes: exactly 0x756e697800000000000c
 *   22 bytes: "unix" (0x756e6978) ‖ uint64 big-endian millisecond Unix time, below 2^48 and from
 *             2020-09-13 on ‖ 0x8000 ‖ 2 bytes ‖ 4 bytes ‖ 0x01 or 0x02 ‖ 0x00
 *
 * The 2.1.1/2.1.2 contracts never read calldata past the arguments (no msg.data, calldatasize or
 * calldatacopy in any of their sources; every read is an ABI offset or a slice of one), so once the
 * arguments are the exact canonical encoding the tag can't change what the router does.
 *
 * Returns the calldata without the tag, and the tag, when `data` is a call to execute or executeSigned
 * on a 2.1 router of `chainId` and ends in exactly one well-formed tag. Canonical calldata is
 * 4 + 32·k bytes long, so only a length of 4 + 32·k + 10 or + 22 is ever split; anything else is left
 * whole for the canonical check to judge.
 */
export function routerCalldataTag(to: string | undefined, data: Hex, chainId: number): { data: Hex; tag: Hex } | undefined {
  if (!to || !ur21Routers(chainId).has(to.toLowerCase())) return undefined;
  const hex = data.slice(2).toLowerCase();
  if (hex.length < 8 || !UR_TAGGED_SELECTORS.has(`0x${hex.slice(0, 8)}`)) return undefined;
  const bytes = hex.length / 2;
  const n = (bytes - 4) % 32;
  if (n !== 10 && n !== 22) return undefined;
  const tag = hex.slice(hex.length - 2 * n);
  if (!isCalldataTag(tag)) return undefined;
  return { data: `0x${hex.slice(0, hex.length - 2 * n)}` as Hex, tag: `0x${tag}` as Hex };
}

function isCalldataTag(tag: string): boolean {
  if (tag.length === 20) return tag === UR_TAG_SHORT;
  if (tag.length !== 44 || !tag.startsWith(UR_TAG_MAGIC)) return false;
  const ms = BigInt(`0x${tag.slice(8, 24)}`);
  if (ms >= 1n << 48n || ms < UR_TAG_MIN_MS) return false;
  if (tag.slice(24, 28) !== "8000") return false;
  const version = tag.slice(40, 42);
  return (version === "01" || version === "02") && tag.slice(42, 44) === "00";
}

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
    case "execute(bytes,bytes[],uint256)":
    // 2.1 executeSigned runs execute() on the same commands; msg.sender (MSG_SENDER) is unchanged.
    case "executeSigned(bytes,bytes[],bytes32,bytes32,bool,bytes32,bytes,uint256)": {
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
  PAY_PORTION_FULL_PRECISION: 0x07,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  PERMIT2_TRANSFER_FROM_BATCH: 0x0d,
  BALANCE_CHECK_ERC20: 0x0e,
  V4_SWAP: 0x10,
  EXECUTE_SUB_PLAN: 0x21,
  ACROSS_V4_DEPOSIT_V3: 0x40,
} as const;

/** V4 router actions (v4-periphery Actions.sol) the guard models inside V4_SWAP. */
const V4 = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
} as const;

/** V4 struct layouts as Universal Router 2.1.1/2.1.2 read them (IV4Router.sol, with minHopPriceX36). */
const V4_POOL_KEY = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
const V4_PATH_KEY = "(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)";
const V4_TYPES = {
  [V4.SWAP_EXACT_IN_SINGLE]: `(${V4_POOL_KEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)`,
  [V4.SWAP_EXACT_IN]: `(address currencyIn, ${V4_PATH_KEY}[] path, uint256[] minHopPriceX36, uint128 amountIn, uint128 amountOutMinimum)`,
  [V4.SWAP_EXACT_OUT_SINGLE]: `(${V4_POOL_KEY} poolKey, bool zeroForOne, uint128 amountOut, uint128 amountInMaximum, uint256 minHopPriceX36, bytes hookData)`,
  [V4.SWAP_EXACT_OUT]: `(address currencyOut, ${V4_PATH_KEY}[] path, uint256[] minHopPriceX36, uint128 amountOut, uint128 amountInMaximum)`,
  [V4.SETTLE]: "address currency, uint256 amount, bool payerIsUser",
  [V4.SETTLE_ALL]: "address currency, uint256 maxAmount",
  [V4.TAKE]: "address currency, address recipient, uint256 amount",
  [V4.TAKE_ALL]: "address currency, uint256 minAmount",
  [V4.TAKE_PORTION]: "address currency, address recipient, uint256 bips",
} as const;
type PoolKey = { currency0: Address; currency1: Address; hooks: Address };
type PathKey = { intermediateCurrency: Address; hooks: Address };

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

function unchecked(cmd: number, p: string): never {
  throw new DecodeDenied("ROUTER_COMMAND_UNCHECKED", `Universal Router command 0x${cmd.toString(16).padStart(2, "0")} can't be checked by the guard`, p);
}

/**
 * 2.1 per-hop minimum prices: empty, or one per hop. Any other length makes the router revert
 * (V3HopPriceAndPathLengthMismatch, V2InvalidHopPriceLength, InvalidHopPriceLength), so it is refused
 * rather than judged as a plan that would run.
 */
function hopPrices(count: number, hops: number, p: string): void {
  if (count !== 0 && count !== hops) {
    throw new DecodeDenied("NON_CANONICAL_ABI", `minHopPriceX36 has ${count} entries for a ${hops}-hop path; it must be empty or have one per hop`, p);
  }
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
  // 2.1.1/2.1.2 read a sixth argument on V2/V3 swaps and add commands; any other router is read as 1.x/2.0.
  const v21 = ctx.ur21?.has(lc(router)!) === true;
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
    // six bits (mask 0x3f), so bit 0x40 is unused there and any byte with it is refused. 2.1 widens the
    // mask to 0x7f (Commands.COMMAND_TYPE_MASK) and uses 0x40-0x5f for third-party integrations.
    const cmd = raw & (v21 ? 0x7f : 0x3f);
    const input = inputs[i]!;
    const p = `${path}[${i}:0x${cmd.toString(16).padStart(2, "0")}]`;
    if (!v21 && raw & 0x40) {
      throw new DecodeDenied("NON_CANONICAL_ABI", `Universal Router command byte 0x${raw.toString(16).padStart(2, "0")} sets bit 0x40, which this router version doesn't use (Universal Router 2.0 and earlier mask it off; 2.1 uses it for other commands)`, p);
    }
    // Only a command that can't silently fail may count as moving funds out of the router.
    const settles = !revertible && (raw & 0x80) === 0;
    switch (cmd) {
      case UR.V3_SWAP_EXACT_IN:
      case UR.V3_SWAP_EXACT_OUT: {
        const [r, amount, , route, payerIsUser, minHop] = urDecode(v21 ? "address, uint256, uint256, bytes, bool, uint256[]" : "address, uint256, uint256, bytes, bool", input, p) as [Address, bigint, bigint, Hex, boolean, bigint[]?];
        payout(r, p);
        // Exact-in paths run input → output; exact-out paths are reversed.
        const exactIn = cmd === UR.V3_SWAP_EXACT_IN;
        const ends = v3PathEnds(route, p);
        if (minHop) hopPrices(minHop.length, (size(route) - V3_ADDR) / V3_HOP, p);
        if (exactIn && !payerIsUser) spend(ends.first, amount, settles);
        if (toRouter(r)) credit(exactIn ? ends.last : ends.first, `the output of swap ${p}`, p);
        break;
      }
      case UR.V2_SWAP_EXACT_IN:
      case UR.V2_SWAP_EXACT_OUT: {
        const [r, amount, , route, payerIsUser, minHop] = urDecode(v21 ? "address, uint256, uint256, address[], bool, uint256[]" : "address, uint256, uint256, address[], bool", input, p) as [Address, bigint, bigint, Address[], boolean, bigint[]?];
        payout(r, p);
        if (route.length < 2) throw new DecodeDenied("NON_CANONICAL_ABI", "Universal Router V2 path has fewer than two tokens", p);
        if (minHop) hopPrices(minHop.length, route.length - 1, p);
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
      case UR.PAY_PORTION_FULL_PRECISION:
        // 2.1 only (on 2.0 it reverts, so it falls through to the default there): a share of the
        // balance with 1e18 precision. Like PAY_PORTION, never counts as emptying it.
        if (!v21) unchecked(cmd, p);
        payout(urDecode("address, address, uint256", input, p)[1] as Address, p);
        break;
      case UR.V4_SWAP:
        // Modelled for 2.1 routers only. On 2.0 the V4 structs lack minHopPriceX36, and no 2.0 V4 plan
        // is decoded, so it stays refused there.
        if (!v21) unchecked(cmd, p);
        v4Swap(input, p, settles, { ctx, payout, toRouter, credit, spend });
        break;
      case UR.ACROSS_V4_DEPOSIT_V3:
        // Only reachable on 2.1 (on older routers bit 0x40 is refused above).
        throw new DecodeDenied(
          "ROUTER_COMMAND_UNCHECKED",
          "Universal Router command 0x40 (ACROSS_V4_DEPOSIT_V3) bridges funds to a recipient on another chain, which the guard can't check",
          p
        );
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
        unchecked(cmd, p);
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

/** What a Universal Router plan's V4_SWAP needs from the plan around it (see universalRouter). */
interface PlanContext {
  ctx: FlattenContext;
  payout: (r: Address, p: string) => void;
  toRouter: (r: Address) => boolean;
  credit: (token: string, what: string, p: string, amount?: bigint) => void;
  spend: (token: string, amount: bigint, settles: boolean) => void;
}

/** ActionConstants.OPEN_DELTA: "the amount currently owed (or credited) on the PoolManager". */
const V4_OPEN_DELTA = 0n;
const hex2 = (x: number) => x.toString(16).padStart(2, "0");

/**
 * One V4_SWAP command on a 2.1 router: abi.encode(bytes actions, bytes[] params), run inside one
 * PoolManager unlock (V4Router._handleAction). Every action's params must be the canonical encoding.
 *
 * The PoolManager reverts the whole unlock unless every currency nets to zero, so value can leave it
 * only through TAKE, TAKE_ALL and TAKE_PORTION. Those are payouts, judged like any other (MSG_SENDER
 * and ADDRESS_THIS mean the same as in the router commands; TAKE_ALL pays msgSender()). A take into
 * the router (ADDRESS_THIS) is put on the plan's ledger and must leave by the end of the plan.
 *
 * Value enters through SETTLE and SETTLE_ALL. Paid by the router (payerIsUser false, or native ETH,
 * which DeltaResolver._settle always pays from the router's own balance), a settle moves router funds
 * out: CONTRACT_BALANCE all of it, an explicit amount exactly that much, and the open delta (0, and
 * SETTLE_ALL) what the swaps owe. The guard counts the open delta only when it is known, the way it
 * counts V2/V3 exact-input swaps: the currency is used in this plan only as the input of exact-input
 * swaps with explicit amounts and is settled once, so the debt is their sum. Used any other way (a swap
 * output, an exact-output swap, a take, a second settle, an input funded by an earlier credit), a
 * credit could net against the debt, so the settle doesn't count as moving funds out.
 *
 * Pools with a hook run that hook's code inside the swap, and a hook can change the amounts. A pool
 * key or path hop with a non-zero hook is refused unless the hook is in universalRouter.v4Hooks.
 * Actions the 2.1 router doesn't run (liquidity, wrap, sweep and the rest) are refused.
 */
function v4Swap(input: Hex, p: string, settles: boolean, plan: PlanContext): void {
  const [actions, params] = urDecode("bytes, bytes[]", input, p) as [Hex, Hex[]];
  const n = size(actions);
  if (n !== params.length) throw new DecodeDenied("MALFORMED_BATCH", "V4_SWAP actions/params length mismatch", p);
  const steps: { a: number; pp: string; args: readonly unknown[] }[] = [];
  for (let i = 0; i < n; i++) {
    const a = Number(hexToBigInt(sliceHex(actions, i, i + 1)));
    const pp = `${p}>v4[${i}:0x${hex2(a)}]`;
    const types = (V4_TYPES as Record<number, string>)[a];
    if (types === undefined) throw new DecodeDenied("ROUTER_COMMAND_UNCHECKED", `V4 action 0x${hex2(a)} can't be checked by the guard`, pp);
    steps.push({ a, pp, args: urDecode(types, params[i]!, pp) });
  }

  const hook = (h: Address, pp: string) => {
    const k = lc(h)!;
    if (k !== UR_ETH && !plan.ctx.v4Hooks?.has(k)) {
      throw new DecodeDenied(
        "ROUTER_V4_HOOK_NOT_ALLOWED",
        `V4 pool uses hook ${h}, which is not in universalRouter.v4Hooks; a hook runs its own code inside the swap and can change the amounts`,
        pp
      );
    }
  };
  // How each currency is used in this V4 plan (see above).
  const declared = new Map<string, bigint>();
  const other = new Set<string>();
  const settleCount = new Map<string, number>();
  const declare = (c: Address, amount: bigint) => {
    const k = lc(c)!;
    if (amount === V4_OPEN_DELTA) other.add(k);
    else declared.set(k, (declared.get(k) ?? 0n) + amount);
  };
  for (const { a, pp, args } of steps) {
    switch (a) {
      case V4.SWAP_EXACT_IN_SINGLE:
      case V4.SWAP_EXACT_OUT_SINGLE: {
        const [s] = args as [{ poolKey: PoolKey; zeroForOne: boolean; amountIn?: bigint }];
        hook(s.poolKey.hooks, pp);
        const [cin, cout] = s.zeroForOne ? [s.poolKey.currency0, s.poolKey.currency1] : [s.poolKey.currency1, s.poolKey.currency0];
        other.add(lc(cout)!);
        if (a === V4.SWAP_EXACT_IN_SINGLE) declare(cin, s.amountIn!);
        else other.add(lc(cin)!);
        break;
      }
      case V4.SWAP_EXACT_IN:
      case V4.SWAP_EXACT_OUT: {
        const [s] = args as [{ currencyIn?: Address; currencyOut?: Address; path: readonly PathKey[]; minHopPriceX36: readonly bigint[]; amountIn?: bigint }];
        // An empty path swaps nothing, so it owes nothing: it can't stand for an amount settled.
        if (s.path.length === 0) throw new DecodeDenied("NON_CANONICAL_ABI", "V4 swap path is empty", pp);
        hopPrices(s.minHopPriceX36.length, s.path.length, pp);
        for (const k of s.path) {
          hook(k.hooks, pp);
          other.add(lc(k.intermediateCurrency)!);
        }
        if (a === V4.SWAP_EXACT_IN) declare(s.currencyIn!, s.amountIn!);
        else other.add(lc(s.currencyOut)!);
        break;
      }
      case V4.SETTLE:
      case V4.SETTLE_ALL: {
        const k = lc(args[0] as Address)!;
        settleCount.set(k, (settleCount.get(k) ?? 0) + 1);
        break;
      }
      default:
        // TAKE, TAKE_ALL, TAKE_PORTION
        other.add(lc(args[0] as Address)!);
    }
  }

  const routerPays = (c: Address, amount: bigint) => {
    if (amount !== V4_OPEN_DELTA) return plan.spend(c, amount, settles);
    const k = lc(c)!;
    const owed = declared.get(k);
    if (owed !== undefined && !other.has(k) && settleCount.get(k) === 1) plan.spend(c, owed, settles);
  };
  for (const { a, pp, args } of steps) {
    switch (a) {
      case V4.SETTLE: {
        const [c, amount, payerIsUser] = args as [Address, bigint, boolean];
        if (!payerIsUser || lc(c) === UR_ETH) routerPays(c, amount);
        break;
      }
      case V4.SETTLE_ALL: {
        // The full debt, paid by msgSender() through Permit2, except native ETH, which the router pays.
        const [c] = args as [Address, bigint];
        if (lc(c) === UR_ETH) routerPays(c, V4_OPEN_DELTA);
        break;
      }
      case V4.TAKE: {
        const [c, r, amount] = args as [Address, Address, bigint];
        plan.payout(r, pp);
        if (plan.toRouter(r)) plan.credit(c, `${lc(c) === UR_ETH ? "ETH" : `token ${c}`} taken into the router at ${pp}`, pp, amount === V4_OPEN_DELTA ? undefined : amount);
        break;
      }
      case V4.TAKE_ALL:
        // Pays msgSender(), the router's caller.
        plan.payout(UR_MSG_SENDER as Address, pp);
        break;
      case V4.TAKE_PORTION: {
        const [c, r] = args as [Address, Address, bigint];
        plan.payout(r, pp);
        if (plan.toRouter(r)) plan.credit(c, `a share of ${lc(c) === UR_ETH ? "ETH" : `token ${c}`} taken into the router at ${pp}`, pp);
        break;
      }
    }
  }
}

export { MULTICALL3 };
