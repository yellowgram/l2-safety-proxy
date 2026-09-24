import { getAddress, type Hex } from "viem";
import { decodeErc20Transfer } from "./erc20.js";
import type {
  ChainPolicyOverlay,
  DestinationPolicy,
  PolicyCheckInput,
  PolicyCheckResult,
  SpendPolicyConfig,
} from "./types.js";

function normAddr(addr: string): `0x${string}` {
  try {
    return getAddress(addr).toLowerCase() as `0x${string}`;
  } catch {
    return addr.toLowerCase() as `0x${string}`;
  }
}

function resolveOverlay(
  policy: SpendPolicyConfig,
  chainKey: string,
  chainId: number
): {
  allowContractCreation: boolean;
  allowAnyDestination: boolean;
  globalMaxNativeWei?: bigint;
  destinations: Map<string, DestinationPolicy>;
  erc20RecipientCheck: boolean;
} {
  const byKey = policy.chains[chainKey];
  const byId = policy.chains[String(chainId)];
  const overlay: ChainPolicyOverlay | undefined = byKey ?? byId;

  const destinations =
    overlay?.destinations && overlay.destinations.size > 0
      ? overlay.destinations
      : policy.destinations;

  return {
    allowContractCreation:
      overlay?.allowContractCreation ?? policy.allowContractCreation,
    allowAnyDestination:
      overlay?.allowAnyDestination ?? policy.allowAnyDestination,
    globalMaxNativeWei: overlay?.globalMaxNativeWei ?? policy.globalMaxNativeWei,
    destinations,
    erc20RecipientCheck:
      overlay?.erc20RecipientCheck ?? policy.erc20RecipientCheck,
  };
}

/**
 * Pure Layer 2 policy check. Does not simulate and does not forward.
 */
export function evaluateSpendPolicy(
  policy: SpendPolicyConfig,
  input: PolicyCheckInput
): PolicyCheckResult {
  const valueWei = input.value;

  if (!policy.enabled) {
    return { allow: true, valueWei };
  }

  const cfg = resolveOverlay(policy, input.chainKey, input.chainId);

  if (!input.to) {
    if (cfg.allowContractCreation) {
      return { allow: true, valueWei };
    }
    return {
      allow: false,
      code: "CONTRACT_CREATE_DENIED",
      reason: "contract creation denied by Layer 2 policy",
      valueWei,
    };
  }

  let effectiveTo = normAddr(input.to);
  if (cfg.erc20RecipientCheck) {
    const decoded = decodeErc20Transfer(input.data as Hex | undefined);
    if (decoded) {
      effectiveTo = normAddr(decoded.recipient);
    }
  }

  const dest = cfg.destinations.get(effectiveTo);

  if (dest?.requireApproval) {
    return {
      allow: false,
      code: "NEEDS_APPROVAL",
      reason: `destination ${effectiveTo} requires operator approval`,
      effectiveTo,
      valueWei,
    };
  }

  if (!cfg.allowAnyDestination && !dest) {
    return {
      allow: false,
      code: "DESTINATION_NOT_ALLOWLISTED",
      reason: `destination ${effectiveTo} not on Layer 2 allowlist`,
      effectiveTo,
      valueWei,
    };
  }

  const caps: bigint[] = [];
  if (cfg.globalMaxNativeWei !== undefined) caps.push(cfg.globalMaxNativeWei);
  if (dest?.maxNativeWei !== undefined) caps.push(dest.maxNativeWei);
  for (const cap of caps) {
    if (valueWei > cap) {
      return {
        allow: false,
        code: "OVER_CAP",
        reason: `native value ${valueWei} exceeds policy cap ${cap}`,
        effectiveTo,
        valueWei,
      };
    }
  }

  return { allow: true, effectiveTo, valueWei };
}
