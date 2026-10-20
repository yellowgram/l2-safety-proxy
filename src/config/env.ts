import {
  CHAIN_TEMPLATES,
  PUBLIC_RPC_DEFAULTS,
} from "./chains.js";
import type { GuardSpec, ChainConfig, GuardConfig, GuardMode } from "../types/index.js";
import { readFileSync } from "node:fs";
import { parseJsonText, parsePolicy, PolicyError } from "../guard/policy/load.js";
import type { Policy } from "../guard/policy/types.js";

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

/**
 * GUARD_ALLOW_ANY_SELECTOR=1 (alias L2SG_ALLOW_ANY_SELECTOR): the operator accepts "allowAnySelector": true in
 * the policy. Independent of GUARD_MODE. Anything other than a clear yes or no is an error.
 */
function allowAnySelectorAcknowledged(): boolean {
  const key = env("GUARD_ALLOW_ANY_SELECTOR") !== undefined ? "GUARD_ALLOW_ANY_SELECTOR" : "L2SG_ALLOW_ANY_SELECTOR";
  const raw = (env(key) ?? "").toLowerCase();
  if (raw === "") return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${key} must be 1 or 0 (got "${raw}")`);
}

function parseGuardMode(): GuardMode {
  const raw = (env("GUARD_MODE") ?? env("L2SG_GUARD_MODE") ?? "").toLowerCase();
  if (raw === "strict") return "strict";
  if (raw === "open") return "open";
  if (raw !== "") throw new Error(`GUARD_MODE must be strict or open (got "${raw}")`);
  // Legacy: L2SG_FAIL_OPEN=true → open. Default strict: a safety proxy fails closed.
  if (process.env.L2SG_FAIL_OPEN !== undefined && process.env.L2SG_FAIL_OPEN !== "") {
    return boolEnv("L2SG_FAIL_OPEN", false) ? "open" : "strict";
  }
  return "strict";
}

function buildChain(key: string): ChainConfig {
  const tmpl = CHAIN_TEMPLATES[key];
  if (!tmpl) throw new Error(`L2SG_CHAINS: unknown chain "${key}" (known: ${Object.keys(CHAIN_TEMPLATES).join(", ")})`);
  const slug = key.toUpperCase().replace(/-/g, "_");
  const urlKey = `L2SG_RPC_${slug}`;
  const fallbackKey = `L2SG_RPC_FALLBACK_${slug}`;
  const upstreamRpcUrl =
    env(urlKey) ?? PUBLIC_RPC_DEFAULTS[key] ?? "";
  if (!upstreamRpcUrl) throw new Error(`L2SG_CHAINS includes ${key}, which has no public default RPC. Set ${urlKey}.`);
  const fallbackRpcUrl = env(fallbackKey);
  return {
    ...tmpl,
    upstreamRpcUrl,
    ...(fallbackRpcUrl ? { fallbackRpcUrl } : {}),
  };
}

const LEGACY_POLICY_ENV = [
  "L2SG_POLICY_ENABLED",
  "L2SG_POLICY_ALLOW_CREATE",
  "L2SG_POLICY_ALLOW_ANY",
  "L2SG_POLICY_ERC20_RECIPIENT_CHECK",
  "L2SG_POLICY_GLOBAL_MAX_WEI",
  "L2SG_POLICY_GLOBAL_MAX_ETH",
  "L2SG_POLICY_ALLOWLIST",
  "L2SG_POLICY_NOTIFY_URL",
];

/** Keys only the 0.x policy format had. */
const LEGACY_POLICY_KEYS = ["enabled", "allowAnyDestination", "globalMaxNativeWei", "globalMaxNativeEth", "erc20RecipientCheck", "humanGate"];

export function readPolicyFile(path: string): Policy {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new PolicyError(`${path}: ${(err as Error).message}`);
  }
  const json = parseJsonText(text, path);
  if (json && typeof json === "object" && LEGACY_POLICY_KEYS.some((k) => k in (json as object))) {
    throw new PolicyError(
      `${path} is a 0.x policy file. Convert it with: l2-send-guard migrate-policy ${path} > policy.json (see README#migrating)`
    );
  }
  return parsePolicy(json, path);
}

export type StoreSpec = { kind: "memory" } | { kind: "file"; path: string } | { kind: "postgres"; url: string };

export function parseStoreSpec(raw: string | undefined): StoreSpec {
  const v = (raw ?? "file:./l2-send-guard-state.jsonl").trim();
  if (v === "memory") return { kind: "memory" };
  if (v.startsWith("file:")) return { kind: "file", path: v.slice(5) };
  if (/^postgres(ql)?:\/\//.test(v)) return { kind: "postgres", url: v };
  throw new Error(`L2SG_STORE must be memory, file:<path> or postgres://… (got "${v}")`);
}

/**
 * Load config from environment. Nothing here opens files or connections; see
 * createGuardFromConfig for that.
 * Chains: L2SG_CHAINS=arb-sepolia,op-sepolia,base-sepolia (default) or mainnets with L2SG_RPC_<KEY>.
 * GUARD_MODE=strict|open (default strict). Alias: L2SG_GUARD_MODE.
 * GUARD_ALLOW_ANY_SELECTOR=1 accepts "allowAnySelector": true in the policy (in either mode).
 * Policy: L2SG_POLICY_FILE=./policy.json, or L2SG_POLICY=off for simulation only.
 */
/** The chains from L2SG_CHAINS and L2SG_RPC_*, without reading the policy. */
export function loadChainsOnly(): Record<string, ChainConfig> {
  const keys = (env("L2SG_CHAINS", "arb-sepolia,op-sepolia,base-sepolia")!).split(",").map((s) => s.trim()).filter(Boolean);
  return Object.fromEntries(keys.map((k) => [k, buildChain(k)]));
}

export function loadConfig(): GuardConfig {
  const listenHost = env("L2SG_HOST", "127.0.0.1")!;
  const listenPort = Number(env("L2SG_PORT", "8545"));
  const guardMode = parseGuardMode();
  const failOpen = guardMode === "open";
  const chainKeys = (env("L2SG_CHAINS", "arb-sepolia,op-sepolia,base-sepolia")!)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const chains: Record<string, ChainConfig> = {};
  for (const key of chainKeys) chains[key] = buildChain(key);

  if (Object.keys(chains).length === 0) {
    throw new Error(
      "No chains configured. Set L2SG_CHAINS and optional L2SG_RPC_* URLs."
    );
  }

  const defaultChain =
    env("L2SG_DEFAULT_CHAIN") ?? Object.keys(chains)[0]!;

  if (!chains[defaultChain]) {
    throw new Error(
      `L2SG_DEFAULT_CHAIN=${defaultChain} not in configured chains`
    );
  }

  const legacy = LEGACY_POLICY_ENV.filter((k) => process.env[k] !== undefined && process.env[k] !== "");
  if (legacy.length > 0) {
    throw new Error(
      `${legacy.join(", ")} ${legacy.length === 1 ? "was" : "were"} removed in 1.0. Put the rules in a policy file (L2SG_POLICY_FILE); see README#migrating`
    );
  }
  const policyFile = env("L2SG_POLICY_FILE");
  const policyOff = (env("L2SG_POLICY") ?? "").toLowerCase() === "off";
  if (policyFile && policyOff) throw new Error("Set L2SG_POLICY_FILE or L2SG_POLICY=off, not both");
  const policy = policyFile ? readPolicyFile(policyFile) : undefined;
  if (policy) {
    // allowAnySelector lifts a destination's function list. The policy file alone can't do that: whoever runs the
    // proxy must acknowledge it separately, in either GUARD_MODE (open mode is about simulation, not this).
    const any = [...policy.destinations].filter(([, r]) => r.anySelector).map(([a]) => a);
    if (any.length > 0 && !allowAnySelectorAcknowledged()) {
      throw new PolicyError(
        `${policyFile}: "allowAnySelector": true on ${any.join(", ")}, so ANY function on ${any.length === 1 ? "it" : "them"} may be called. ` +
          'Refusing to start without an explicit acknowledgement: list the functions the agent may call in "selectors", ' +
          "or, if you mean it, set GUARD_ALLOW_ANY_SELECTOR=1 (any GUARD_MODE)"
      );
    }
  }
  const ttl = Number(env("L2SG_IDEMPOTENCY_TTL_SECONDS", "86400"));
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("L2SG_IDEMPOTENCY_TTL_SECONDS must be a positive integer");
  const bypass = (env("L2SG_BYPASS", "lock") ?? "lock").toLowerCase();
  if (!["lock", "alert", "off"].includes(bypass)) throw new Error("L2SG_BYPASS must be lock, alert or off");
  const decisionLogPath = env("L2SG_DECISION_LOG");
  const watch = parseWatch(policy !== undefined);

  return {
    listenHost,
    listenPort,
    chains,
    defaultChain,
    guardMode,
    failOpen,
    ...(policy
      ? {
          guardSpec: {
            policy,
            store: parseStoreSpec(env("L2SG_STORE")),
            idempotencyTtlSeconds: ttl,
            bypass: bypass as "lock" | "alert" | "off",
            ...(env("L2SG_ALERT_WEBHOOK") ? { alertWebhook: env("L2SG_ALERT_WEBHOOK")! } : {}),
            ...(watch ? { watch } : {}),
          },
        }
      : {}),
    policySource: policyFile ?? (policyOff ? "off" : undefined),
    ...(decisionLogPath ? { decisionLogPath } : {}),
  };
}

function addressList(name: string): string[] {
  const raw = env(name);
  if (!raw) return [];
  return raw.split(",").map((a) => a.trim()).filter(Boolean).map((a) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`${name}: not an address: ${a}`);
    return a.toLowerCase();
  });
}

/** L2SG_WATCH_AGENTS=0x…,0x… turns on the receive-side watch. It needs a policy. */
function parseWatch(hasPolicy: boolean): GuardSpec["watch"] {
  const agents = addressList("L2SG_WATCH_AGENTS");
  if (agents.length === 0) {
    for (const k of ["L2SG_WATCH_EXPECTED_SENDERS", "L2SG_WATCH_DUST_RAW", "L2SG_WATCH_INTERVAL_SECONDS"]) {
      if (env(k)) throw new Error(`${k} is set but L2SG_WATCH_AGENTS is not`);
    }
    return undefined;
  }
  if (!hasPolicy) throw new Error("L2SG_WATCH_AGENTS needs a policy file (the watch judges inbound funds against it)");
  const dust = env("L2SG_WATCH_DUST_RAW", "0")!;
  if (!/^(0|[1-9][0-9]*)$/.test(dust)) throw new Error("L2SG_WATCH_DUST_RAW must be a decimal integer in raw token units");
  const interval = Number(env("L2SG_WATCH_INTERVAL_SECONDS", "15"));
  if (!Number.isInteger(interval) || interval <= 0) throw new Error("L2SG_WATCH_INTERVAL_SECONDS must be a positive integer");
  return { agents, expectedSenders: addressList("L2SG_WATCH_EXPECTED_SENDERS"), dustRaw: BigInt(dust), intervalSeconds: interval };
}
