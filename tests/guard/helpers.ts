import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { parsePolicy } from "../../src/guard/policy/load.js";

export const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
export const agent = privateKeyToAccount(KEY);
export const AGENT = agent.address.toLowerCase() as Address;
export const CHAIN = 8453;

export const ALLOWED = "0x1111111111111111111111111111111111111111" as Address;
export const ATTACKER = "0x2222222222222222222222222222222222222222" as Address;
export const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
export const SPENDER_OK = "0x4444444444444444444444444444444444444444" as Address;
export const SPENDER_BAD = "0x5555555555555555555555555555555555555555" as Address;
export const RECIPIENT = "0x6666666666666666666666666666666666666666" as Address;
export const SAFE = "0x9999999999999999999999999999999999999999" as Address;
export const ROUTER = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af" as Address;
export const DELEGATE_OK = "0x7777777777777777777777777777777777777777" as Address;
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
export const ETH = 10n ** 18n;

export const MULTICALL3_SELECTORS = [
  "aggregate((address,bytes)[])",
  "tryAggregate(bool,(address,bytes)[])",
  "aggregate3((address,bool,bytes)[])",
  "aggregate3Value((address,bool,uint256,bytes)[])",
];
export const ROUTER_SELECTORS = ["execute(bytes,bytes[])", "execute(bytes,bytes[],uint256)", "multicall(bytes[])"];

export function basePolicy(extra: Record<string, unknown> = {}) {
  return parsePolicy({
    window: { seconds: 3600 },
    native: { maxPerTxWei: (ETH / 10n).toString(), windowMaxWei: (ETH / 2n).toString() },
    destinations: {
      [ALLOWED]: { type: "eoa" },
      [MULTICALL3]: { selectors: MULTICALL3_SELECTORS },
      [ROUTER]: { selectors: ROUTER_SELECTORS },
    },
    tokens: {
      [TOKEN]: {
        transfer: { recipients: [RECIPIENT], maxAmountRaw: "1000" },
        approve: { spenders: [SPENDER_OK, PERMIT2], maxAmountRaw: "1000" },
        windowMaxAmountRaw: "1500",
      },
    },
    ...extra,
  });
}

let nonce = 0;
export async function sign(tx: { to?: Address; value?: bigint; data?: Hex; nonce?: number; authorizationList?: unknown[]; chainId?: number }) {
  const base = { chainId: tx.chainId ?? CHAIN, nonce: tx.nonce ?? nonce++, to: tx.to, value: tx.value ?? 0n, data: tx.data, gas: 200000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
  if (tx.authorizationList) return agent.signTransaction({ ...base, type: "eip7702", authorizationList: tx.authorizationList as never } as never);
  return agent.signTransaction({ ...base, type: "eip1559" } as never);
}
