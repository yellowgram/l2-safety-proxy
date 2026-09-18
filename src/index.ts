#!/usr/bin/env node
/**
 * L2 Send Guard — multi-L2 pre-broadcast JSON-RPC safety middleware.
 * Drop-in in front of an existing RPC. Never custodies private keys.
 */
import { loadConfig } from "./config/env.js";
import { listen } from "./proxy/server.js";

function main(): void {
  const config = loadConfig();
  listen(config);
}

main();
