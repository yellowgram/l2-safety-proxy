import { randomUUID } from "node:crypto";
import type { Spend } from "../policy/types.js";
import type { AssetRecord, CapLimits, GuardStore, IdemRecord, ReserveResult, SenderState } from "./types.js";

/** The subset of `pg.Pool` this store uses. */
export interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect(): Promise<{ query: PgPool["query"]; release(): void }>;
  end(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS l2sg_spend (id uuid PRIMARY KEY, chain_id bigint NOT NULL, sender text NOT NULL, at bigint NOT NULL, native numeric NOT NULL, tokens jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS l2sg_spend_window ON l2sg_spend (chain_id, sender, at);
CREATE TABLE IF NOT EXISTS l2sg_idem (key text PRIMARY KEY, rec jsonb NOT NULL, status text NOT NULL, updated_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS l2sg_sender (chain_id bigint NOT NULL, sender text NOT NULL, baseline bigint, locked_reason text, locked_at bigint, PRIMARY KEY (chain_id, sender));
CREATE TABLE IF NOT EXISTS l2sg_sent (chain_id bigint NOT NULL, sender text NOT NULL, nonce bigint NOT NULL, hash text NOT NULL, PRIMARY KEY (chain_id, sender, nonce));
CREATE TABLE IF NOT EXISTS l2sg_poison (address text PRIMARY KEY, reason text NOT NULL);
CREATE TABLE IF NOT EXISTS l2sg_asset (asset_key text PRIMARY KEY, rec jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS l2sg_cursor (name text PRIMARY KEY, value text NOT NULL);
`;

/**
 * Shared store for several guard processes. Rolling-cap reservations take a
 * per-sender advisory lock so two guards can't both spend the last of a window.
 */
export class PostgresStore implements GuardStore {
  private constructor(private pool: PgPool, private ownsPool: boolean) {}

  /** Connect with `pg` (an optional peer dependency) and create tables if missing. */
  static async connect(connectionString: string): Promise<PostgresStore> {
    let pg: { default?: { Pool: new (o: object) => PgPool }; Pool?: new (o: object) => PgPool };
    try {
      pg = await import("pg" as string);
    } catch {
      throw new Error('PostgresStore needs the "pg" package: npm i pg');
    }
    const Pool = pg.Pool ?? pg.default!.Pool;
    const store = new PostgresStore(new Pool({ connectionString, max: 5 }), true);
    await store.pool.query(SCHEMA);
    return store;
  }

  /** Use an existing pool (tables are created if missing). */
  static async fromPool(pool: PgPool): Promise<PostgresStore> {
    await pool.query(SCHEMA);
    return new PostgresStore(pool, false);
  }

  async reserveSpend(chainId: number, sender: string, spend: Spend, limits: CapLimits, windowSeconds: number, now: number): Promise<ReserveResult> {
    const s = sender.toLowerCase();
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`l2sg:${chainId}:${s}`]);
      await c.query("DELETE FROM l2sg_spend WHERE chain_id = $1 AND sender = $2 AND at <= $3", [chainId, s, now - windowSeconds]);
      const n = await c.query("SELECT coalesce(sum(native), 0)::text AS used FROM l2sg_spend WHERE chain_id = $1 AND sender = $2", [chainId, s]);
      const native = BigInt(n.rows[0]!.used as string);
      if (limits.native !== undefined && native + spend.native > limits.native) {
        await c.query("ROLLBACK");
        return { ok: false, what: "native", used: native, adding: spend.native, limit: limits.native };
      }
      const t = await c.query(
        "SELECT key, sum(value::numeric)::text AS used FROM l2sg_spend, jsonb_each_text(tokens) WHERE chain_id = $1 AND sender = $2 GROUP BY key",
        [chainId, s]
      );
      const used = new Map(t.rows.map((r) => [r.key as string, BigInt(r.used as string)]));
      for (const [token, amt] of spend.tokens) {
        const limit = limits.tokens.get(token);
        const u = used.get(token) ?? 0n;
        if (limit !== undefined && u + amt > limit) {
          await c.query("ROLLBACK");
          return { ok: false, what: token, used: u, adding: amt, limit };
        }
      }
      const id = randomUUID();
      await c.query("INSERT INTO l2sg_spend (id, chain_id, sender, at, native, tokens) VALUES ($1, $2, $3, $4, $5, $6)", [
        id,
        chainId,
        s,
        now,
        spend.native.toString(),
        JSON.stringify(Object.fromEntries([...spend.tokens].map(([k, v]) => [k, v.toString()]))),
      ]);
      await c.query("COMMIT");
      return { ok: true, id };
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async releaseSpend(id: string): Promise<void> {
    await this.pool.query("DELETE FROM l2sg_spend WHERE id = $1", [id]);
  }

  async getIdem(key: string): Promise<IdemRecord | undefined> {
    const r = await this.pool.query("SELECT rec FROM l2sg_idem WHERE key = $1", [key]);
    return r.rows[0]?.rec as IdemRecord | undefined;
  }

  async claimIdem(rec: IdemRecord): Promise<boolean> {
    const r = await this.pool.query(
      "INSERT INTO l2sg_idem (key, rec, status, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING",
      [rec.key, JSON.stringify(rec), rec.status, rec.updatedAt]
    );
    return r.rowCount === 1;
  }

  async putIdem(rec: IdemRecord): Promise<void> {
    await this.pool.query(
      "INSERT INTO l2sg_idem (key, rec, status, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO UPDATE SET rec = EXCLUDED.rec, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at",
      [rec.key, JSON.stringify(rec), rec.status, rec.updatedAt]
    );
  }

  async expireIdem(olderThan: number): Promise<number> {
    const r = await this.pool.query("DELETE FROM l2sg_idem WHERE status <> 'in_flight' AND updated_at < $1", [olderThan]);
    return r.rowCount ?? 0;
  }

  async senderState(chainId: number, sender: string): Promise<SenderState> {
    const s = sender.toLowerCase();
    const a = await this.pool.query("SELECT baseline, locked_reason, locked_at FROM l2sg_sender WHERE chain_id = $1 AND sender = $2", [chainId, s]);
    const b = await this.pool.query("SELECT nonce, hash FROM l2sg_sent WHERE chain_id = $1 AND sender = $2", [chainId, s]);
    const row = a.rows[0];
    return {
      baseline: row?.baseline == null ? undefined : Number(row.baseline),
      sent: new Map(b.rows.map((r) => [Number(r.nonce), r.hash as string])),
      locked: row?.locked_reason ? { reason: row.locked_reason as string, at: Number(row.locked_at) } : undefined,
    };
  }

  async setBaseline(chainId: number, sender: string, nonce: number): Promise<void> {
    await this.pool.query(
      "INSERT INTO l2sg_sender (chain_id, sender, baseline) VALUES ($1, $2, $3) ON CONFLICT (chain_id, sender) DO UPDATE SET baseline = EXCLUDED.baseline",
      [chainId, sender.toLowerCase(), nonce]
    );
  }

  async noteSent(chainId: number, sender: string, nonce: number, hash: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO l2sg_sent (chain_id, sender, nonce, hash) VALUES ($1, $2, $3, $4) ON CONFLICT (chain_id, sender, nonce) DO UPDATE SET hash = EXCLUDED.hash",
      [chainId, sender.toLowerCase(), nonce, hash]
    );
  }

  async forgetSent(chainId: number, sender: string, nonce: number, hash: string): Promise<void> {
    await this.pool.query("DELETE FROM l2sg_sent WHERE chain_id = $1 AND sender = $2 AND nonce = $3 AND hash = $4", [chainId, sender.toLowerCase(), nonce, hash]);
  }

  async lock(chainId: number, sender: string, reason: string, at: number): Promise<void> {
    await this.pool.query(
      "INSERT INTO l2sg_sender (chain_id, sender, locked_reason, locked_at) VALUES ($1, $2, $3, $4) ON CONFLICT (chain_id, sender) DO UPDATE SET locked_reason = EXCLUDED.locked_reason, locked_at = EXCLUDED.locked_at",
      [chainId, sender.toLowerCase(), reason, at]
    );
  }

  async unlock(chainId: number, sender: string): Promise<void> {
    await this.pool.query("UPDATE l2sg_sender SET locked_reason = NULL, locked_at = NULL WHERE chain_id = $1 AND sender = $2", [chainId, sender.toLowerCase()]);
  }

  async addPoisoned(address: string, reason: string): Promise<void> {
    await this.pool.query("INSERT INTO l2sg_poison (address, reason) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING", [address.toLowerCase(), reason]);
  }

  async poisoned(): Promise<Set<string>> {
    const r = await this.pool.query("SELECT address FROM l2sg_poison");
    return new Set(r.rows.map((x) => x.address as string));
  }

  async putAsset(rec: AssetRecord): Promise<void> {
    await this.pool.query(
      "INSERT INTO l2sg_asset (asset_key, rec) VALUES ($1, $2) ON CONFLICT (asset_key) DO UPDATE SET rec = EXCLUDED.rec",
      [rec.assetKey, JSON.stringify(rec)]
    );
  }

  async getAsset(assetKey: string): Promise<AssetRecord | undefined> {
    const r = await this.pool.query("SELECT rec FROM l2sg_asset WHERE asset_key = $1", [assetKey]);
    return r.rows[0]?.rec as AssetRecord | undefined;
  }

  async listAssets(): Promise<AssetRecord[]> {
    const r = await this.pool.query("SELECT rec FROM l2sg_asset ORDER BY asset_key");
    return r.rows.map((x) => x.rec as AssetRecord);
  }

  async getCursor(name: string): Promise<string | undefined> {
    const r = await this.pool.query("SELECT value FROM l2sg_cursor WHERE name = $1", [name]);
    return r.rows[0]?.value as string | undefined;
  }

  async setCursor(name: string, value: string): Promise<void> {
    await this.pool.query("INSERT INTO l2sg_cursor (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value", [name, value]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
