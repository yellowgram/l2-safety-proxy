import {
  CHAIN_TEMPLATES,
  PUBLIC_RPC_DEFAULTS,
} from "./chains.js";
import type { ChainConfig, GuardConfig, GuardMode } from "../types/index.js";
import { loadSpendPolicy } from "../policy/load.js";

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

function parseGuardMode(): GuardMode {
  const raw = (env("GUARD_MODE") ?? env("L2SG_GUARD_MODE") ?? "").toLowerCase();
  if (raw === "strict") return "strict";
  if (raw === "open") return "open";
  // Legacy: L2SG_FAIL_OPEN=false → strict; default open
  if (process.env.L2SG_FAIL_OPEN !== undefined && process.env.L2SG_FAIL_OPEN !== "") {
    return boolEnv("L2SG_FAIL_OPEN", true) ? "open" : "strict";
  }
  return "open";
}

function buildChain(key: string): ChainConfig | null {
  const tmpl = CHAIN_TEMPLATES[key];
  if (!tmpl) return null;
  const slug = key.toUpperCase().replace(/-/g, "_");
  const urlKey = `L2SG_RPC_${slug}`;
  const fallbackKey = `L2SG_RPC_FALLBACK_${slug}`;
  const upstreamRpcUrl =
    env(urlKey) ?? PUBLIC_RPC_DEFAULTS[key] ?? "";
  if (!upstreamRpcUrl) return null;
  const fallbackRpcUrl = env(fallbackKey);
  return {
    ...tmpl,
    upstreamRpcUrl,
    ...(fallbackRpcUrl ? { fallbackRpcUrl } : {}),
  };
}

/**
 * Load config from environment.
 * Enable chains via L2SG_CHAINS=arb-sepolia,op-sepolia,base-sepolia (default all three).
 * GUARD_MODE=open|strict (default open). Alias: L2SG_GUARD_MODE.
 */
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
  for (const key of chainKeys) {
    const c = buildChain(key);
    if (!c) {
      console.warn(`[l2-send-guard] skipping unknown/unconfigured chain: ${key}`);
      continue;
    }
    chains[key] = c;
  }

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

  const policy = loadSpendPolicy();

  return {
    listenHost,
    listenPort,
    chains,
    defaultChain,
    guardMode,
    failOpen,
    policy,
  };
}
