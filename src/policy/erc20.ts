import { type Hex, decodeFunctionData, erc20Abi, isHex } from "viem";

export interface Erc20TransferDecoded {
  recipient: `0x${string}`;
  amount: bigint;
  kind: "transfer" | "transferFrom";
}

/**
 * Best-effort decode of ERC20 transfer / transferFrom.
 * Returns null if data is not those selectors or decode fails.
 */
export function decodeErc20Transfer(
  data: Hex | undefined
): Erc20TransferDecoded | null {
  if (!data || data === "0x" || data.length < 10 || !isHex(data)) return null;
  const selector = data.slice(0, 10).toLowerCase();
  // transfer(address,uint256)
  if (selector === "0xa9059cbb") {
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data });
      if (decoded.functionName !== "transfer") return null;
      const [recipient, amount] = decoded.args as [`0x${string}`, bigint];
      return { recipient, amount, kind: "transfer" };
    } catch {
      return null;
    }
  }
  // transferFrom(address,address,uint256)
  if (selector === "0x23b872dd") {
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data });
      if (decoded.functionName !== "transferFrom") return null;
      const [, recipient, amount] = decoded.args as [
        `0x${string}`,
        `0x${string}`,
        bigint,
      ];
      return { recipient, amount, kind: "transferFrom" };
    } catch {
      return null;
    }
  }
  return null;
}
