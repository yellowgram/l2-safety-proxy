import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
  type Abi,
  type Hex,
} from "viem";

export const MAX_DEPTH = 4;
/** "Effectively unlimited": an amount no real policy would ever mean literally. */
export const EFFECTIVELY_UNLIMITED = 1n << 128n;
export const UINT160_MAX = (1n << 160n) - 1n;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
export const PERMIT2_DEFAULT = "0x000000000022d473030f116ddee9f6b43ac78ba3";
export const PERMIT2_ZKSYNC = "0x0000000000225e31d15943971f47ad3022f714fa";
/** Safe MultiSendCallOnly + MultiSend (v1.3.0 canonical/eip155, v1.4.1), safe-global/safe-deployments. */
export const SAFE_MULTISEND_CALL_ONLY = new Set([
  "0x40a2accbd92bca938b02010e17a5b8929b49130d",
  "0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b",
  "0x9641d764fc13c8b624c04430c7356c1c7c8102e2",
]);
export const SAFE_MULTISEND = new Set([
  "0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761",
  "0x998739bfdaadde7c933b942a68053933098f9eda",
  "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526",
]);

export const WRAPPER_ABI = parseAbi([
  // Multicall3
  "function aggregate((address target, bytes callData)[] calls)",
  "function tryAggregate(bool requireSuccess, (address target, bytes callData)[] calls)",
  "function blockAndAggregate((address target, bytes callData)[] calls)",
  "function tryBlockAndAggregate(bool requireSuccess, (address target, bytes callData)[] calls)",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls)",
  "function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls)",
  // Router self-multicall (Uniswap v3 periphery, many others)
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline, bytes[] data)",
  "function multicall(bytes32 previousBlockhash, bytes[] data)",
  // Safe
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)",
  "function multiSend(bytes transactions)",
  // Smart accounts (Coinbase Smart Wallet, SimpleAccount, Kernel) and 7702 batch executors
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
  "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
  "function executeBatch(address[] dest, bytes[] func)",
  "function execute((address to, uint256 value, bytes data)[] calls)",
  // ERC-7579
  "function execute(bytes32 mode, bytes executionCalldata)",
  // Uniswap Universal Router
  "function execute(bytes commands, bytes[] inputs)",
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);

export const TOKEN_ABI = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function increaseApproval(address spender, uint256 addedValue)",
  "function decreaseAllowance(address spender, uint256 subtractedValue)",
  "function approveAndCall(address spender, uint256 amount, bytes extraData)",
  "function setApprovalForAll(address operator, bool approved)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function permit(address holder, address spender, uint256 nonce, uint256 expiry, bool allowed, uint8 v, bytes32 r, bytes32 s)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)",
]);

export const PERMIT2_ABI = parseAbi([
  "struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }",
  "struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }",
  "struct PermitBatch { PermitDetails[] details; address spender; uint256 sigDeadline; }",
  "struct TokenPermissions { address token; uint256 amount; }",
  "struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }",
  "struct PermitBatchTransferFrom { TokenPermissions[] permitted; uint256 nonce; uint256 deadline; }",
  "struct SignatureTransferDetails { address to; uint256 requestedAmount; }",
  "struct AllowanceTransferDetails { address from; address to; uint160 amount; address token; }",
  "struct TokenSpenderPair { address token; address spender; }",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function permit(address owner, PermitSingle permitSingle, bytes signature)",
  "function permit(address owner, PermitBatch permitBatch, bytes signature)",
  "function transferFrom(address from, address to, uint160 amount, address token)",
  "function transferFrom(AllowanceTransferDetails[] transferDetails)",
  "function permitTransferFrom(PermitTransferFrom permit, SignatureTransferDetails transferDetails, address owner, bytes signature)",
  "function permitTransferFrom(PermitBatchTransferFrom permit, SignatureTransferDetails[] transferDetails, address owner, bytes signature)",
  "function permitWitnessTransferFrom(PermitTransferFrom permit, SignatureTransferDetails transferDetails, address owner, bytes32 witness, string witnessTypeString, bytes signature)",
  "function permitWitnessTransferFrom(PermitBatchTransferFrom permit, SignatureTransferDetails[] transferDetails, address owner, bytes32 witness, string witnessTypeString, bytes signature)",
  "function lockdown(TokenSpenderPair[] approvals)",
  "function invalidateNonces(address token, address spender, uint48 newNonce)",
  "function invalidateUnorderedNonces(uint256 wordPos, uint256 mask)",
]);

export interface Decoded {
  name: string;
  args: readonly unknown[];
  signature: string;
}

const bySelector = new Map<string, { abi: Abi; signature: string }[]>();
function index(abi: Abi) {
  for (const item of abi) {
    if (item.type !== "function") continue;
    const sig = `${item.name}(${item.inputs.map((i) => formatType(i)).join(",")})`;
    const sel = toFunctionSelector(sig);
    const list = bySelector.get(sel) ?? [];
    list.push({ abi: [item], signature: sig });
    bySelector.set(sel, list);
  }
}
function formatType(p: { type: string; components?: readonly unknown[] }): string {
  if (p.type.startsWith("tuple")) {
    const inner = (p.components as { type: string; components?: readonly unknown[] }[]).map(formatType).join(",");
    return `(${inner})${p.type.slice(5)}`;
  }
  return p.type;
}
index(WRAPPER_ABI);
index(TOKEN_ABI);
index(PERMIT2_ABI);

export function selectorOf(data: Hex): string | undefined {
  return data.length >= 10 ? data.slice(0, 10).toLowerCase() : undefined;
}

export function signaturesFor(selector: string): string[] {
  return (bySelector.get(selector) ?? []).map((e) => e.signature);
}

export class NonCanonicalAbi extends Error {}

/**
 * Decode calldata against the known ABIs for its selector.
 * Re-encodes the result and requires it to match the input byte-for-byte
 * (trailing bytes after the encoding are allowed: Solidity ignores them).
 * Returns undefined for unknown selectors. Throws NonCanonicalAbi when the
 * selector is known but the bytes don't decode canonically.
 */
export function decodeKnown(data: Hex, only?: "wrapper" | "token" | "permit2"): Decoded | undefined {
  const sel = selectorOf(data);
  if (!sel) return undefined;
  const entries = bySelector.get(sel);
  if (!entries) return undefined;
  const lower = data.toLowerCase();
  for (const { abi, signature } of entries) {
    if (only && !belongs(signature, only)) continue;
    try {
      const { functionName, args } = decodeFunctionData({ abi, data });
      const again = encodeFunctionData({ abi, functionName, args } as never).toLowerCase();
      if (!lower.startsWith(again)) throw new NonCanonicalAbi(`non-canonical ABI encoding for ${signature}`);
      return { name: functionName, args: (args ?? []) as readonly unknown[], signature };
    } catch (err) {
      if (err instanceof NonCanonicalAbi) throw err;
      continue;
    }
  }
  if (only && !entries.some((e) => belongs(e.signature, only))) return undefined;
  throw new NonCanonicalAbi(`calldata for ${entries.map((e) => e.signature).join(" | ")} does not decode`);
}

const groups = {
  wrapper: new Set(WRAPPER_ABI.filter((i) => i.type === "function").map((i) => sigOf(i))),
  token: new Set(TOKEN_ABI.filter((i) => i.type === "function").map((i) => sigOf(i))),
  permit2: new Set(PERMIT2_ABI.filter((i) => i.type === "function").map((i) => sigOf(i))),
};
function sigOf(item: Abi[number]): string {
  const f = item as unknown as { name: string; inputs: { type: string; components?: readonly unknown[] }[] };
  return `${f.name}(${f.inputs.map(formatType).join(",")})`;
}
function belongs(signature: string, group: keyof typeof groups): boolean {
  return groups[group].has(signature);
}
