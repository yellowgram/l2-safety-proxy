import { readFileSync } from "node:fs";
import { getAddress, parseEther } from "viem";
import {
  defaultSpendPolicy,
  type DestinationPolicy,
  type SpendPolicyConfig,
} from "./types.js";

function env(key: string, fallback?: string): string | undefined {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  return fallback;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function normKey(addr: string): string {
  try {
    return getAddress(addr).toLowerCase();
  } catch {
    return addr.toLowerCase();
  }
}

function parseWei(
  wei?: string | number | null,
  eth?: string | number | null,
  label = "cap"
): bigint | undefined {
  const hasWei = wei !== undefined && wei !== null && `${wei}` !== "";
  const hasEth = eth !== undefined && eth !== null && `${eth}` !== "";
  if (hasWei && hasEth) {
    throw new Error(
      `Layer 2 policy: set only one of ${label} Wei / Eth, not both`
    );
  }
  if (hasWei) return BigInt(`${wei}`);
  if (hasEth) return parseEther(`${eth}`);
  return undefined;
}

function parseDestinations(
  raw: Record<string, { maxNativeWei?: string; maxNativeEth?: string | number; requireApproval?: boolean }> | undefined
): Map<string, DestinationPolicy> {
  const map = new Map<string, DestinationPolicy>();
  if (!raw) return map;
  for (const [addr, entry] of Object.entries(raw)) {
    const key = normKey(addr);
    const maxNativeWei = parseWei(
      entry?.maxNativeWei,
      entry?.maxNativeEth,
      `destinations[${addr}]`
    );
    map.set(key, {
      ...(maxNativeWei !== undefined ? { maxNativeWei } : {}),
      ...(entry?.requireApproval ? { requireApproval: true } : {}),
    });
  }
  return map;
}

interface PolicyFileJson {
  enabled?: boolean;
  allowContractCreation?: boolean;
  allowAnyDestination?: boolean;
  globalMaxNativeWei?: string;
  globalMaxNativeEth?: string | number;
  destinations?: Record<
    string,
    { maxNativeWei?: string; maxNativeEth?: string | number; requireApproval?: boolean }
  >;
  chains?: Record<
    string,
    {
      allowContractCreation?: boolean;
      allowAnyDestination?: boolean;
      globalMaxNativeWei?: string;
      globalMaxNativeEth?: string | number;
      destinations?: Record<
        string,
        { maxNativeWei?: string; maxNativeEth?: string | number; requireApproval?: boolean }
      >;
      erc20RecipientCheck?: boolean;
    }
  >;
  erc20RecipientCheck?: boolean;
  humanGate?: { mode?: string; notifyUrl?: string | null };
}

function loadFile(path: string): PolicyFileJson {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text) as PolicyFileJson;
}

/**
 * Load Layer 2 policy from optional JSON file + env overrides.
 * Default: disabled (Layer 1 only).
 */
export function loadSpendPolicy(): SpendPolicyConfig {
  const policy = defaultSpendPolicy();
  const filePath = env("L2SG_POLICY_FILE");

  if (filePath) {
    let file: PolicyFileJson;
    try {
      file = loadFile(filePath);
    } catch (err) {
      throw new Error(
        `Failed to load L2SG_POLICY_FILE=${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (file.enabled === true) policy.enabled = true;
    if (file.enabled === false) policy.enabled = false;
    if (file.allowContractCreation !== undefined) {
      policy.allowContractCreation = !!file.allowContractCreation;
    }
    if (file.allowAnyDestination !== undefined) {
      policy.allowAnyDestination = !!file.allowAnyDestination;
    }
    if (file.erc20RecipientCheck !== undefined) {
      policy.erc20RecipientCheck = !!file.erc20RecipientCheck;
    }
    const g = parseWei(file.globalMaxNativeWei, file.globalMaxNativeEth, "globalMaxNative");
    if (g !== undefined) policy.globalMaxNativeWei = g;
    policy.destinations = parseDestinations(file.destinations);
    if (file.chains) {
      for (const [key, overlay] of Object.entries(file.chains)) {
        const overlayGlobal = parseWei(
          overlay.globalMaxNativeWei,
          overlay.globalMaxNativeEth,
          `chains[${key}].globalMaxNative`
        );
        policy.chains[key] = {
          ...(overlay.allowContractCreation !== undefined
            ? { allowContractCreation: !!overlay.allowContractCreation }
            : {}),
          ...(overlay.allowAnyDestination !== undefined
            ? { allowAnyDestination: !!overlay.allowAnyDestination }
            : {}),
          ...(overlay.erc20RecipientCheck !== undefined
            ? { erc20RecipientCheck: !!overlay.erc20RecipientCheck }
            : {}),
          ...(overlayGlobal !== undefined
            ? { globalMaxNativeWei: overlayGlobal }
            : {}),
          destinations: parseDestinations(overlay.destinations),
        };
      }
    }
    if (file.humanGate?.notifyUrl) {
      policy.humanGate = { mode: "stop", notifyUrl: file.humanGate.notifyUrl };
    }
  }

  // Env overrides
  if (process.env.L2SG_POLICY_ENABLED !== undefined && process.env.L2SG_POLICY_ENABLED !== "") {
    policy.enabled = boolEnv("L2SG_POLICY_ENABLED", false);
  }
  if (process.env.L2SG_POLICY_ALLOW_CREATE !== undefined) {
    policy.allowContractCreation = boolEnv("L2SG_POLICY_ALLOW_CREATE", false);
  }
  if (process.env.L2SG_POLICY_ALLOW_ANY !== undefined) {
    policy.allowAnyDestination = boolEnv("L2SG_POLICY_ALLOW_ANY", false);
  }
  if (process.env.L2SG_POLICY_ERC20_RECIPIENT_CHECK !== undefined) {
    policy.erc20RecipientCheck = boolEnv("L2SG_POLICY_ERC20_RECIPIENT_CHECK", true);
  }
  const envGlobal = env("L2SG_POLICY_GLOBAL_MAX_WEI");
  if (envGlobal) policy.globalMaxNativeWei = BigInt(envGlobal);
  const envEth = env("L2SG_POLICY_GLOBAL_MAX_ETH");
  if (envEth) {
    if (envGlobal) {
      throw new Error("Set only one of L2SG_POLICY_GLOBAL_MAX_WEI / L2SG_POLICY_GLOBAL_MAX_ETH");
    }
    policy.globalMaxNativeWei = parseEther(envEth);
  }
  const allowlist = env("L2SG_POLICY_ALLOWLIST");
  if (allowlist) {
    for (const part of allowlist.split(",")) {
      const a = part.trim();
      if (!a) continue;
      const key = normKey(a);
      if (!policy.destinations.has(key)) {
        policy.destinations.set(key, {});
      }
    }
  }
  const notify = env("L2SG_POLICY_NOTIFY_URL");
  if (notify) {
    policy.humanGate = { mode: "stop", notifyUrl: notify };
  }

  // Presence of file with enabled, or allowlist/env enable, activates.
  // If file path set but enabled never true and env not set → stay false unless file said true.
  return policy;
}
