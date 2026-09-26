import type { SpendPolicyConfig } from "./types.js";

/**
 * Placeholder destinations shipped in policy.*.example.json.
 * A repeated non-zero nibble (0x1111…, 0x2222…, 0xaaaa…) is poison.
 * The all-zero address is not poison — it is not the template placeholder.
 */
export function isPoisonAddress(addr: string): boolean {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) return false;
  const nibble = hex[0]!;
  if (nibble === "0") return false;
  for (let i = 1; i < hex.length; i++) {
    if (hex[i] !== nibble) return false;
  }
  return true;
}

export function listPoisonAddresses(policy: SpendPolicyConfig): string[] {
  const found: string[] = [];
  const scan = (map?: Map<string, unknown>) => {
    if (!map) return;
    for (const addr of map.keys()) {
      if (isPoisonAddress(addr)) found.push(addr.toLowerCase());
    }
  };
  scan(policy.destinations);
  for (const overlay of Object.values(policy.chains)) {
    scan(overlay.destinations);
  }
  return found;
}

const TOP_LEVEL_KEYS = new Set([
  "enabled",
  "allowContractCreation",
  "allowAnyDestination",
  "globalMaxNativeWei",
  "globalMaxNativeEth",
  "destinations",
  "chains",
  "erc20RecipientCheck",
  "humanGate",
]);

const DEST_KEYS = new Set(["maxNativeWei", "maxNativeEth", "requireApproval"]);

const CHAIN_KEYS = new Set([
  "allowContractCreation",
  "allowAnyDestination",
  "globalMaxNativeWei",
  "globalMaxNativeEth",
  "destinations",
  "erc20RecipientCheck",
]);

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const WEI = /^(0|[1-9][0-9]*)$/;

export interface PolicyCheckReport {
  schemaErrors: string[];
  sanityErrors: string[];
  poisons: string[];
  enabled: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKeys(
  errors: string[],
  obj: Record<string, unknown>,
  allowed: Set<string>,
  path: string
): void {
  for (const key of Object.keys(obj)) {
    if (key.startsWith("_")) continue;
    if (!allowed.has(key)) errors.push(`${path}unknown key ${key}`);
  }
}

function checkBool(
  errors: string[],
  obj: Record<string, unknown>,
  key: string,
  path: string
): void {
  if (obj[key] !== undefined && typeof obj[key] !== "boolean") {
    errors.push(`${path}${key} must be a boolean`);
  }
}

function checkCapPair(
  errors: string[],
  obj: Record<string, unknown>,
  weiKey: string,
  ethKey: string,
  path: string
): void {
  const wei = obj[weiKey];
  const eth = obj[ethKey];
  const hasWei = wei !== undefined && wei !== null && `${wei}` !== "";
  const hasEth = eth !== undefined && eth !== null && `${eth}` !== "";
  if (hasWei && hasEth) {
    errors.push(`${path}set only one of ${weiKey} / ${ethKey}`);
  }
  if (hasWei) {
    if (typeof wei === "number") {
      if (!Number.isSafeInteger(wei) || wei < 0) {
        errors.push(`${path}${weiKey} number must be a non-negative safe integer (use a string for larger wei)`);
      }
    } else if (typeof wei !== "string" || !WEI.test(wei)) {
      errors.push(`${path}${weiKey} must be a base-10 integer string`);
    }
  }
  if (hasEth) {
    if (typeof eth !== "string" && typeof eth !== "number") {
      errors.push(`${path}${ethKey} must be a number or numeric string`);
    } else if (!Number.isFinite(Number(eth)) || Number(eth) < 0) {
      errors.push(`${path}${ethKey} must be a non-negative amount`);
    }
  }
}

function checkDestinations(
  errors: string[],
  raw: unknown,
  path: string,
  poisons: string[]
): void {
  if (!isPlainObject(raw)) {
    errors.push(`${path}destinations must be an object`);
    return;
  }
  for (const [addr, entry] of Object.entries(raw)) {
    if (!ADDR.test(addr)) {
      errors.push(`${path}destinations[${addr}] is not a 0x + 40 hex address`);
      continue;
    }
    if (isPoisonAddress(addr)) poisons.push(addr.toLowerCase());
    if (!isPlainObject(entry)) {
      errors.push(`${path}destinations[${addr}] must be an object`);
      continue;
    }
    unknownKeys(errors, entry, DEST_KEYS, `${path}destinations[${addr}].`);
    checkCapPair(errors, entry, "maxNativeWei", "maxNativeEth", `${path}destinations[${addr}].`);
    if (
      entry.requireApproval !== undefined &&
      typeof entry.requireApproval !== "boolean"
    ) {
      errors.push(`${path}destinations[${addr}].requireApproval must be a boolean`);
    }
  }
}

function checkChainOverlay(
  errors: string[],
  raw: unknown,
  path: string,
  poisons: string[]
): void {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return;
  }
  unknownKeys(errors, raw, CHAIN_KEYS, path);
  checkBool(errors, raw, "allowContractCreation", path);
  checkBool(errors, raw, "allowAnyDestination", path);
  checkBool(errors, raw, "erc20RecipientCheck", path);
  checkCapPair(errors, raw, "globalMaxNativeWei", "globalMaxNativeEth", path);
  if (raw.destinations !== undefined) {
    checkDestinations(errors, raw.destinations, path, poisons);
  }
}

/**
 * Schema + poison + fence sanity for a policy JSON document.
 * Does not read the environment and does not throw.
 */
export function checkPolicyDocument(json: unknown): PolicyCheckReport {
  const schemaErrors: string[] = [];
  const sanityErrors: string[] = [];
  const poisons: string[] = [];

  if (!isPlainObject(json)) {
    return {
      schemaErrors: ["policy document must be a JSON object"],
      sanityErrors,
      poisons,
      enabled: false,
    };
  }

  unknownKeys(schemaErrors, json, TOP_LEVEL_KEYS, "");
  checkBool(schemaErrors, json, "enabled", "");
  checkBool(schemaErrors, json, "allowContractCreation", "");
  checkBool(schemaErrors, json, "allowAnyDestination", "");
  checkBool(schemaErrors, json, "erc20RecipientCheck", "");
  checkCapPair(schemaErrors, json, "globalMaxNativeWei", "globalMaxNativeEth", "");

  if (json.destinations !== undefined) {
    checkDestinations(schemaErrors, json.destinations, "", poisons);
  }
  if (json.chains !== undefined) {
    if (!isPlainObject(json.chains)) {
      schemaErrors.push("chains must be an object");
    } else {
      for (const [key, overlay] of Object.entries(json.chains)) {
        if (!key.trim()) schemaErrors.push("chains contains an empty key");
        checkChainOverlay(schemaErrors, overlay, `chains[${key}].`, poisons);
        if (isPlainObject(overlay) && overlay.allowAnyDestination === true) {
          sanityErrors.push(
            `chains[${key}].allowAnyDestination=true removes the destination fence`
          );
        }
      }
    }
  }

  if (json.humanGate !== undefined && json.humanGate !== null) {
    if (!isPlainObject(json.humanGate)) {
      schemaErrors.push("humanGate must be an object");
    } else {
      unknownKeys(
        schemaErrors,
        json.humanGate,
        new Set(["mode", "notifyUrl"]),
        "humanGate."
      );
      if (
        json.humanGate.mode !== undefined &&
        json.humanGate.mode !== "stop"
      ) {
        schemaErrors.push('humanGate.mode must be "stop" when set');
      }
      const url = json.humanGate.notifyUrl;
      if (url !== undefined && url !== null && typeof url !== "string") {
        schemaErrors.push("humanGate.notifyUrl must be a string or null");
      }
    }
  }

  const enabled = json.enabled === true;
  if (json.allowAnyDestination === true) {
    sanityErrors.push(
      "allowAnyDestination=true removes the destination fence; policy:check refuses it"
    );
  }

  return { schemaErrors, sanityErrors, poisons, enabled };
}

export function checkPolicyText(text: string): PolicyCheckReport {
  try {
    return checkPolicyDocument(JSON.parse(text) as unknown);
  } catch (err) {
    return {
      schemaErrors: [
        `invalid JSON (no comments): ${err instanceof Error ? err.message : String(err)}`,
      ],
      sanityErrors: [],
      poisons: [],
      enabled: false,
    };
  }
}

/** True when schema, sanity, and placeholder checks all pass. */
export function policyReportOk(report: PolicyCheckReport): boolean {
  return (
    report.schemaErrors.length === 0 &&
    report.sanityErrors.length === 0 &&
    report.poisons.length === 0
  );
}
