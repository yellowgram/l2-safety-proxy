#!/usr/bin/env node
/**
 * l2-send-guard: a JSON-RPC proxy that checks signed transactions against a policy and a
 * simulation before they reach your RPC. It never holds keys.
 *
 *   l2-send-guard [serve]                      start the proxy (env: see README)
 *   l2-send-guard check-policy <file>          validate a policy file and summarize it
 *   l2-send-guard migrate-policy <old file>    print the 2.0 form of a 0.x or 1.x policy file
 *   l2-send-guard unlock <address> --chain <id> clear a bypass lock (uses L2SG_STORE)
 */
import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { loadChainsOnly, loadConfig, parseStoreSpec, readPolicyFile } from "./config/env.js";
import { createGuardFromConfig, openStore, rpcReader, startWatch } from "./config/guard.js";
import { MigrateError, migrateLegacyPolicy } from "./config/migrate.js";
import { Guard } from "./guard/guard.js";
import { parseJsonText, parsePolicy, PolicyError, selectorWarnings } from "./guard/policy/load.js";
import type { Policy } from "./guard/policy/types.js";
import { listen } from "./proxy/server.js";
import { PACKAGE_VERSION } from "./version.js";

const USAGE = `l2-send-guard ${PACKAGE_VERSION}
usage:
  l2-send-guard [serve]                         start the proxy
  l2-send-guard check-policy <file>             validate a policy file and summarize it
  l2-send-guard migrate-policy <old-file>       print the 2.0 form of a 0.x or 1.x policy file
  l2-send-guard unlock <address> --chain <id>   clear a bypass lock in L2SG_STORE`;

function die(msg: string): never {
  console.error(`[l2-send-guard] ${msg}`);
  process.exit(1);
}

const anyCount = (p: Policy) => [...p.destinations.values()].filter((r) => r.anySelector).length;

export function summarizePolicy(p: Policy): { summary: string[]; warnings: string[] } {
  const summary = [
    `chains: ${p.chains.size ? [...p.chains].join(", ") : "any"}`,
    `destinations: ${p.destinations.size}${anyCount(p) ? ` (${anyCount(p)} with allowAnySelector)` : ""}`,
    `tokens: ${p.tokens.size}`,
    `native: per tx ${p.native.maxPerTxWei ?? "no cap"} wei, per ${p.windowSeconds}s ${p.native.windowMaxWei ?? "no cap"} wei`,
    `7702 delegation: ${p.delegation.mode}${p.delegation.mode === "allowlist" ? ` (${p.delegation.delegates.size})` : ""}`,
    `contract creation: ${p.allowContractCreation ? "allowed" : "denied"}`,
  ];
  // The loud ones first: explicit opt-outs from a destination's function list.
  const warnings: string[] = selectorWarnings(p);
  if (p.destinations.size === 0 && p.tokens.size === 0) warnings.push("no destinations or tokens: every send will be denied");
  if (p.native.maxPerTxWei === undefined && p.native.windowMaxWei === undefined) warnings.push("no native caps: allowed destinations can receive any amount");
  for (const [t, r] of p.tokens) {
    if (r.transfer.maxAmountRaw === undefined && r.windowMaxAmountRaw === undefined && r.transfer.recipients.size > 0) {
      warnings.push(`token ${t}: transfers have no per-tx or rolling cap`);
    }
  }
  for (const t of p.tokens.keys()) {
    const d = p.destinations.get(t);
    if (d?.anySelector) warnings.push(`token ${t} is also a destination with "allowAnySelector": true: functions the guard doesn't decode (e.g. transferWithAuthorization) are allowed on it`);
  }
  if (p.typedData.allowUnknown) warnings.push("typedData.allowUnknown: the guarded signer will sign typed data it can't check");
  return { summary, warnings };
}

async function main(argv: string[]): Promise<void> {
  const [cmd = "serve", ...rest] = argv;
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(USAGE);
    return;
  }
  if (cmd === "-v" || cmd === "--version") {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (cmd === "check-policy") {
    if (rest.length !== 1) die(USAGE);
    let p: Policy;
    try {
      p = readPolicyFile(rest[0]!);
    } catch (err) {
      die((err as Error).message);
    }
    const { summary, warnings } = summarizePolicy(p);
    console.log(`${rest[0]}: valid\n  ${summary.join("\n  ")}`);
    for (const w of warnings) console.log(`  ${w.includes("allowAnySelector") ? "WARNING" : "warning"}: ${w}`);
    return;
  }
  if (cmd === "migrate-policy") {
    if (rest.length !== 1) die(USAGE);
    let converted: ReturnType<typeof migrateLegacyPolicy>;
    try {
      converted = migrateLegacyPolicy(parseJsonText(readFileSync(rest[0]!, "utf8"), rest[0]!));
    } catch (err) {
      if (err instanceof MigrateError || err instanceof PolicyError) die(`${rest[0]}: not converted: ${err.message}`);
      throw err;
    }
    const { policy, notes } = converted;
    console.log(JSON.stringify(policy, null, 2));
    for (const n of notes) console.error(`note: ${n}`);
    return;
  }
  if (cmd === "unlock") {
    const at = rest.indexOf("--chain");
    const chain = at === -1 ? NaN : Number(rest[at + 1]);
    const address = rest.find((a, i) => i !== at && i !== at + 1);
    if (!address || !Number.isInteger(chain)) die(USAGE);
    // Unlocking resets the sender's baseline to its current on-chain nonce, so it needs the chain's RPC.
    let rpc: string | undefined;
    try {
      rpc = Object.values(loadChainsOnly()).find((c) => c.chainId === chain)?.upstreamRpcUrl;
    } catch (err) {
      die((err as Error).message);
    }
    if (!rpc) die(`chain ${chain} is not in L2SG_CHAINS; unlock reads the sender's nonce from that chain's RPC`);
    let store;
    try {
      store = await openStore(parseStoreSpec(process.env.L2SG_STORE));
    } catch (err) {
      die(`${(err as Error).message}. With the file store, stop the proxy before unlocking.`);
    }
    const guard = new Guard({ policy: parsePolicy({}), store, readers: new Map([[chain, rpcReader(rpc)]]) });
    await guard.unlock(chain, getAddress(address));
    await store.close();
    console.log(`unlocked ${getAddress(address)} on chain ${chain}`);
    return;
  }
  if (cmd !== "serve") die(USAGE);

  let config;
  try {
    config = loadConfig();
    if (!config.guardSpec && config.policySource !== "off") {
      throw new Error("no policy. Set L2SG_POLICY_FILE=./policy.json (see policy.example.json), or L2SG_POLICY=off to run simulation only");
    }
    config = await createGuardFromConfig(config);
  } catch (err) {
    die(`refusing to start: ${(err as Error).message}`);
  }
  for (const w of config.guardSpec ? selectorWarnings(config.guardSpec.policy) : []) console.error(`[l2-send-guard] WARNING: ${w}`);
  const server = listen(config);
  const stopWatch = startWatch(config);
  server.on("close", stopWatch);
}

main(process.argv.slice(2)).catch((err) => die((err as Error).message));
