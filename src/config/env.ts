import {
  CHAIN_TEMPLATES,
  PUBLIC_RPC_DEFAULTS,
} from "./chains.js";
import type { ChainConfig, GuardConfig } from "../types/index.js";

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

function buildChain(key: string): ChainConfig | null {
  const tmpl = CHAIN_TEMPLATES[key];
  if (!tmpl) return null;
  const urlKey = `L2SG_RPC_${key.toUpperCase().replace(/-/g, "_")}`;
  const upstreamRpcUrl =
    env(urlKey) ?? PUBLIC_RPC_DEFAULTS[key] ?? "";
  if (!upstreamRpcUrl) return null;
  return { ...tmpl, upstreamRpcUrl };
}

/**
 * Load config from environment.
 * Enable chains via L2SG_CHAINS=arb-sepolia,base-sepolia (default both).
 */
export function loadConfig(): GuardConfig {
  const listenHost = env("L2SG_HOST", "127.0.0.1")!;
  const listenPort = Number(env("L2SG_PORT", "8545"));
  const failOpen = boolEnv("L2SG_FAIL_OPEN", true);
  const chainKeys = (env("L2SG_CHAINS", "arb-sepolia,base-sepolia")!)
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

  return {
    listenHost,
    listenPort,
    chains,
    defaultChain,
    failOpen,
  };
}
