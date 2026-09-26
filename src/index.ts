#!/usr/bin/env node
/**
 * L2 Send Guard — multi-L2 pre-broadcast JSON-RPC safety middleware.
 * Drop-in in front of an existing RPC. Never custodies private keys.
 */
import { loadConfig } from "./config/env.js";
import { listen } from "./proxy/server.js";
import type { GuardConfig } from "./types/index.js";

function main(): void {
  let config: GuardConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(
      `[l2-send-guard] refusing to start: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
  listen(config);
}

main();
