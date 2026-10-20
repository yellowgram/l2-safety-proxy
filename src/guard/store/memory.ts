import { randomUUID } from "node:crypto";
import type { Spend } from "../policy/types.js";
import type { AssetRecord, CapLimits, GuardStore, IdemRecord, ReserveResult, SenderState } from "./types.js";

interface Reservation {
  id: string;
  chainId: number;
  sender: string;
  at: number;
  native: string;
  tokens: [string, string][];
}

/** A state mutation. The file store journals these; the memory store just applies them. */
export type Op =
  | { op: "reserve"; r: Reservation }
  | { op: "release"; id: string }
  | { op: "idem"; rec: IdemRecord }
  | { op: "idemDel"; keys: string[] }
  | { op: "baseline"; k: string; nonce: number }
  | { op: "sent"; k: string; nonce: number; hash: string }
  | { op: "unsent"; k: string; nonce: number; hash: string }
  | { op: "lock"; k: string; reason: string; at: number }
  | { op: "unlock"; k: string }
  | { op: "poison"; address: string; reason: string }
  | { op: "asset"; rec: AssetRecord }
  | { op: "cursor"; name: string; value: string };

export interface MemoryStoreOptions {
  /** Refuse new idempotency keys beyond this many live records (fail-closed, never evict). Default 100 000. */
  maxIdemEntries?: number;
}

const sk = (chainId: number, sender: string) => `${chainId}:${sender.toLowerCase()}`;

/**
 * In-process store. Forgets everything on restart: use it for tests and
 * single-shot scripts. Use FileStore or PostgresStore for a real deployment.
 */
export class MemoryStore implements GuardStore {
  protected reservations = new Map<string, Reservation>();
  protected idem = new Map<string, IdemRecord>();
  protected senders = new Map<string, SenderState>();
  protected poison = new Map<string, string>();
  protected assets = new Map<string, AssetRecord>();
  protected cursors = new Map<string, string>();
  private maxIdem: number;

  constructor(opts: MemoryStoreOptions = {}) {
    this.maxIdem = opts.maxIdemEntries ?? 100_000;
  }

  /** Apply and (in subclasses) persist a mutation. */
  protected commit(op: Op): void {
    this.apply(op);
  }

  protected apply(op: Op): void {
    switch (op.op) {
      case "reserve":
        this.reservations.set(op.r.id, op.r);
        return;
      case "release":
        this.reservations.delete(op.id);
        return;
      case "idem":
        this.idem.set(op.rec.key, op.rec);
        return;
      case "idemDel":
        for (const k of op.keys) this.idem.delete(k);
        return;
      case "baseline":
        this.sender(op.k).baseline = op.nonce;
        return;
      case "sent":
        this.sender(op.k).sent.set(op.nonce, op.hash);
        return;
      case "unsent": {
        const s = this.sender(op.k);
        if (s.sent.get(op.nonce) === op.hash) s.sent.delete(op.nonce);
        return;
      }
      case "lock":
        this.sender(op.k).locked = { reason: op.reason, at: op.at };
        return;
      case "unlock":
        delete this.sender(op.k).locked;
        return;
      case "poison":
        this.poison.set(op.address, op.reason);
        return;
      case "asset":
        this.assets.set(op.rec.assetKey, op.rec);
        return;
      case "cursor":
        this.cursors.set(op.name, op.value);
        return;
    }
  }

  private sender(k: string): SenderState {
    let s = this.senders.get(k);
    if (!s) this.senders.set(k, (s = { sent: new Map() }));
    return s;
  }

  async reserveSpend(chainId: number, sender: string, spend: Spend, limits: CapLimits, windowSeconds: number, now: number): Promise<ReserveResult> {
    const s = sender.toLowerCase();
    const since = now - windowSeconds;
    let native = 0n;
    const tokens = new Map<string, bigint>();
    for (const [id, r] of this.reservations) {
      if (r.at <= since) {
        this.commit({ op: "release", id });
        continue;
      }
      if (r.chainId !== chainId || r.sender !== s) continue;
      native += BigInt(r.native);
      for (const [t, a] of r.tokens) tokens.set(t, (tokens.get(t) ?? 0n) + BigInt(a));
    }
    if (limits.native !== undefined && native + spend.native > limits.native) {
      return { ok: false, what: "native", used: native, adding: spend.native, limit: limits.native };
    }
    for (const [t, amt] of spend.tokens) {
      const limit = limits.tokens.get(t);
      const used = tokens.get(t) ?? 0n;
      if (limit !== undefined && used + amt > limit) return { ok: false, what: t, used, adding: amt, limit };
    }
    const id = randomUUID();
    this.commit({
      op: "reserve",
      r: { id, chainId, sender: s, at: now, native: spend.native.toString(), tokens: [...spend.tokens].map(([t, a]) => [t, a.toString()]) },
    });
    return { ok: true, id };
  }

  async releaseSpend(id: string): Promise<void> {
    if (this.reservations.has(id)) this.commit({ op: "release", id });
  }

  async getIdem(key: string): Promise<IdemRecord | undefined> {
    return this.idem.get(key);
  }

  async claimIdem(rec: IdemRecord): Promise<boolean> {
    if (this.idem.has(rec.key)) return false;
    if (this.idem.size >= this.maxIdem) throw new Error(`idempotency store full (${this.maxIdem} keys); refusing new keys`);
    this.commit({ op: "idem", rec });
    return true;
  }

  async putIdem(rec: IdemRecord): Promise<void> {
    this.commit({ op: "idem", rec });
  }

  async expireIdem(olderThan: number): Promise<number> {
    const keys = [...this.idem.values()].filter((r) => r.status !== "in_flight" && r.updatedAt < olderThan).map((r) => r.key);
    if (keys.length) this.commit({ op: "idemDel", keys });
    return keys.length;
  }

  async senderState(chainId: number, sender: string): Promise<SenderState> {
    const s = this.senders.get(sk(chainId, sender));
    return s ? { baseline: s.baseline, sent: new Map(s.sent), locked: s.locked } : { sent: new Map() };
  }

  async setBaseline(chainId: number, sender: string, nonce: number): Promise<void> {
    this.commit({ op: "baseline", k: sk(chainId, sender), nonce });
  }

  async noteSent(chainId: number, sender: string, nonce: number, hash: string): Promise<void> {
    this.commit({ op: "sent", k: sk(chainId, sender), nonce, hash });
  }

  async forgetSent(chainId: number, sender: string, nonce: number, hash: string): Promise<void> {
    this.commit({ op: "unsent", k: sk(chainId, sender), nonce, hash });
  }

  async lock(chainId: number, sender: string, reason: string, at: number): Promise<void> {
    this.commit({ op: "lock", k: sk(chainId, sender), reason, at });
  }

  async unlock(chainId: number, sender: string): Promise<void> {
    this.commit({ op: "unlock", k: sk(chainId, sender) });
  }

  async addPoisoned(address: string, reason: string): Promise<void> {
    this.commit({ op: "poison", address: address.toLowerCase(), reason });
  }

  async poisoned(): Promise<Set<string>> {
    return new Set(this.poison.keys());
  }

  async putAsset(rec: AssetRecord): Promise<void> {
    this.commit({ op: "asset", rec });
  }

  async getAsset(assetKey: string): Promise<AssetRecord | undefined> {
    return this.assets.get(assetKey);
  }

  async listAssets(): Promise<AssetRecord[]> {
    return [...this.assets.values()];
  }

  async getCursor(name: string): Promise<string | undefined> {
    return this.cursors.get(name);
  }

  async setCursor(name: string, value: string): Promise<void> {
    this.commit({ op: "cursor", name, value });
  }

  async close(): Promise<void> {}

  /** Number of live idempotency records (for tests and health output). */
  get idemCount(): number {
    return this.idem.size;
  }
}
