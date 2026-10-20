import { readFileSync } from "node:fs";
import { isAddress, toFunctionSelector } from "viem";
import { PERMIT2_DEFAULT, PERMIT2_ZKSYNC } from "../abi.js";
import type { DestinationRule, Policy, TokenRule } from "./types.js";

export class PolicyError extends Error {}

const KNOWN_TOP = new Set([
  "$schema", "chains", "window", "native", "destinations", "tokens", "permit2",
  "delegation", "accounts", "universalRouter", "allowContractCreation", "typedData",
]);

/** zkSync Era mainnet / sepolia use a different Permit2 deployment. */
const PERMIT2_BY_CHAIN: [number, string][] = [[324, PERMIT2_ZKSYNC], [300, PERMIT2_ZKSYNC]];

function fail(where: string, msg: string): never {
  throw new PolicyError(`${where}: ${msg}`);
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (v === undefined) return {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(where, "must be an object");
  return v as Record<string, unknown>;
}

function only(o: Record<string, unknown>, keys: string[], where: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(where, `unknown key "${k}" (allowed: ${keys.join(", ")})`);
}

function addr(v: unknown, where: string): string {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) fail(where, `not an address: ${JSON.stringify(v)}`);
  return v.toLowerCase();
}

function addrs(v: unknown, where: string): Set<string> {
  if (v === undefined) return new Set();
  if (!Array.isArray(v)) fail(where, "must be an array of addresses");
  return new Set(v.map((a, i) => addr(a, `${where}[${i}]`)));
}

/** Amounts are decimal strings of raw units (wei, token base units), never floats. */
function amount(v: unknown, where: string): bigint | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v)) {
    fail(where, `must be a decimal integer string in raw units, e.g. "1000000" (got ${JSON.stringify(v)})`);
  }
  return BigInt(v);
}

function positiveInt(v: unknown, where: string, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) fail(where, "must be a positive integer");
  return v;
}

function selector(v: unknown, where: string): string {
  if (typeof v !== "string") fail(where, "must be a 4-byte selector or a function signature");
  if (v === "0x") return "0x";
  if (/^0x[0-9a-fA-F]{8}$/.test(v)) return v.toLowerCase();
  try {
    return toFunctionSelector(v).toLowerCase();
  } catch {
    fail(where, `not a selector or function signature: ${v}`);
  }
}

export function parsePolicy(json: unknown, source = "policy"): Policy {
  const root = obj(json, source);
  for (const k of Object.keys(root)) if (!KNOWN_TOP.has(k)) fail(source, `unknown key "${k}"`);

  const chains = new Set<number>();
  if (root.chains !== undefined) {
    if (!Array.isArray(root.chains)) fail(`${source}.chains`, "must be an array of chain ids");
    root.chains.forEach((c, i) => chains.add(positiveInt(c, `${source}.chains[${i}]`, 0)));
  }

  const window = obj(root.window, `${source}.window`);
  only(window, ["seconds"], `${source}.window`);
  const native = obj(root.native, `${source}.native`);
  only(native, ["maxPerTxWei", "windowMaxWei"], `${source}.native`);

  const destinations = new Map<string, DestinationRule>();
  for (const [k, v] of Object.entries(obj(root.destinations, `${source}.destinations`))) {
    const where = `${source}.destinations.${k}`;
    const key = addr(k, where);
    if (destinations.has(key)) fail(where, "listed twice (addresses are case-insensitive)");
    const d = obj(v, where);
    only(d, ["maxNativeWei", "selectors", "note"], where);
    const rule: DestinationRule = { maxNativeWei: amount(d.maxNativeWei, `${where}.maxNativeWei`) };
    if (d.selectors !== undefined) {
      if (!Array.isArray(d.selectors)) fail(`${where}.selectors`, "must be an array");
      rule.selectors = new Set(d.selectors.map((s, i) => selector(s, `${where}.selectors[${i}]`)));
    }
    destinations.set(key, rule);
  }

  const tokens = new Map<string, TokenRule>();
  for (const [k, v] of Object.entries(obj(root.tokens, `${source}.tokens`))) {
    const where = `${source}.tokens.${k}`;
    const key = addr(k, where);
    if (tokens.has(key)) fail(where, "listed twice (addresses are case-insensitive)");
    const t = obj(v, where);
    only(t, ["transfer", "approve", "windowMaxAmountRaw", "note"], where);
    const tr = obj(t.transfer, `${where}.transfer`);
    only(tr, ["recipients", "maxAmountRaw"], `${where}.transfer`);
    const ap = obj(t.approve, `${where}.approve`);
    only(ap, ["spenders", "maxAmountRaw", "operators"], `${where}.approve`);
    tokens.set(key, {
      transfer: { recipients: addrs(tr.recipients, `${where}.transfer.recipients`), maxAmountRaw: amount(tr.maxAmountRaw, `${where}.transfer.maxAmountRaw`) },
      approve: {
        spenders: addrs(ap.spenders, `${where}.approve.spenders`),
        maxAmountRaw: amount(ap.maxAmountRaw, `${where}.approve.maxAmountRaw`),
        operators: addrs(ap.operators, `${where}.approve.operators`),
      },
      windowMaxAmountRaw: amount(t.windowMaxAmountRaw, `${where}.windowMaxAmountRaw`),
    });
  }

  const p2 = obj(root.permit2, `${source}.permit2`);
  only(p2, ["address", "maxExpirySeconds"], `${source}.permit2`);
  const permit2Addresses = new Map<number, string>(PERMIT2_BY_CHAIN);
  const p2default = p2.address === undefined ? PERMIT2_DEFAULT : addr(p2.address, `${source}.permit2.address`);
  if (p2.address !== undefined) permit2Addresses.clear();

  const del = obj(root.delegation, `${source}.delegation`);
  only(del, ["mode", "delegates", "allowAnyChain"], `${source}.delegation`);
  const mode = del.mode ?? "deny";
  if (mode !== "deny" && mode !== "allowlist") fail(`${source}.delegation.mode`, 'must be "deny" or "allowlist"');
  if (del.allowAnyChain !== undefined && typeof del.allowAnyChain !== "boolean") fail(`${source}.delegation.allowAnyChain`, "must be a boolean");

  const ur = obj(root.universalRouter, `${source}.universalRouter`);
  only(ur, ["recipients"], `${source}.universalRouter`);
  const td = obj(root.typedData, `${source}.typedData`);
  only(td, ["allowUnknown"], `${source}.typedData`);
  if (root.allowContractCreation !== undefined && typeof root.allowContractCreation !== "boolean") {
    fail(`${source}.allowContractCreation`, "must be a boolean");
  }

  const accounts = addrs(root.accounts, `${source}.accounts`);
  for (const a of accounts) {
    if (destinations.has(a)) {
      fail(
        `${source}.destinations.${a}`,
        "is also listed in accounts. Calls the agent makes through its own account are checked one by one; listing the account as a destination would let any call to it through, including adding owners or modules. Remove it from destinations"
      );
    }
  }
  return {
    chains,
    windowSeconds: positiveInt(window.seconds, `${source}.window.seconds`, 86_400),
    native: {
      maxPerTxWei: amount(native.maxPerTxWei, `${source}.native.maxPerTxWei`),
      windowMaxWei: amount(native.windowMaxWei, `${source}.native.windowMaxWei`),
    },
    destinations,
    tokens,
    permit2: {
      addresses: permit2Addresses,
      defaultAddress: p2default,
      maxExpirySeconds: positiveInt(p2.maxExpirySeconds, `${source}.permit2.maxExpirySeconds`, 30 * 86_400),
    },
    delegation: { mode, delegates: addrs(del.delegates, `${source}.delegation.delegates`), allowAnyChain: del.allowAnyChain === true },
    accounts,
    universalRouter: { recipients: addrs(ur.recipients, `${source}.universalRouter.recipients`) },
    allowContractCreation: root.allowContractCreation === true,
    typedData: { allowUnknown: td.allowUnknown === true },
  };
}

export function loadPolicyFile(path: string): Policy {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new PolicyError(`can't read policy file ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new PolicyError(`policy file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parsePolicy(json, path);
}

export function permit2For(policy: Policy, chainId: number | undefined): string {
  return (chainId !== undefined && policy.permit2.addresses.get(chainId)) || policy.permit2.defaultAddress;
}
