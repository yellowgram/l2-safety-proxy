import type { ChainConfig } from "../types/index.js";

/**
 * Built-in chain templates (URLs come from env — never hardcode secrets).
 * Multi-ecosystem from day one: Arbitrum + OP Stack / Base.
 */
export const CHAIN_TEMPLATES: Record<
  string,
  Omit<ChainConfig, "upstreamRpcUrl">
> = {
  "arb-sepolia": {
    id: "arb-sepolia",
    name: "Arbitrum Sepolia",
    chainId: 421614,
    preferSimulateV1: true,
    ecosystem: "arbitrum",
  },
  "op-sepolia": {
    id: "op-sepolia",
    name: "OP Sepolia",
    chainId: 11155420,
    preferSimulateV1: true,
    ecosystem: "op-stack",
  },
  "base-sepolia": {
    id: "base-sepolia",
    name: "Base Sepolia",
    chainId: 84532,
    preferSimulateV1: true,
    ecosystem: "base",
  },
  // Mainnets: no public default RPC; set L2SG_RPC_<KEY> (e.g. L2SG_RPC_BASE).
  ethereum: { id: "ethereum", name: "Ethereum", chainId: 1, preferSimulateV1: true, ecosystem: "other" },
  arbitrum: { id: "arbitrum", name: "Arbitrum One", chainId: 42161, preferSimulateV1: true, ecosystem: "arbitrum" },
  optimism: { id: "optimism", name: "OP Mainnet", chainId: 10, preferSimulateV1: true, ecosystem: "op-stack" },
  base: { id: "base", name: "Base", chainId: 8453, preferSimulateV1: true, ecosystem: "base" },
  sepolia: { id: "sepolia", name: "Sepolia", chainId: 11155111, preferSimulateV1: true, ecosystem: "other" },
};

/** Public testnet RPC fallbacks (no API key). Prefer env overrides. */
export const PUBLIC_RPC_DEFAULTS: Record<string, string> = {
  "arb-sepolia": "https://sepolia-rollup.arbitrum.io/rpc",
  "op-sepolia": "https://sepolia.optimism.io",
  "base-sepolia": "https://sepolia.base.org",
};
