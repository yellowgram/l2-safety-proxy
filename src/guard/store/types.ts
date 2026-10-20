import type { Spend } from "../policy/types.js";

export interface IdemRecord {
  key: string;
  /** keccak256 of the signed bytes = the tx hash. */
  txHash: string;
  sender?: string;
  nonce?: number;
  chainId?: number;
  status: "in_flight" | "sent" | "rejected";
  /** Rolling-cap reservation for this tx, released if it is replaced. */
  reservationId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SenderState {
  /** On-chain nonce when the guard first saw this sender. */
  baseline?: number;
  /** Nonces the guard forwarded. */
  sent: Map<number, string>;
  locked?: { reason: string; at: number };
}

export interface CapLimits {
  native?: bigint;
  tokens: Map<string, bigint>;
}

export type ReserveResult =
  | { ok: true; id: string }
  | { ok: false; what: string; used: bigint; adding: bigint; limit: bigint };

export interface AssetRecord {
  assetKey: string;
  label: "clear" | "quarantine" | "toxic";
  reasons: string[];
  token?: string;
  sender?: string;
  amount?: string;
  note?: string;
}

/**
 * Everything the guard remembers. One interface so rolling caps, idempotency,
 * bypass detection and the receive watch can share a file or a database.
 * Every method may throw; callers treat a throw as "store down" and deny.
 */
export interface GuardStore {
  reserveSpend(chainId: number, sender: string, spend: Spend, limits: CapLimits, windowSeconds: number, now: number): Promise<ReserveResult>;
  releaseSpend(id: string): Promise<void>;

  getIdem(key: string): Promise<IdemRecord | undefined>;
  /** Insert if absent. True if this caller created it. */
  claimIdem(rec: IdemRecord): Promise<boolean>;
  putIdem(rec: IdemRecord): Promise<void>;
  /** Drop finished records older than `olderThan` (unix s). In-flight records are kept. */
  expireIdem(olderThan: number): Promise<number>;

  senderState(chainId: number, sender: string): Promise<SenderState>;
  setBaseline(chainId: number, sender: string, nonce: number): Promise<void>;
  noteSent(chainId: number, sender: string, nonce: number, txHash: string): Promise<void>;
  /** Undo noteSent when the upstream definitely refused the tx. */
  forgetSent(chainId: number, sender: string, nonce: number, txHash: string): Promise<void>;
  lock(chainId: number, sender: string, reason: string, at: number): Promise<void>;
  unlock(chainId: number, sender: string): Promise<void>;

  addPoisoned(address: string, reason: string): Promise<void>;
  poisoned(): Promise<Set<string>>;
  putAsset(rec: AssetRecord): Promise<void>;
  getAsset(assetKey: string): Promise<AssetRecord | undefined>;
  listAssets(): Promise<AssetRecord[]>;
  getCursor(name: string): Promise<string | undefined>;
  setCursor(name: string, value: string): Promise<void>;

  close(): Promise<void>;
}
