/**
 * Canonical params for the methods the guard gates. The guard judges the signed txs it reads
 * from params; this module makes sure the params forwarded are exactly what was judged.
 *
 * Why: Go's encoding/json (geth, op-geth, Nitro, builders, Flashbots relays, mev-share-node)
 * matches object keys case-insensitively with Unicode simple folding ("ſ" -> "s",
 * "K" -> "k"), last key wins, and also accepts a case variant when the exact key is absent.
 * So `{"txs":[GOOD],"txſ":[EVIL]}` is judged on GOOD and executed on EVIL, and a mev_sendBundle
 * item `{"bundle":{…},"Tx":EVIL}` sends EVIL. Each gated method's params are therefore rebuilt
 * from an exact-key allowlist; a key that is not byte-identical to an allowed key is refused,
 * never dropped, so nothing the guard did not read can reach the upstream.
 */

type Prim = string | number | boolean | null;
type Schema =
  | { t: "hex" }
  | { t: "prim" }
  | { t: "prims" }
  | { t: "obj"; keys: Record<string, Schema>; required?: string[] }
  | { t: "arr"; of: Schema }
  | { t: "addrmap"; of: Schema }
  | { t: "hexmap" }
  | { t: "oneOf"; of: Schema[] }
  | { t: "lazy"; get: () => Schema };

const HEX = /^0x[0-9a-fA-F]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SLOT = /^0x[0-9a-fA-F]{1,64}$/;

const hex: Schema = { t: "hex" };
const prim: Schema = { t: "prim" };
const prims: Schema = { t: "prims" };

class Refused extends Error {}

function isPrim(v: unknown): v is Prim {
  return v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

function rebuild(v: unknown, s: Schema, path: string): unknown {
  switch (s.t) {
    case "lazy":
      return rebuild(v, s.get(), path);
    case "hex":
      if (typeof v !== "string" || !HEX.test(v)) throw new Refused(`${path} must be a hex string`);
      return v;
    case "prim":
      if (!isPrim(v)) throw new Refused(`${path} must be a string, number, boolean or null`);
      return v;
    case "prims":
      if (!Array.isArray(v) || !v.every(isPrim)) throw new Refused(`${path} must be an array of strings or numbers`);
      return [...v];
    case "arr":
      if (!Array.isArray(v)) throw new Refused(`${path} must be an array`);
      return v.map((x, i) => rebuild(x, s.of, `${path}[${i}]`));
    case "obj": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Refused(`${path} must be an object`);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) {
        const child = Object.prototype.hasOwnProperty.call(s.keys, k) ? s.keys[k] : undefined;
        if (!child) throw new Refused(`${path} has a key the guard does not read: ${JSON.stringify(k)}`);
        out[k] = rebuild((v as Record<string, unknown>)[k], child, `${path}.${k}`);
      }
      for (const r of s.required ?? []) if (!(r in out)) throw new Refused(`${path}.${r} is required`);
      return out;
    }
    case "addrmap":
    case "hexmap": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Refused(`${path} must be an object`);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) {
        if (!(s.t === "addrmap" ? ADDRESS : SLOT).test(k)) throw new Refused(`${path} key ${JSON.stringify(k)} is not ${s.t === "addrmap" ? "an address" : "a storage slot"}`);
        const x = (v as Record<string, unknown>)[k];
        out[k] = s.t === "addrmap" ? rebuild(x, s.of, `${path}.${k}`) : rebuild(x, hex, `${path}.${k}`);
      }
      return out;
    }
    case "oneOf": {
      let last: unknown;
      for (const o of s.of) {
        try {
          return rebuild(v, o, path);
        } catch (e) {
          last = e;
        }
      }
      throw last instanceof Error ? last : new Refused(`${path} has an unexpected shape`);
    }
  }
}

const preferences: Schema = {
  t: "obj",
  keys: {
    fast: prim,
    auction: prim,
    privacy: { t: "obj", keys: { hints: prims, builders: prims } },
    validity: { t: "obj", keys: { refund: { t: "arr", of: { t: "obj", keys: { address: prim, percent: prim } } } } },
  },
};

const conditionalOptions: Schema = {
  t: "obj",
  keys: {
    knownAccounts: { t: "addrmap", of: { t: "oneOf", of: [hex, { t: "hexmap" }] } },
    blockNumberMin: prim,
    blockNumberMax: prim,
    timestampMin: prim,
    timestampMax: prim,
  },
};

// eth_sendBundle (Flashbots and compatible builders). `txs` is what the guard judges.
const sendBundle: Schema = {
  t: "obj",
  required: ["txs"],
  keys: {
    txs: { t: "arr", of: hex },
    blockNumber: prim,
    minTimestamp: prim,
    maxTimestamp: prim,
    revertingTxHashes: prims,
    droppingTxHashes: prims,
    replacementUuid: prim,
    refundPercent: prim,
    refundRecipient: prim,
    refundTxHashes: prims,
    builders: prims,
  },
};

// mev_sendBundle (MEV-Share v0.1). Each body item is exactly one of tx / hash / bundle
// (extractSignedTxs enforces "exactly one"), plus canRevert / revertMode.
const mevBundle: Schema = {
  t: "obj",
  required: ["body"],
  keys: {
    version: prim,
    inclusion: { t: "obj", keys: { block: prim, maxBlock: prim } },
    body: {
      t: "arr",
      of: { t: "obj", keys: { tx: prim, hash: prim, bundle: { t: "lazy", get: () => mevBundle }, canRevert: prim, revertMode: prim } },
    },
    validity: {
      t: "obj",
      keys: {
        refund: { t: "arr", of: { t: "obj", keys: { bodyIdx: prim, percent: prim } } },
        refundConfig: { t: "arr", of: { t: "obj", keys: { address: prim, percent: prim } } },
      },
    },
    privacy: { t: "obj", keys: { hints: prims, builders: prims, wantRefund: prim } },
    metadata: { t: "obj", keys: { originId: prim } },
  },
};

/** Positional params schema per gated method: [first, ...optional]. */
const METHOD_PARAMS: Record<string, Schema[]> = {
  eth_sendRawTransaction: [hex],
  eth_sendRawTransactionSync: [hex, prim],
  eth_sendRawTransactionConditional: [hex, conditionalOptions],
  eth_sendPrivateRawTransaction: [hex, preferences],
  eth_sendPrivateTransaction: [{ t: "obj", required: ["tx"], keys: { tx: hex, maxBlockNumber: prim, preferences } }],
  eth_sendBundle: [sendBundle],
  mev_sendBundle: [mevBundle],
};

export function isCanonicalizedMethod(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(METHOD_PARAMS, method);
}

/**
 * Rebuild a gated method's params from its allowlist. Returns the new params, or an error
 * naming the first key or value the guard refuses.
 */
export function canonicalParams(method: string, params: unknown): { params: unknown[] } | { error: string } {
  const schema = METHOD_PARAMS[method];
  if (!schema) return { error: `${method} is not a gated method` };
  if (!Array.isArray(params) || params.length === 0) return { error: "params must be a non-empty array" };
  if (params.length > schema.length) return { error: `${method} takes at most ${schema.length} param(s)` };
  try {
    return { params: params.map((p, i) => rebuild(p, schema[i]!, `params[${i}]`)) };
  } catch (e) {
    if (e instanceof Refused) return { error: e.message };
    throw e;
  }
}

/**
 * True if any object key anywhere in `v` contains a non-ASCII character. Go folds some of
 * them onto ASCII letters ("ſ" -> "s", "K" -> "k"), and no JSON-RPC field needs one.
 */
export function hasNonAsciiKeys(v: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(v)) return v.some((x) => hasNonAsciiKeys(x, depth + 1));
  if (v === null || typeof v !== "object") return false;
  for (const k of Object.keys(v)) {
    if (/[^\x00-\x7f]/.test(k)) return true;
    if (hasNonAsciiKeys((v as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}
