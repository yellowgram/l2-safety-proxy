import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { MemoryStore, type MemoryStoreOptions, type Op } from "./memory.js";

/**
 * Durable single-process store: an append-only journal, fsynced on every write,
 * compacted on open. A lock file stops two guards from sharing one journal
 * (that would break the rolling caps). For several guard processes, use PostgresStore.
 */
export class FileStore extends MemoryStore {
  private fd: number;
  private lockPath: string;
  private ready = false;

  constructor(private path: string, opts: MemoryStoreOptions = {}) {
    super(opts);
    this.lockPath = `${path}.lock`;
    takeLock(this.lockPath);
    try {
      if (existsSync(path)) {
        const lines = readFileSync(path, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (!line.trim()) return;
          let op: Op;
          try {
            op = JSON.parse(line) as Op;
          } catch {
            // A torn final line is the one write that didn't finish; anything else is corruption.
            if (i >= lines.length - 2) return;
            throw new Error(`${path}:${i + 1}: journal line is not JSON; refusing to start (fix or move the file)`);
          }
          this.apply(op);
        });
      }
      const tmp = `${path}.tmp`;
      const t = openSync(tmp, "w", 0o600);
      for (const op of this.snapshot()) writeSync(t, JSON.stringify(op) + "\n");
      fsyncSync(t);
      closeSync(t);
      renameSync(tmp, path);
      this.fd = openSync(path, "a", 0o600);
      this.ready = true;
    } catch (err) {
      releaseLock(this.lockPath);
      throw err;
    }
  }

  protected override commit(op: Op): void {
    if (this.ready) {
      writeSync(this.fd, JSON.stringify(op) + "\n");
      fsyncSync(this.fd);
    }
    this.apply(op);
  }

  private *snapshot(): Generator<Op> {
    for (const r of this.reservations.values()) yield { op: "reserve", r };
    for (const rec of this.idem.values()) yield { op: "idem", rec };
    for (const [k, s] of this.senders) {
      if (s.baseline !== undefined) yield { op: "baseline", k, nonce: s.baseline };
      for (const [nonce, hash] of s.sent) yield { op: "sent", k, nonce, hash };
      if (s.locked) yield { op: "lock", k, reason: s.locked.reason, at: s.locked.at };
    }
    for (const [address, reason] of this.poison) yield { op: "poison", address, reason };
    for (const rec of this.assets.values()) yield { op: "asset", rec };
    for (const [name, value] of this.cursors) yield { op: "cursor", name, value };
  }

  override async close(): Promise<void> {
    if (!this.ready) return;
    this.ready = false;
    closeSync(this.fd);
    releaseLock(this.lockPath);
  }
}

function takeLock(lockPath: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      if (pid && alive(pid)) {
        throw new Error(`store ${lockPath.slice(0, -5)} is in use by process ${pid}; one guard per store file (use PostgresStore for several)`);
      }
      unlinkSync(lockPath); // stale lock from a crashed process
    }
  }
  throw new Error(`could not lock ${lockPath}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}
