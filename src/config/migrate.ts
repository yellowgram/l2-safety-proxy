import { parseEther } from "viem";
import { parsePolicy } from "../guard/policy/load.js";

/** The file can't be converted without changing what it allows. Nothing is written. */
export class MigrateError extends Error {}

type Legacy = {
  enabled?: boolean;
  allowContractCreation?: boolean;
  allowAnyDestination?: boolean;
  globalMaxNativeWei?: string;
  globalMaxNativeEth?: string | number;
  destinations?: Record<string, { maxNativeWei?: string; maxNativeEth?: string | number; requireApproval?: boolean }>;
  chains?: Record<string, Omit<Legacy, "chains" | "humanGate" | "enabled">>;
  erc20RecipientCheck?: boolean;
  humanGate?: { mode?: string; notifyUrl?: string | null };
};

/** Every key a 0.x file could have. Anything else is refused rather than dropped. */
const LEGACY_TOP = ["enabled", "allowContractCreation", "allowAnyDestination", "globalMaxNativeWei", "globalMaxNativeEth", "destinations", "chains", "erc20RecipientCheck", "humanGate"];
const LEGACY_CHAIN = ["allowContractCreation", "allowAnyDestination", "globalMaxNativeWei", "globalMaxNativeEth", "destinations", "erc20RecipientCheck"];
const LEGACY_DESTINATION = ["maxNativeWei", "maxNativeEth", "requireApproval"];
const LEGACY_HUMAN_GATE = ["mode", "notifyUrl"];
/** Keys only the 1.x/2.0 format has. */
const CURRENT_ONLY = ["$schema", "window", "native", "tokens", "permit2", "delegation", "accounts", "universalRouter", "typedData"];
const CURRENT_DESTINATION = ["selectors", "allowAnySelector", "type", "note"];

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function object(v: unknown, where: string): Record<string, unknown> {
  if (v === undefined) return {};
  if (!isObj(v)) throw new MigrateError(`${where}: must be an object`);
  return v;
}

function onlyKeys(o: Record<string, unknown>, keys: string[], where: string) {
  const unknown = Object.keys(o).filter((k) => !keys.includes(k));
  if (unknown.length > 0) {
    throw new MigrateError(
      `${where}: unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} (a 0.x file has only: ${keys.join(", ")}). ` +
        "Nothing was converted: a setting the converter doesn't know could be a limit. Remove or translate it by hand"
    );
  }
}

function wei(w: unknown, e: unknown, where: string): string | undefined {
  try {
    if (w !== undefined && `${w}` !== "") return BigInt(w as string).toString();
    if (e !== undefined && `${e}` !== "") return parseEther(`${e}`).toString();
  } catch {
    throw new MigrateError(`${where}: not an amount: ${JSON.stringify(w ?? e)}`);
  }
  return undefined;
}

/** A 1.x/2.0 file rather than 0.x: it has a key or destination field only the newer format has. */
function isCurrentFormat(o: Record<string, unknown>): boolean {
  if (CURRENT_ONLY.some((k) => k in o) || Array.isArray(o.chains)) return true;
  return isObj(o.destinations) && Object.values(o.destinations).some((d) => isObj(d) && CURRENT_DESTINATION.some((k) => k in d));
}

/**
 * Convert a policy file to the 2.0 format, never widening access. Returns the new policy and notes
 * (printed to stderr by the CLI).
 *
 * - A 1.x file is carried over as is: every cap, token, account and recipient. A destination without
 *   a "selectors" list (which 1.x read as "any function") becomes "type": "eoa", plain ETH only.
 * - A 0.x file is converted. Its per-chain caps become the lowest one; a destination that only a
 *   chain overlay allowed can't be expressed in one policy for every chain, so the file is refused.
 *
 * Unknown keys are refused, never dropped. Throws MigrateError, or PolicyError if the result
 * doesn't validate.
 */
export function migrateLegacyPolicy(input: unknown): { policy: Record<string, unknown>; notes: string[] } {
  const root = object(input, "policy");
  const out = isCurrentFormat(root) ? migrateCurrent(root) : migrateZero(root);
  parsePolicy(out.policy, "migrated policy");
  return out;
}

function migrateCurrent(root: Record<string, unknown>): { policy: Record<string, unknown>; notes: string[] } {
  const legacy = Object.keys(root).filter((k) => LEGACY_TOP.includes(k) && k !== "destinations" && k !== "chains" && k !== "allowContractCreation");
  if (legacy.length > 0) {
    throw new MigrateError(`policy: mixes 0.x keys (${legacy.join(", ")}) with the 1.x/2.0 format. Convert one or the other by hand`);
  }
  const policy = structuredClone(root);
  const notes: string[] = [];
  const valueOnly: string[] = [];
  for (const [a, d] of Object.entries(object(policy.destinations, "policy.destinations"))) {
    const rule = object(d, `policy.destinations.${a}`);
    if (rule.selectors === undefined && rule.allowAnySelector === undefined && rule.type === undefined) {
      rule.type = "eoa";
      valueOnly.push(a);
    }
  }
  if (valueOnly.length > 0) {
    notes.push(
      `${valueOnly.join(", ")}: no "selectors" list, which 1.x read as "any function". Written as "type": "eoa" (plain ETH transfers only). ` +
        'For a contract the agent calls, replace that with a "selectors" list (or "allowAnySelector": true to keep the 1.x behaviour, with a warning)'
    );
  } else {
    notes.push("already in the 2.0 format; nothing changed");
  }
  return { policy, notes };
}

function migrateZero(root: Record<string, unknown>): { policy: Record<string, unknown>; notes: string[] } {
  onlyKeys(root, LEGACY_TOP, "policy");
  for (const [a, d] of Object.entries(object(root.destinations, "policy.destinations"))) onlyKeys(object(d, `destinations.${a}`), LEGACY_DESTINATION, `destinations.${a}`);
  onlyKeys(object(root.humanGate, "humanGate"), LEGACY_HUMAN_GATE, "humanGate");
  const base = new Set(Object.keys(object(root.destinations, "destinations")).map((a) => a.toLowerCase()));
  for (const [c, o] of Object.entries(object(root.chains, "chains"))) {
    const overlay = object(o, `chains.${c}`);
    onlyKeys(overlay, LEGACY_CHAIN, `chains.${c}`);
    for (const [a, d] of Object.entries(object(overlay.destinations, `chains.${c}.destinations`))) {
      const rule = object(d, `chains.${c}.destinations.${a}`);
      onlyKeys(rule, LEGACY_DESTINATION, `chains.${c}.destinations.${a}`);
      if (!base.has(a.toLowerCase()) && !rule.requireApproval) {
        throw new MigrateError(
          `chains.${c}.destinations.${a}: only chain "${c}" allows this destination, and a 2.0 policy applies to every chain it covers, so it can't be carried over without allowing it everywhere. ` +
            `Write one policy per chain (one proxy each, with "chains" set), or move it to the top-level destinations if every chain may send there`
        );
      }
    }
  }
  return convertZero(root as Legacy);
}

/**
 * Convert a checked 0.x file. Review the result: 2.0 is stricter, and token rules have to be
 * written by hand.
 */
function convertZero(old: Legacy): { policy: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  if (old.enabled === false) notes.push("the old file had enabled=false; in 2.0 a policy file is always enforced (use L2SG_POLICY=off for simulation only)");
  if (old.allowAnyDestination) notes.push("allowAnyDestination has no 2.0 equivalent: list the destinations you send to");
  if (old.humanGate?.notifyUrl) notes.push("humanGate.notifyUrl: set L2SG_ALERT_WEBHOOK (bypass alerts); denials are in the decision log");
  if (old.humanGate?.mode && old.humanGate.mode !== "stop") notes.push(`humanGate.mode=${old.humanGate.mode} is gone; denials always stop`);

  const destinations: Record<string, { maxNativeWei?: string; type?: "eoa"; note?: string }> = {};
  // 0.x refused sends to requireApproval destinations, so 2.0 must not allow them. If any listing
  // (base or a chain overlay) required approval, the address is left out entirely.
  const held = new Set<string>();
  const add = (src: Legacy["destinations"], where: string) => {
    for (const [a, d] of Object.entries(src ?? {})) {
      const key = a.toLowerCase();
      if (d?.requireApproval || held.has(key)) {
        if (d?.requireApproval) notes.push(`${where}${a}: requireApproval has no 2.0 equivalent; left out, so sends to it are still refused`);
        held.add(key);
        delete destinations[key];
        continue;
      }
      const cap = wei(d?.maxNativeWei, d?.maxNativeEth, `${where}destinations.${a}`);
      const prev = destinations[key];
      if (prev && prev.maxNativeWei !== cap) {
        notes.push(`${a} has different caps per chain; kept the lower one`);
        const lower = [prev.maxNativeWei, cap].filter((x): x is string => x !== undefined).map(BigInt).sort((x, y) => (x < y ? -1 : 1))[0];
        destinations[key] = lower !== undefined ? { maxNativeWei: lower.toString(), type: "eoa" } : { type: "eoa" };
        continue;
      }
      destinations[key] = cap !== undefined ? { maxNativeWei: cap, type: "eoa" } : { type: "eoa" };
    }
  };
  add(old.destinations, "");
  let allowCreate = old.allowContractCreation === true;
  let maxPerTx = wei(old.globalMaxNativeWei, old.globalMaxNativeEth, "globalMaxNative");
  for (const [chainKey, o] of Object.entries(old.chains ?? {})) {
    notes.push(`chains.${chainKey}: per-chain overlays are merged into one policy, keeping the lowest caps (2.0 has one policy per process; use "chains" to restrict chain ids)`);
    add(o.destinations, `chains.${chainKey}.`);
    if (o.allowContractCreation === true && !allowCreate) {
      notes.push(`chains.${chainKey}.allowContractCreation: only that chain allowed it; the merged policy denies contract creation (set allowContractCreation yourself if you need it)`);
    }
    if (o.allowContractCreation === false && allowCreate) {
      allowCreate = false;
      notes.push(`chains.${chainKey}.allowContractCreation=false: the merged policy denies contract creation everywhere`);
    }
    if (o.allowAnyDestination) notes.push(`chains.${chainKey}.allowAnyDestination has no 2.0 equivalent`);
    const c = wei(o.globalMaxNativeWei, o.globalMaxNativeEth, `chains.${chainKey}.globalMaxNative`);
    if (c !== undefined) maxPerTx = maxPerTx === undefined || BigInt(c) < BigInt(maxPerTx) ? c : maxPerTx;
  }
  if (Object.keys(destinations).length > 0) {
    notes.push(
      'destinations are written as "type": "eoa" (plain ETH transfers only). For a contract you call, replace it with a "selectors" list of the functions the agent may call'
    );
  }
  if (old.erc20RecipientCheck !== false) {
    notes.push('ERC-20 transfers now need a "tokens" entry per token (recipients and caps); none were generated');
  }
  const policy: Record<string, unknown> = {
    destinations,
    ...(maxPerTx !== undefined ? { native: { maxPerTxWei: maxPerTx } } : {}),
    ...(allowCreate ? { allowContractCreation: true } : {}),
    delegation: { mode: "deny" },
  };
  return { policy, notes };
}
