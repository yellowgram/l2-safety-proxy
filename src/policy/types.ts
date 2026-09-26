/** Machine-readable Layer 2 deny reasons. */
export type PolicyDenyCode =
  | "DESTINATION_NOT_ALLOWLISTED"
  | "OVER_CAP"
  | "CONTRACT_CREATE_DENIED"
  | "NEEDS_APPROVAL"
  | "TX_UNPARSEABLE";

export interface DestinationPolicy {
  /** Max native wei for a single tx to this destination (inclusive). */
  maxNativeWei?: bigint;
  /** If true, always STOP with NEEDS_APPROVAL (operator must clear flag). */
  requireApproval?: boolean;
}

export interface ChainPolicyOverlay {
  allowContractCreation?: boolean;
  allowAnyDestination?: boolean;
  globalMaxNativeWei?: bigint;
  destinations?: Map<string, DestinationPolicy>;
  erc20RecipientCheck?: boolean;
}

export interface HumanGateConfig {
  /** Only "stop" is supported — no blocking wait. */
  mode: "stop";
  /** Optional fire-and-forget webhook on deny. */
  notifyUrl?: string;
}

/**
 * Layer 2 spend / address policy.
 * Default enabled=false — existing Layer 1 fail-open users unchanged.
 */
export interface SpendPolicyConfig {
  enabled: boolean;
  allowContractCreation: boolean;
  /** When true, skip allowlist membership (caps / requireApproval still apply). */
  allowAnyDestination: boolean;
  globalMaxNativeWei?: bigint;
  /** lowercase 0x-address → policy */
  destinations: Map<string, DestinationPolicy>;
  /** Optional per-chain overlays keyed by chain template id or numeric chainId string */
  chains: Record<string, ChainPolicyOverlay>;
  /** Decode ERC20 transfer/transferFrom and allowlist the recipient */
  erc20RecipientCheck: boolean;
  humanGate: HumanGateConfig;
}

export interface PolicyCheckInput {
  chainKey: string;
  chainId: number;
  to?: `0x${string}`;
  value: bigint;
  data?: `0x${string}`;
}

export interface PolicyCheckResult {
  allow: boolean;
  code?: PolicyDenyCode;
  reason?: string;
  effectiveTo?: `0x${string}`;
  valueWei: bigint;
}

export function defaultSpendPolicy(): SpendPolicyConfig {
  return {
    enabled: false,
    allowContractCreation: false,
    allowAnyDestination: false,
    destinations: new Map(),
    chains: {},
    erc20RecipientCheck: true,
    humanGate: { mode: "stop" },
  };
}
