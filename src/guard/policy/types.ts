/** The loaded, validated policy. All addresses lowercase. */
export interface Policy {
  /** Chain ids this policy applies to. Empty = any chain. */
  chains: Set<number>;
  windowSeconds: number;
  native: { maxPerTxWei?: bigint; windowMaxWei?: bigint };
  destinations: Map<string, DestinationRule>;
  tokens: Map<string, TokenRule>;
  permit2: { addresses: Map<number, string>; defaultAddress: string; maxExpirySeconds: number };
  delegation: { mode: "deny" | "allowlist"; delegates: Set<string>; allowAnyChain: boolean };
  accounts: Set<string>;
  universalRouter: { recipients: Set<string> };
  allowContractCreation: boolean;
  typedData: { allowUnknown: boolean };
}

export interface DestinationRule {
  maxNativeWei?: bigint;
  /** If set, only these 4-byte selectors may be called. "0x" allows plain value transfers. */
  selectors?: Set<string>;
}

export interface TokenRule {
  transfer: { recipients: Set<string>; maxAmountRaw?: bigint };
  approve: { spenders: Set<string>; maxAmountRaw?: bigint; operators: Set<string> };
  windowMaxAmountRaw?: bigint;
}

/** What one transaction can move, summed over every leaf. Used for rolling caps. */
export interface Spend {
  native: bigint;
  /** token (lowercase) → raw amount transferred or granted */
  tokens: Map<string, bigint>;
}

export interface Verdict {
  allow: boolean;
  code?: DenyCode;
  reason?: string;
  /** Where in the call tree the rule fired, e.g. tx>aggregate3[1]. */
  path?: string;
  spend: Spend;
}

export type DenyCode =
  | "TX_UNPARSEABLE"
  | "SENDER_UNRECOVERABLE"
  | "CHAIN_NOT_ALLOWED"
  | "METHOD_NOT_GATED"
  | "CONTRACT_CREATION_DENIED"
  | "DESTINATION_NOT_ALLOWED"
  | "SELECTOR_NOT_ALLOWED"
  | "OVER_CAP"
  | "TOKEN_NOT_ALLOWED"
  | "RECIPIENT_NOT_ALLOWED"
  | "TRANSFER_OVER_CAP"
  | "SPENDER_NOT_ALLOWED"
  | "APPROVAL_UNLIMITED"
  | "APPROVAL_OVER_CAP"
  | "OPERATOR_APPROVAL_DENIED"
  | "PERMIT2_EXPIRY_TOO_LONG"
  | "PERMIT2_CALL_UNKNOWN"
  | "AUTHORIZATION_DENIED"
  | "AUTHORIZATION_ANY_CHAIN"
  | "AUTHORIZATION_WRONG_CHAIN"
  | "AUTHORIZATION_UNRECOVERABLE"
  | "POISONED_ADDRESS"
  | "NON_CANONICAL_ABI"
  | "DELEGATECALL_DENIED"
  | "TOO_DEEP"
  | "MALFORMED_BATCH"
  | "ROUTER_COMMAND_UNCHECKED"
  | "ROUTER_RECIPIENT_NOT_ALLOWED"
  | "WINDOW_CAP_EXCEEDED"
  | "TYPED_DATA_UNKNOWN"
  | "STORE_DOWN"
  | "BYPASS_LOCKED";
