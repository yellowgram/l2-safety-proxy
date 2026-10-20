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

/**
 * Universal Router's MSG_SENDER (0x…01) and ADDRESS_THIS (0x…02) recipient constants. They stand for
 * "the caller" and "the router", never a real account, so they can't be listed as one.
 */
const ROUTER_CONSTANTS = new Set(["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"]);

function realAddrs(v: unknown, where: string): Set<string> {
  const out = addrs(v, where);
  for (const a of out) {
    if (ROUTER_CONSTANTS.has(a)) {
      fail(where, `${a} is a Universal Router recipient constant (${a.endsWith("1") ? "MSG_SENDER" : "ADDRESS_THIS"}), not an account. Remove it`);
    }
  }
  return out;
}

/**
 * JSON.parse keeps the last of two equal keys, so a second entry for the same destination could
 * silently replace a stricter first one. Find every key that appears twice in one object.
 */
export function duplicateJsonKeys(text: string): string[] {
  const dups: string[] = [];
  const stack: { keys: Set<string> | null; path: string; key?: string; expectKey: boolean }[] = [];
  let i = 0;
  const readString = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const childPath = () => {
    const top = stack[stack.length - 1];
    if (!top) return "";
    return top.keys ? `${top.path}${top.path ? "." : ""}${top.key}` : `${top.path}[]`;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const top = stack[stack.length - 1];
      const str = readString();
      if (top?.keys && top.expectKey) {
        if (top.keys.has(str)) dups.push(`${top.path}${top.path ? "." : ""}${str}`);
        top.keys.add(str);
        top.key = str;
        top.expectKey = false;
      }
      continue;
    }
    if (c === "{" || c === "[") {
      stack.push({ keys: c === "{" ? new Set() : null, path: childPath(), expectKey: c === "{" });
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.keys) top.expectKey = true;
    }
    i++;
  }
  return dups;
}

/** JSON.parse, refusing a key that appears twice in one object. */
export function parseJsonText(text: string, where: string): unknown {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new PolicyError(`${where} is not valid JSON: ${(err as Error).message}`);
  }
  const dups = duplicateJsonKeys(text);
  if (dups.length > 0) {
    throw new PolicyError(`${where}: ${dups.map((d) => `"${d}"`).join(", ")} ${dups.length === 1 ? "appears" : "appear"} twice in the same object; JSON keeps only the last one. Merge the entries`);
  }
  return json;
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
  const missingSelectors: string[] = [];
  for (const [k, v] of Object.entries(obj(root.destinations, `${source}.destinations`))) {
    const where = `${source}.destinations.${k}`;
    const key = addr(k, where);
    if (destinations.has(key)) fail(where, "listed twice (addresses are case-insensitive)");
    const d = obj(v, where);
    only(d, ["maxNativeWei", "selectors", "allowAnySelector", "type", "note"], where);
    const rule: DestinationRule = { maxNativeWei: amount(d.maxNativeWei, `${where}.maxNativeWei`) };
    if (d.type !== undefined && d.type !== "eoa" && d.type !== "contract") fail(`${where}.type`, 'must be "eoa" or "contract"');
    if (d.allowAnySelector !== undefined && typeof d.allowAnySelector !== "boolean") fail(`${where}.allowAnySelector`, "must be a boolean");
    if (d.selectors === "*") {
      fail(`${where}.selectors`, 'must be an array. To allow every function on this destination, remove "selectors" and set "allowAnySelector": true');
    }
    if (d.selectors !== undefined) {
      if (!Array.isArray(d.selectors)) fail(`${where}.selectors`, "must be an array");
      rule.selectors = new Set(d.selectors.map((s, i) => selector(s, `${where}.selectors[${i}]`)));
    }
    if (d.allowAnySelector === true) {
      if (rule.selectors) fail(where, 'has both "selectors" and "allowAnySelector": true. Keep one');
      rule.anySelector = true;
    }
    if (d.type === "eoa") {
      if (rule.selectors || rule.anySelector) {
        fail(where, 'is "type": "eoa" (plain ETH transfers only), so it takes no "selectors" or "allowAnySelector". Drop the type if it is a contract');
      }
      rule.eoa = true;
    } else if (!rule.selectors && !rule.anySelector) {
      missingSelectors.push(key);
    }
    destinations.set(key, rule);
  }
  if (missingSelectors.length > 0) {
    fail(
      `${source}.destinations`,
      `${missingSelectors.length === 1 ? "this destination has" : `these ${missingSelectors.length} destinations have`} no "selectors" list: ` +
        `${missingSelectors.join(", ")}. Every destination must say which functions may be called on it (fail closed). ` +
        'For each: list them in "selectors" (["0x"] allows plain ETH transfers); ' +
        'or, for a plain account that only receives ETH, set "type": "eoa"; ' +
        'or, to allow every function on purpose, set "allowAnySelector": true (the proxy also needs GUARD_ALLOW_ANY_SELECTOR=1; warned on every call). ' +
        "To convert a whole 1.x file: l2-send-guard migrate-policy <file>"
    );
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

  const accounts = realAddrs(root.accounts, `${source}.accounts`);
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
    universalRouter: { recipients: realAddrs(ur.recipients, `${source}.universalRouter.recipients`) },
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
  return parsePolicy(parseJsonText(text, `policy file ${path}`), path);
}

/**
 * Loud warnings for the policy's explicit opt-outs from function lists. The CLI prints these at
 * startup and in check-policy; library users should log them too.
 */
export function selectorWarnings(policy: Policy): string[] {
  const out: string[] = [];
  for (const [d, r] of policy.destinations) {
    if (r.anySelector) {
      out.push(
        `destination ${d} has "allowAnySelector": true. ANY function on it may be called, including ones that move or approve funds. List its functions in "selectors" instead unless you mean this. The proxy refuses to start with it unless GUARD_ALLOW_ANY_SELECTOR=1 is set, and then prints a warning for every call it lets through`
      );
    }
  }
  return out;
}

export function permit2For(policy: Policy, chainId: number | undefined): string {
  return (chainId !== undefined && policy.permit2.addresses.get(chainId)) || policy.permit2.defaultAddress;
}
