import type { Address, Hex } from "viem";
import { evaluateTx } from "./policy/evaluate.js";
import type { DenyCode, Policy } from "./policy/types.js";
import type { GuardStore, IdemRecord } from "./store/types.js";
import { TxParseError, parseSignedTx, type SignedTx } from "./tx.js";

/** Read-only chain access the guard needs for bypass detection and in-flight recovery. */
export interface ChainReader {
  getNonce(address: Address): Promise<number>;
  /** True if the node knows this tx (pending or mined). */
  hasTransaction(hash: Hex): Promise<boolean>;
}

export interface BypassEvent {
  chainId: number;
  sender: string;
  onChainNonce: number;
  missing: number[];
  at: number;
}

export interface GuardOptions {
  policy: Policy;
  store: GuardStore;
  /** Per chain id. Without one, bypass detection and in-flight recovery are off for that chain. */
  readers?: Map<number, ChainReader> | ((chainId: number) => ChainReader | undefined);
  /** Detect txs the guard never saw (default true when a reader exists). */
  detectBypass?: boolean;
  /** On detection, refuse further sends from that sender until unlocked (default true). */
  lockOnBypass?: boolean;
  onBypass?: (e: BypassEvent) => void | Promise<void>;
  /** Finished idempotency records are dropped after this long. Default 86 400. */
  idempotencyTtlSeconds?: number;
  now?: () => number;
}

export type Check =
  | {
      action: "forward";
      tx: SignedTx;
      /** Identical bytes already sent under this key: forwarding again is harmless. */
      replay: boolean;
      /** On a replay: what the guard knows about the first send. */
      priorStatus?: IdemRecord["status"];
      reservationId?: string;
      idempotencyKey?: string;
      /** Calls allowed only by allowAnySelector. The proxy prints each as a WARNING. */
      warnings?: string[];
      /** How the guard read the transaction (Verdict.notes). The proxy writes them to the decision log. */
      notes?: string[];
    }
  | {
      action: "deny";
      code: DenyCode | "IDEMPOTENCY_CONFLICT" | "CHAIN_READ_FAILED" | "INTERNAL_ERROR";
      reason: string;
      path?: string;
      tx?: SignedTx;
      /** The tx already recorded under this idempotency key, on conflict. */
      priorTxHash?: string;
      notes?: string[];
    };

/**
 * What the upstream did with a forwarded tx.
 * - accepted: in the node (result, or "already known").
 * - rejected: definitely refused and can never be included as sent (a known validation error).
 * - nonce_used: "nonce too low". Either this tx was already mined (a rebroadcast) or another
 *   tx took the nonce. This one can't be included now, but the slot's record isn't erased
 *   unless the chain shows this tx isn't there.
 * - unknown: anything else, including an eth_sendRawTransactionSync timeout (EIP-7966 code 4:
 *   added to the mempool, not yet included), 5xx, network errors and unrecognized messages.
 *   Caps and the Idempotency-Key stay held.
 */
export type Outcome = "accepted" | "rejected" | "nonce_used" | "unknown";

/** Upstream errors that mean the tx is already in the node (not a refusal). */
const ALREADY_KNOWN = /already known|known transaction|already imported|already exists|alreadyknown/i;
const NONCE_USED = /nonce too low|nonce has already been used|nonce already used|old nonce/i;
/** Validation errors after which the tx is not in the node and can't get there unchanged. */
const DEFINITE_REJECTION =
  /insufficient funds|intrinsic gas too low|exceeds block gas limit|gas limit reached|(max )?fee (per gas |cap )?less than block base fee|transaction underpriced|replacement transaction underpriced|invalid sender|invalid signature|invalid chain ?id|chain ?id mismatch|exceeds the configured cap|oversized data|nonce too high|transaction type not supported|tx type not supported|max priority fee per gas higher than max fee per gas|tip higher than fee cap|rlp:|txpool is full/i;
/** JSON-RPC codes that mean the request itself was refused before any tx handling. */
const REQUEST_REFUSED = new Set([-32700, -32600, -32601, -32602]);

export function classifyUpstream(res: { error?: { code?: number; message?: string } } | undefined, threw: boolean): Outcome {
  if (threw || !res) return "unknown";
  if (!res.error) return "accepted";
  const msg = res.error.message ?? "";
  if (ALREADY_KNOWN.test(msg)) return "accepted";
  if (NONCE_USED.test(msg)) return "nonce_used";
  if (typeof res.error.code === "number" && REQUEST_REFUSED.has(res.error.code)) return "rejected";
  if (DEFINITE_REJECTION.test(msg)) return "rejected";
  return "unknown";
}

/** Rolling caps apply per sender across every chain in the policy (docs/POLICY.md). */
const CAP_SCOPE_ALL_CHAINS = 0;

/**
 * The guard: policy, rolling caps, idempotency and bypass detection around one
 * signed transaction. Call `check` before broadcasting and `settle` after.
 */
export class Guard {
  constructor(private opts: GuardOptions) {}

  /** The store this guard reads and writes (the receive watch shares it). */
  get store(): GuardStore {
    return this.opts.store;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000);
  }

  /** The chain reader, with failures tagged so they aren't reported as a store outage. */
  private reader(chainId: number): ChainReader | undefined {
    const r = this.rawReader(chainId);
    if (!r) return undefined;
    return {
      getNonce: (a) => r.getNonce(a).catch((e: unknown) => { throw new ChainReadError("the sender's nonce", e); }),
      hasTransaction: (h) => r.hasTransaction(h).catch((e: unknown) => { throw new ChainReadError("a transaction's status", e); }),
    };
  }

  private rawReader(chainId: number): ChainReader | undefined {
    const r = this.opts.readers;
    if (!r) return undefined;
    return typeof r === "function" ? r(chainId) : r.get(chainId);
  }

  get policy(): Policy {
    return this.opts.policy;
  }

  async check(raw: Hex, ctx: { chainId: number; idempotencyKey?: string }): Promise<Check> {
    let tx: SignedTx;
    try {
      tx = await parseSignedTx(raw);
    } catch (err) {
      if (err instanceof TxParseError) return deny("TX_UNPARSEABLE", `signed transaction does not parse: ${err.message}`);
      throw err;
    }
    if (!tx.from || tx.nonce === undefined) return deny("SENDER_UNRECOVERABLE", "can't recover the sender from the signature", undefined, tx);
    if (tx.chainId === undefined) {
      return deny("REPLAYABLE_TX", "legacy transaction without a chain id (pre-EIP-155) can be replayed on every chain; sign it with a chain id", undefined, tx);
    }
    const chainId = tx.chainId;
    const store = this.opts.store;
    const key = ctx.idempotencyKey?.trim() || undefined;
    if (key && Buffer.byteLength(key) > 255) return deny("IDEMPOTENCY_CONFLICT", "idempotency key is longer than 255 bytes", undefined, tx);

    try {
      const lockedReason = await this.bypassCheck(chainId, tx.from);
      if (lockedReason) return deny("BYPASS_LOCKED", lockedReason, undefined, tx);

      let prior: IdemRecord | undefined;
      if (key) {
        prior = await store.getIdem(key);
        if (prior && prior.status === "in_flight" && prior.txHash !== tx.hash) prior = await this.resolve(prior);
        if (prior && prior.txHash === tx.hash && prior.status !== "rejected") {
          return { action: "forward", tx, replay: true, idempotencyKey: key, priorStatus: prior.status };
        }
        if (prior && prior.status !== "rejected") {
          const sameSlot = prior.sender === tx.from.toLowerCase() && prior.nonce === tx.nonce && prior.chainId === chainId;
          if (!sameSlot) {
            return {
              action: "deny",
              code: "IDEMPOTENCY_CONFLICT",
              reason:
                `idempotency key already used for ${prior.txHash} (nonce ${prior.nonce}, ${prior.status}). ` +
                (prior.status === "in_flight"
                  ? `It may still be mined. To replace it, re-sign with nonce ${prior.nonce}.`
                  : "That transaction was sent; don't send a second one under this key."),
              priorTxHash: prior.txHash,
              tx,
            };
          }
          // Same sender and nonce: a replacement (fee bump). Only one of them can be mined.
        }
      }

      const poisoned = await store.poisoned();
      let verdict: ReturnType<typeof evaluateTx>;
      try {
        verdict = evaluateTx(this.opts.policy, tx, { chainId, now: this.now(), poisoned });
      } catch (err) {
        return deny("INTERNAL_ERROR", `the policy check failed unexpectedly, refusing to send: ${(err as Error).message}`, undefined, tx);
      }
      const notes = verdict.notes ? { notes: verdict.notes } : {};
      if (!verdict.allow) return { ...deny(verdict.code!, verdict.reason!, verdict.path, tx), ...notes };

      const p = this.opts.policy;
      const limits = { native: p.native.windowMaxWei, tokens: new Map<string, bigint>() };
      for (const [t, rule] of p.tokens) if (rule.windowMaxAmountRaw !== undefined) limits.tokens.set(t, rule.windowMaxAmountRaw);
      let reservationId: string | undefined;
      if (limits.native !== undefined || limits.tokens.size > 0) {
        const r = await store.reserveSpend(CAP_SCOPE_ALL_CHAINS, tx.from, verdict.spend, limits, p.windowSeconds, this.now());
        if (!r.ok) {
          const why = `${r.what === "native" ? "native" : r.what}: ${r.used} already moved in the last ${p.windowSeconds}s; adding ${r.adding} would pass the limit ${r.limit}`;
          return { ...deny("WINDOW_CAP_EXCEEDED", why, undefined, tx), ...notes };
        }
        reservationId = r.id;
      }

      if (key) {
        const t = this.now();
        const rec: IdemRecord = {
          key,
          txHash: tx.hash,
          sender: tx.from.toLowerCase(),
          nonce: tx.nonce,
          chainId,
          status: "in_flight",
          reservationId,
          createdAt: prior?.createdAt ?? t,
          updatedAt: t,
        };
        if (prior) {
          await store.putIdem(rec);
          if (prior.reservationId && prior.status === "in_flight") await store.releaseSpend(prior.reservationId);
        }
        else if (!(await store.claimIdem(rec))) {
          if (reservationId) await store.releaseSpend(reservationId);
          return this.check(raw, ctx); // lost a race with an identical request; re-read
        }
      }

      // Record the nonce before broadcasting, so a fast inclusion can't look like a bypass.
      await store.noteSent(chainId, tx.from, tx.nonce, tx.hash);
      for (const a of tx.authorizationList) {
        if (a.authority && (a.chainId === chainId || a.chainId === 0)) await store.noteSent(chainId, a.authority, a.nonce, tx.hash);
      }
      return { action: "forward", tx, replay: false, reservationId, idempotencyKey: key, ...(verdict.warnings ? { warnings: verdict.warnings } : {}), ...notes };
    } catch (err) {
      if (err instanceof ChainReadError) {
        return deny("CHAIN_READ_FAILED", `couldn't read ${err.what} from the chain's RPC, so the guard can't check for bypasses; refusing to send: ${err.message}`, undefined, tx);
      }
      return deny("STORE_DOWN", `guard state store failed, refusing to send: ${(err as Error).message}`, undefined, tx);
    }
  }

  /** Record what the upstream did with a forwarded tx. */
  async settle(check: Extract<Check, { action: "forward" }>, outcome: Outcome): Promise<void> {
    const { tx } = check;
    const store = this.opts.store;
    const chainId = tx.chainId!;
    if (check.replay) {
      if (outcome === "accepted" && check.idempotencyKey) {
        const rec = await store.getIdem(check.idempotencyKey);
        if (rec && rec.status === "in_flight") await store.putIdem({ ...rec, status: "sent", updatedAt: this.now() });
      }
      return;
    }
    // "nonce too low": this tx can't be included now. It was either mined already (a
    // rebroadcast) or another tx took the nonce. Give back this send's reservation, but
    // never erase the nonce's sent record: a rebroadcast of a mined tx would otherwise make
    // the next send look like a bypass. A foreign tx on that nonce is caught by the bypass
    // check that runs before every forward. The idempotency record stays in flight and is
    // resolved from chain state on the next use of the key.
    if (outcome === "nonce_used") {
      if (check.reservationId) await store.releaseSpend(check.reservationId);
    }
    if (outcome === "rejected") {
      if (check.reservationId) await store.releaseSpend(check.reservationId);
      await store.forgetSent(chainId, tx.from!, tx.nonce!, tx.hash);
      for (const a of tx.authorizationList) if (a.authority) await store.forgetSent(chainId, a.authority, a.nonce, tx.hash);
    }
    if (check.idempotencyKey && (outcome === "accepted" || outcome === "rejected")) {
      const rec = await store.getIdem(check.idempotencyKey);
      if (rec && rec.txHash === tx.hash) {
        await store.putIdem({ ...rec, status: outcome === "accepted" ? "sent" : "rejected", updatedAt: this.now() });
      }
    }
    await store.expireIdem(this.now() - (this.opts.idempotencyTtlSeconds ?? 86_400));
  }

  /**
   * Work out what happened to an in-flight idempotency record: mined or pending → sent;
   * its nonce used by something else → rejected (the key is free again). Otherwise unchanged.
   */
  async resolveInFlight(key: string): Promise<IdemRecord | undefined> {
    const rec = await this.opts.store.getIdem(key);
    return rec && rec.status === "in_flight" ? this.resolve(rec) : rec;
  }

  private async resolve(rec: IdemRecord): Promise<IdemRecord> {
    const reader = rec.chainId !== undefined ? this.reader(rec.chainId) : undefined;
    if (!reader || !rec.sender || rec.nonce === undefined) return rec;
    let next: IdemRecord["status"] | undefined;
    if (await reader.hasTransaction(rec.txHash as Hex)) next = "sent";
    else if ((await reader.getNonce(rec.sender as Address)) > rec.nonce) next = "rejected";
    if (!next) return rec;
    const updated = { ...rec, status: next, updatedAt: this.now() };
    await this.opts.store.putIdem(updated);
    return updated;
  }

  /** Returns a reason string if the sender is (or just became) locked. */
  private async bypassCheck(chainId: number, sender: Address): Promise<string | undefined> {
    const store = this.opts.store;
    const state = await store.senderState(chainId, sender);
    if (state.locked) return lockedMessage(sender, state.locked.reason);
    const reader = this.reader(chainId);
    if (!reader || this.opts.detectBypass === false) return undefined;
    const onChain = await reader.getNonce(sender);
    if (state.baseline === undefined) {
      await store.setBaseline(chainId, sender, onChain);
      return undefined;
    }
    const missing: number[] = [];
    for (let n = state.baseline; n < onChain && missing.length < 16; n++) if (!state.sent.has(n)) missing.push(n);
    if (missing.length === 0) return undefined;
    const event: BypassEvent = { chainId, sender: sender.toLowerCase(), onChainNonce: onChain, missing, at: this.now() };
    const reason = `nonce ${missing.join(", ")} of ${sender} on chain ${chainId} was used by a transaction this guard never forwarded`;
    await this.opts.onBypass?.(event);
    if (this.opts.lockOnBypass === false) {
      // Alert once, then accept the new chain state as the baseline.
      for (const n of missing) await store.noteSent(chainId, sender, n, "bypass");
      return undefined;
    }
    await store.lock(chainId, sender, reason, event.at);
    return lockedMessage(sender, reason);
  }

  /** Operator action after investigating a bypass: accept the current chain state and resume. */
  async unlock(chainId: number, sender: Address): Promise<void> {
    const store = this.opts.store;
    await store.unlock(chainId, sender);
    const reader = this.reader(chainId);
    if (reader) await store.setBaseline(chainId, sender, await reader.getNonce(sender));
  }
}

class ChainReadError extends Error {
  constructor(public what: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

function lockedMessage(sender: string, reason: string): string {
  return `sends from ${sender} are locked: ${reason}. Investigate, then run: l2-send-guard unlock ${sender}`;
}

function deny(code: DenyCode | "IDEMPOTENCY_CONFLICT" | "CHAIN_READ_FAILED" | "INTERNAL_ERROR", reason: string, path?: string, tx?: SignedTx): Check {
  return { action: "deny", code, reason, path, tx };
}
