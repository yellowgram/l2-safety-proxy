import { decodeAbiParameters, encodeFunctionData, getAddress, hexToBigInt, parseAbiParameters, sliceHex, size, type Address, type Hex } from "viem";
import {
  MAX_DEPTH,
  MULTICALL3,
  NonCanonicalAbi,
  PERMIT2_ABI,
  SAFE_MULTISEND,
  SAFE_MULTISEND_CALL_ONLY,
  decodeKnown,
} from "./abi.js";

/**
 * One effect the transaction can have. `call` is an ordinary contract call or
 * value transfer. `payout` is a Universal Router command that sends router-held
 * funds to `recipient`.
 */
export type Leaf =
  | { kind: "call"; to?: Address; value: bigint; data: Hex; path: string; fromAccount: boolean }
  | { kind: "payout"; recipient: Address; path: string };

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
  walk({ to: tx.to, value: tx.value, data: tx.data }, ctx, out, 0, "tx", true);
  return out;
}

function walk(
  call: { to?: Address; value: bigint; data: Hex },
  ctx: FlattenContext,
  out: Flattened,
  depth: number,
  path: string,
  fromAccount: boolean
): void {
  if (depth > MAX_DEPTH) throw new DecodeDenied("TOO_DEEP", `wrappers nested deeper than ${MAX_DEPTH}`, path);
  const leaf = (): void => void out.leaves.push({ kind: "call", to: call.to, value: call.value, data: call.data, path, fromAccount });
  if (!call.to || call.data === "0x" || size(call.data) < 4) return leaf();

  let d;
  try {
    d = decodeKnown(call.data, "wrapper");
  } catch (err) {
    if (err instanceof NonCanonicalAbi) throw new DecodeDenied("NON_CANONICAL_ABI", err.message, path);
    throw err;
  }
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
  const sub = (i: number, c: { to?: Address; value: bigint; data: Hex }, asAccount: boolean) =>
    walk(c, ctx, out, depth + 1, `${path}>${d!.name}[${i}]`, asAccount);

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
      items.forEach((data, i) => sub(i, { to, value: 0n, data }, isAccount));
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
        const inner = decodeKnown(data, "wrapper");
        if (!inner || inner.name !== "multiSend") {
          throw new DecodeDenied("DELEGATECALL_DENIED", "Safe DELEGATECALL to MultiSend without multiSend calldata", path);
        }
        unpackMultiSend(inner.args[0] as Hex, `${path}>execTransaction>multiSend`, ctx, out, depth + 1, true);
        return;
      }
      sub(0, { to: innerTo, value, data }, true);
      return;
    }
    case "multiSend(bytes)": {
      // Called directly (not via Safe DELEGATECALL): runs as the MultiSend contract.
      wrap(isAccount ? "account" : "router");
      unpackMultiSend(d.args[0] as Hex, `${path}>multiSend`, ctx, out, depth + 1, isAccount);
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
          batch = (decodeAbiParameters(parseAbiParameters("(address target, uint256 value, bytes callData)[]"), exec) as unknown as [typeof batch])[0];
        } catch {
          throw new DecodeDenied("NON_CANONICAL_ABI", "ERC-7579 batch execution does not decode", path);
        }
        batch.forEach((c, i) => sub(i, { to: c.target, value: c.value, data: c.callData }, true));
        return;
      }
      throw new DecodeDenied("DELEGATECALL_DENIED", `ERC-7579 call type 0x${callType} is not allowed (only single and batch calls)`, path);
    }
    case "execute(bytes,bytes[])":
    case "execute(bytes,bytes[],uint256)": {
      wrap("router");
      universalRouter(d.args[0] as Hex, d.args[1] as Hex[], to, ctx, out, depth + 1, `${path}>execute`);
      return;
    }
  }
  leaf();
}

function unpackMultiSend(packed: Hex, path: string, ctx: FlattenContext, out: Flattened, depth: number, asAccount: boolean) {
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
    walk({ to, value, data }, ctx, out, depth, `${path}[${i}]`, asAccount);
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

function urDecode(types: string, input: Hex, path: string): readonly unknown[] {
  try {
    return decodeAbiParameters(parseAbiParameters(types), input);
  } catch {
    throw new DecodeDenied("NON_CANONICAL_ABI", `Universal Router input does not decode as (${types})`, path);
  }
}

function universalRouter(commands: Hex, inputs: Hex[], router: Address, ctx: FlattenContext, out: Flattened, depth: number, path: string) {
  if (depth > MAX_DEPTH) throw new DecodeDenied("TOO_DEEP", `wrappers nested deeper than ${MAX_DEPTH}`, path);
  const n = size(commands);
  if (n !== inputs.length) throw new DecodeDenied("MALFORMED_BATCH", "Universal Router commands/inputs length mismatch", path);
  const recipient = (r: Address): Address => {
    const l = lc(r);
    if (l === UR_MSG_SENDER) return (ctx.sender ?? r) as Address;
    if (l === UR_ADDRESS_THIS) return router;
    return r;
  };
  const payout = (r: Address, p: string) => out.leaves.push({ kind: "payout", recipient: recipient(r), path: p });
  const permit2Leaf = (data: Hex, p: string) =>
    out.leaves.push({ kind: "call", to: ctx.permit2 as Address, value: 0n, data, path: p, fromAccount: true });

  for (let i = 0; i < n; i++) {
    const cmd = Number(hexToBigInt(sliceHex(commands, i, i + 1))) & 0x7f;
    const input = inputs[i]!;
    const p = `${path}[${i}:0x${cmd.toString(16).padStart(2, "0")}]`;
    switch (cmd) {
      case UR.V3_SWAP_EXACT_IN:
      case UR.V3_SWAP_EXACT_OUT:
        payout(urDecode("address, uint256, uint256, bytes, bool", input, p)[0] as Address, p);
        break;
      case UR.V2_SWAP_EXACT_IN:
      case UR.V2_SWAP_EXACT_OUT:
        payout(urDecode("address, uint256, uint256, address[], bool", input, p)[0] as Address, p);
        break;
      case UR.SWEEP:
      case UR.TRANSFER:
      case UR.PAY_PORTION:
        payout(urDecode("address, address, uint256", input, p)[1] as Address, p);
        break;
      case UR.WRAP_ETH:
      case UR.UNWRAP_WETH:
        payout(urDecode("address, uint256", input, p)[0] as Address, p);
        break;
      case UR.BALANCE_CHECK_ERC20:
        break;
      case UR.PERMIT2_TRANSFER_FROM: {
        const [token, to, amount] = urDecode("address, address, uint160", input, p) as [Address, Address, bigint];
        permit2Leaf(
          encodeFunctionData({ abi: PERMIT2_ABI, functionName: "transferFrom", args: [ctx.sender ?? UR_MSG_SENDER, recipient(to), amount, token] }),
          p
        );
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
        const [subCommands, subInputs] = urDecode("bytes, bytes[]", input, p) as [Hex, Hex[]];
        universalRouter(subCommands, subInputs, router, ctx, out, depth + 1, `${p}>subplan`);
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
}

export { MULTICALL3 };
