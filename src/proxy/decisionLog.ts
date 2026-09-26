import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Stable JSONL decision record. Buyers grep `decision` values:
 * `policy_denied`, `abort`, `fail_open`, `forward`, `unsigned_refused`, `chain_mismatch`.
 * No raw transaction and no allowlist. `to` is omitted on purpose.
 */
export interface DecisionLogRecord {
  ts: string;
  decision: string;
  code: number | null;
  chainId: number;
  chainKey: string;
  layer: 1 | 2 | null;
  policyCode: string | null;
  certainty: string | null;
  confidence: string | null;
  failOpen: boolean;
  method: string;
  /** Present when decision is chain_mismatch. */
  signedChainId?: number;
}

export function ensureDecisionLogDir(path: string | undefined): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
}

/** Append one JSON object and a newline. No-op when path is unset. Never throws. */
export function appendDecisionLog(
  path: string | undefined,
  record: DecisionLogRecord
): void {
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[l2-send-guard] decision log write failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
