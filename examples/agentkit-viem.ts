/**
 * AgentKit / viem drop-in — point eth_sendRawTransaction at L2 Send Guard.
 *
 * This file is an **example** (not compiled into the package).
 * It does **not** import `@coinbase/agentkit` — wire the same transport into
 * whatever wallet/agent stack you use (AgentKit CDP wallet, viem WalletClient, etc.).
 *
 * Prereq: `npm start` (or docker) with optional Layer 2:
 *   L2SG_POLICY_ENABLED=true L2SG_POLICY_FILE=./policy.agent.example.json
 *
 * Run conceptually:
 *   npx tsx examples/agentkit-viem.ts
 * (Requires DEMO_PRIVATE_KEY in env for a live send — omit for dry compile check.)
 *
 * Halt / no-rebroadcast behavior is the offline sample `examples/agent-viem-halt.mjs`.
 * Decision table: docs/AGENT_DECISION_TABLE.md.
 * Policy ON is not a safe agent: docs/RESIDUAL_BYPASSES.md.
 */

import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  viemHttpArgs,
  createGuardFetch,
  isDefiniteRevertError,
  isPolicyDeniedError,
  classifyGuardError,
} from "l2-send-guard/sdk";

const PROXY = process.env.L2SG_PROXY_URL ?? "http://127.0.0.1:8545";

/** Preferred: spread into viem `http()`. */
export function guardTransport(chainKey = "base-sepolia") {
  return http(...viemHttpArgs({ proxyUrl: PROXY, chain: chainKey }));
}

/** Alternate: custom fetch (useful when AgentKit takes a fetch/rpcUrl pair). */
export function guardFetch(chainKey = "base-sepolia") {
  return createGuardFetch({ proxyUrl: PROXY, chain: chainKey });
}

/**
 * AgentKit tip (pseudo — adapt to current AgentKit wallet provider API):
 *
 *   // When constructing a ViemWallet or custom RPC action provider,
 *   // pass the Guard URL instead of the raw Alchemy/Base RPC:
 *   const rpcUrl = process.env.L2SG_PROXY_URL ?? "http://127.0.0.1:8545";
 *   // Ensure requests include header x-l2sg-chain (via viemHttpArgs / createGuardFetch).
 *   // CDP Policy Engine (hosted allowlist/ethValue) is complementary — Guard adds
 *   // Layer 1 definite-revert simulation + self-hosted Layer 2. See docs/COMPETITIVE.md.
 */

async function main() {
  const key = process.env.DEMO_PRIVATE_KEY as Hex | undefined;
  if (!key) {
    console.log(
      "No DEMO_PRIVATE_KEY — printing transport wiring only.\n",
      "viemHttpArgs →",
      viemHttpArgs({ proxyUrl: PROXY, chain: "base-sepolia" })
    );
    return;
  }

  const client = createWalletClient({
    account: privateKeyToAccount(key),
    chain: baseSepolia,
    transport: guardTransport("base-sepolia"),
  });

  try {
    // Example: would hit Layer 1 (-32080) on known revert, or Layer 2 (-32083)
    // if policy is on and destination is not allowlisted.
    const hash = await client.sendTransaction({
      to: "0x0000000000000000000000000000000000000001",
      value: 0n,
      data: "0xdeadbeef",
    });
    console.log("forwarded txHash", hash);
  } catch (err) {
    const kind = classifyGuardError(err);
    console.error("guard classified:", kind);
    if (isDefiniteRevertError(err)) {
      console.error("Layer 1 definite revert (-32080) — do not retry same calldata");
    } else if (isPolicyDeniedError(err)) {
      console.error("Layer 2 policy_denied (-32083) — update allowlist/caps; never fail-open");
    } else {
      throw err;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
