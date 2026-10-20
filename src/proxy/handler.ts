import type { Hex } from "viem";
import type {
  ChainConfig,
  GuardConfig,
  GuardDecision,
  GuardResponseMeta,
  JsonRpcRequest,
  JsonRpcResponse,
  SimResult,
} from "../types/index.js";
import {
  ERR_BYPASS_LOCKED,
  ERR_CHAIN_MISMATCH,
  ERR_DEFINITE_REVERT,
  ERR_IDEMPOTENCY,
  ERR_POLICY_DENIED,
  ERR_STRICT_UNCERTAIN,
  ERR_UNSIGNED_SEND_REFUSED,
  SEND_METHODS,
  SUBMIT_LIKE,
  UNSIGNED_SEND_METHODS,
  WRAPPED_SEND_METHODS,
  methodConfidence,
} from "../types/index.js";
import { decodeRevertData } from "../decode/revert.js";
import { classifyUpstream, type Check } from "../guard/guard.js";
import { forwardRaw } from "../sim/rpcClient.js";
import { canonicalParams, hasNonAsciiKeys, isCanonicalizedMethod } from "./canonical.js";
import { simulateRawTransaction } from "../sim/simulator.js";
import { parseRawTransaction } from "../sim/txParse.js";
import { recordDecision } from "./counters.js";
import { appendDecisionLog, type DecisionLogRecord } from "./decisionLog.js";

export type SimulateFn = (
  chain: ChainConfig,
  rawTx: Hex
) => Promise<SimResult>;

export type ForwardFn = (
  upstreamUrl: string,
  body: JsonRpcRequest
) => Promise<JsonRpcResponse>;

export interface HandlerDeps {
  simulate?: SimulateFn;
  forward?: ForwardFn;
}

function resolveChain(
  config: GuardConfig,
  req: JsonRpcRequest,
  headers?: Headers
): { chain: ChainConfig; chainKey: string } {
  const headerKey =
    headers?.get("x-l2sg-chain") ?? headers?.get("x-chain-id");
  const key = headerKey?.trim() || config.defaultChain;
  const chain = config.chains[key];
  if (!chain) {
    const entry = Object.entries(config.chains).find(
      ([, c]) => String(c.chainId) === key
    );
    if (entry) return { chain: entry[1], chainKey: entry[0] };
    throw new Error(`unknown chain '${key}'`);
  }
  return { chain, chainKey: key };
}

function buildMeta(
  chain: ChainConfig,
  decision: GuardDecision,
  sim: SimResult,
  extras: Partial<GuardResponseMeta> = {}
): GuardResponseMeta {
  const meta: GuardResponseMeta = {
    l2SendGuard: true,
    decision,
    confidence: methodConfidence(sim.method),
    certainty: sim.confidence,
    chainId: chain.chainId,
    simMethod: sim.method,
    layer: 1,
    policyCode: null,
    ...extras,
  };
  if (!sim.ok) {
    meta.reason = sim.reason;
    meta.code = sim.code;
    if (sim.rawData) {
      meta.rawData = sim.rawData;
      const decoded = decodeRevertData(sim.rawData);
      meta.decoded = {
        reason: decoded.reason,
        kind: decoded.kind,
        ...(decoded.selector ? { selector: decoded.selector } : {}),
      };
    } else if (sim.reason) {
      meta.decoded = { reason: sim.reason };
    }
  }
  return meta;
}

function writeDecisionLog(
  config: GuardConfig,
  chain: ChainConfig,
  chainKey: string,
  method: string,
  meta: GuardResponseMeta,
  code: number | null
): void {
  const record: DecisionLogRecord = {
    ts: new Date().toISOString(),
    decision: meta.decision,
    code,
    chainId: chain.chainId,
    chainKey,
    layer: meta.layer ?? null,
    policyCode: meta.policyCode ?? null,
    certainty: meta.certainty,
    confidence: meta.confidence,
    failOpen: Boolean(meta.failOpen),
    method,
  };
  if (meta.signedChainId != null) record.signedChainId = meta.signedChainId;
  if (meta.path) record.path = meta.path;
  if (meta.reason) record.reason = meta.reason;
  appendDecisionLog(config.decisionLogPath, record);
}

function abortResponse(
  config: GuardConfig,
  id: JsonRpcRequest["id"],
  chain: ChainConfig,
  chainKey: string,
  method: string,
  sim: Extract<SimResult, { ok: false }>,
  decision: GuardDecision = "abort"
): JsonRpcResponse {
  const code =
    sim.code === "DEFINITE_REVERT" ? ERR_DEFINITE_REVERT : ERR_STRICT_UNCERTAIN;
  const meta = buildMeta(chain, decision, sim, {
    aborted: true,
    failOpen: false,
  });
  recordDecision(decision);
  writeDecisionLog(config, chain, chainKey, method, meta, code);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message: `L2 Send Guard: ${decision} — ${sim.reason}`,
      data: meta,
    },
  };
}

function guardDeniedResponse(
  config: GuardConfig,
  id: JsonRpcRequest["id"],
  chain: ChainConfig,
  chainKey: string,
  method: string,
  opts: {
    reason: string;
    policyCode: string;
    path?: string;
    to?: `0x${string}`;
    valueWei: bigint;
    priorTxHash?: string;
    index?: number;
  }
): JsonRpcResponse {
  const code =
    opts.policyCode === "IDEMPOTENCY_CONFLICT" || opts.policyCode === "STORE_DOWN" || opts.policyCode === "CHAIN_READ_FAILED"
      ? ERR_IDEMPOTENCY
      : opts.policyCode === "BYPASS_LOCKED"
        ? ERR_BYPASS_LOCKED
        : ERR_POLICY_DENIED;
  const decision: GuardDecision =
    code === ERR_IDEMPOTENCY ? "idempotency_conflict" : code === ERR_BYPASS_LOCKED ? "bypass_locked" : "policy_denied";
  const meta: GuardResponseMeta = {
    l2SendGuard: true,
    decision,
    confidence: "unknown",
    certainty: "definite",
    chainId: chain.chainId,
    simMethod: "unavailable",
    layer: 2,
    aborted: true,
    failOpen: false,
    reason: opts.reason,
    code: opts.policyCode,
    policyCode: opts.policyCode,
    ...(opts.path ? { path: opts.path } : {}),
    ...(opts.to ? { to: opts.to } : {}),
    ...(opts.priorTxHash ? { priorTxHash: opts.priorTxHash } : {}),
    ...(opts.index !== undefined ? { index: opts.index } : {}),
    value: `0x${opts.valueWei.toString(16)}` as `0x${string}`,
    hint: HINTS[opts.policyCode] ?? "Change the policy file if this send should be allowed. The guard never signs or holds keys.",
  };
  recordDecision(decision);
  writeDecisionLog(config, chain, chainKey, method, meta, code);
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message: `L2 Send Guard: ${decision} — ${opts.reason}`, data: meta },
  };
}

const HINTS: Record<string, string> = {
  IDEMPOTENCY_CONFLICT: "This Idempotency-Key already sent a different transaction. Use a new key, or re-sign with the same nonce to replace it.",
  STORE_DOWN: "The guard's state store failed, so it refused to send. Fix the store (see /health) and retry.",
  CHAIN_READ_FAILED: "The guard couldn't read the sender's nonce from the upstream RPC, so it refused to send. Nothing was sent; retry, or check the RPC.",
  BYPASS_LOCKED: "A transaction from this sender reached the chain without going through the guard. Find out why, then run: l2-send-guard unlock <address> --chain <id>.",
  METHOD_NOT_GATED: "This method submits transactions in a way the guard can't check. Use eth_sendRawTransaction.",
  INTERNAL_ERROR: "The guard hit an unexpected error while checking this transaction, so it refused to send. Please report it with the decision log entry.",
  REPLAYABLE_TX: "Sign the transaction with a chain id (EIP-155 or a typed transaction).",
  ROUTER_PAYOUT_TO_WRAPPER: "A swap inside a batch pays another contract in the transaction, where anyone could take the funds. Pay the sender's address explicitly.",
  SELECTORS_REQUIRED: 'This destination has no "selectors" list, so no function on it may be called. Add the function to its "selectors" in the policy.',
};

/**
 * True if any object in the request has two keys that differ only in case.
 * geth (up to 1.17.5), op-geth and Nitro decode JSON-RPC with Go's case-insensitive
 * field matching, last key wins: `{"params":[A],"Params":[B]}` would be judged on A and
 * executed on B. Such a request is refused rather than guessed at.
 */
export function hasCaseVariantKeys(v: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(v)) return v.some((x) => hasCaseVariantKeys(x, depth + 1));
  if (v === null || typeof v !== "object") return false;
  const seen = new Set<string>();
  for (const k of Object.keys(v)) {
    const f = k.toLowerCase();
    if (seen.has(f)) return true;
    seen.add(f);
    if (hasCaseVariantKeys((v as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}

const HEX = /^0x[0-9a-fA-F]*$/;
const HASH32 = /^0x[0-9a-fA-F]{64}$/;

/** The signed txs a send method carries. `null` = not a send method. */
export function extractSignedTxs(req: JsonRpcRequest): { raws: string[]; bundle: boolean } | { error: string } | null {
  const p0 = req.params?.[0] as unknown;
  if (SEND_METHODS.has(req.method)) {
    return typeof p0 === "string" && HEX.test(p0) ? { raws: [p0], bundle: false } : { error: "expected hex raw transaction" };
  }
  if (!WRAPPED_SEND_METHODS.has(req.method)) return null;
  if (req.method === "eth_sendPrivateTransaction") {
    const tx = (p0 as { tx?: unknown } | undefined)?.tx;
    return typeof tx === "string" && HEX.test(tx) ? { raws: [tx], bundle: false } : { error: "expected { tx: hex }" };
  }
  if (req.method === "eth_sendBundle") {
    const txs = (p0 as { txs?: unknown } | undefined)?.txs;
    if (!Array.isArray(txs) || txs.length === 0 || !txs.every((t) => typeof t === "string" && HEX.test(t))) {
      return { error: "expected { txs: hex[] }" };
    }
    return { raws: txs as string[], bundle: true };
  }
  // mev_sendBundle: body items are { tx } (ours, signed), { hash } (someone else's, already public) or { bundle } (nested).
  const raws: string[] = [];
  const walk = (b: unknown, depth: number): boolean => {
    const body = (b as { body?: unknown } | undefined)?.body;
    if (!Array.isArray(body) || depth > 4) return false;
    for (const item of body) {
      if (item === null || typeof item !== "object") return false;
      const it = item as Record<string, unknown>;
      // Exactly one of tx / hash / bundle. A `tx` the guard can't read is refused, never
      // treated as someone else's already-public hash.
      const kinds = ["tx", "hash", "bundle"].filter((k) => k in it);
      if (kinds.length !== 1) return false;
      if (kinds[0] === "tx") {
        if (typeof it.tx !== "string" || !HEX.test(it.tx)) return false;
        raws.push(it.tx);
      } else if (kinds[0] === "bundle") {
        if (!walk(it.bundle, depth + 1)) return false;
      } else if (typeof it.hash !== "string" || !HASH32.test(it.hash)) return false;
    }
    return true;
  };
  if (!walk(p0, 0)) return { error: "expected { body: [{ tx } | { hash } | { bundle }] }" };
  return { raws, bundle: true };
}

function attachL2sg(
  config: GuardConfig,
  res: JsonRpcResponse,
  chain: ChainConfig,
  chainKey: string,
  method: string,
  meta: GuardResponseMeta
): JsonRpcResponse {
  recordDecision(meta.decision);
  writeDecisionLog(config, chain, chainKey, method, meta, null);
  return { ...res, l2sg: meta };
}

function chainMismatchResponse(
  config: GuardConfig,
  req: JsonRpcRequest,
  chain: ChainConfig,
  chainKey: string,
  signedChainId: number
): JsonRpcResponse {
  const meta: GuardResponseMeta = {
    l2SendGuard: true,
    decision: "chain_mismatch",
    confidence: "unknown",
    certainty: "definite",
    chainId: chain.chainId,
    signedChainId,
    simMethod: "unavailable",
    layer: null,
    policyCode: null,
    aborted: true,
    failOpen: false,
    code: "CHAIN_MISMATCH",
    reason: `signed chainId ${signedChainId} does not match selected chain ${chain.chainId} (${chainKey})`,
    hint: "Set x-l2sg-chain to the chain you signed, or re-sign for the selected chain. Not forwarded.",
  };
  recordDecision("chain_mismatch");
  writeDecisionLog(config, chain, chainKey, req.method, meta, ERR_CHAIN_MISMATCH);
  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: ERR_CHAIN_MISMATCH, message: `L2 Send Guard: chain_mismatch — ${meta.reason}`, data: meta },
  };
}

/**
 * Core middleware, in order:
 * 1. Resolve chain from `x-l2sg-chain` (key or numeric id) or the default chain.
 * 2. Refuse anything that asks the node to sign (-32081). The guard holds no keys.
 * 3. Find the signed txs the method carries (raw, private, conditional, bundles).
 *    A submit-like method the guard doesn't know is refused (-32083 METHOD_NOT_GATED).
 *    Other methods pass through.
 * 4. Any carried tx signed for another chain → -32084, nothing forwarded.
 * 5. Layer 2 (unless simulation-only mode): policy over every nested call, 7702
 *    authorizations, rolling caps, Idempotency-Key, bypass lock. Deny → -32083 / -32087 /
 *    -32088; earlier txs of the same request are released.
 * 6. Layer 1 simulate (single txs; bundles are left to the builder). Definite revert →
 *    -32080. Uncertain → -32082 in strict mode (default), forwarded in open mode.
 * 7. Forward the rebuilt request, then record what the upstream did. Caps and keys are
 *    freed only on a definite rejection; a timeout or unclear error keeps them held.
 */
export async function handleRequest(
  config: GuardConfig,
  incoming: JsonRpcRequest,
  headers?: Headers,
  deps: HandlerDeps = {}
): Promise<JsonRpcResponse> {
  // Only what is judged is forwarded: a request rebuilt from the four JSON-RPC fields.
  // Extra keys are dropped; keys that collide by case anywhere are refused (see above).
  const id = (incoming as { id?: JsonRpcRequest["id"] } | null)?.id ?? null;
  if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming) || typeof incoming.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request: expected a JSON-RPC object with a string method" } };
  }
  if (hasCaseVariantKeys(incoming)) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "invalid request: keys that differ only in case (e.g. params/Params) are refused, because upstream nodes may read the other one" },
    };
  }
  if (incoming.params !== undefined && !Array.isArray(incoming.params) && (typeof incoming.params !== "object" || incoming.params === null)) {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request: params must be an array or object" } };
  }
  if (incoming.params !== undefined && hasNonAsciiKeys(incoming.params)) {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request: object keys must be ASCII, because upstream nodes fold some other characters onto letters" } };
  }
  // Gated methods: params rebuilt from an exact-key allowlist (see canonical.ts), so the
  // nested objects forwarded hold only what the guard read. Unknown keys are refused.
  let params: unknown = incoming.params;
  if (isCanonicalizedMethod(incoming.method)) {
    const c = canonicalParams(incoming.method, incoming.params);
    if ("error" in c) return { jsonrpc: "2.0", id, error: { code: -32602, message: `invalid params: ${c.error}` } };
    params = c.params;
  }
  const req: JsonRpcRequest = { jsonrpc: "2.0", id, method: incoming.method, ...(params !== undefined ? { params } : {}) } as JsonRpcRequest;

  const simulate = deps.simulate ?? simulateRawTransaction;
  const forward =
    deps.forward ??
    (async (url, body) => {
      const res = await forwardRaw(url, body);
      return res as JsonRpcResponse;
    });

  let chain: ChainConfig;
  let chainKey: string;
  try {
    ({ chain, chainKey } = resolveChain(config, req, headers));
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (UNSIGNED_SEND_METHODS.has(req.method)) {
    const meta: GuardResponseMeta = {
      l2SendGuard: true,
      decision: "unsigned_refused",
      confidence: "unknown",
      certainty: "definite",
      chainId: chain.chainId,
      simMethod: "unavailable",
      layer: null,
      policyCode: null,
      aborted: true,
      failOpen: false,
      code: "UNSIGNED_SEND_REFUSED",
      reason: "eth_sendTransaction refused — no key custody",
      hint: "Point your JSON-RPC URL at this proxy; keep signing in your wallet/agent.",
    };
    recordDecision("unsigned_refused");
    writeDecisionLog(config, chain, chainKey, req.method, meta, ERR_UNSIGNED_SEND_REFUSED);
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: ERR_UNSIGNED_SEND_REFUSED,
        message:
          "L2 Send Guard: eth_sendTransaction refused — no key custody. Sign externally and submit via eth_sendRawTransaction.",
        data: {
          ...meta,
          refused: true,
          useMethod: "eth_sendRawTransaction",
        },
      },
    };
  }

  const carried = extractSignedTxs(req);
  if (carried === null) {
    if (SUBMIT_LIKE.test(req.method)) {
      return guardDeniedResponse(config, req.id, chain, chainKey, req.method, {
        reason: `${req.method} submits transactions in a way the guard can't check, so it is refused`,
        policyCode: "METHOD_NOT_GATED",
        valueWei: 0n,
      });
    }
    return forward(chain.upstreamRpcUrl, req);
  }
  if ("error" in carried) {
    return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: `invalid params: ${carried.error}` } };
  }
  if (carried.raws.length === 0) return forward(chain.upstreamRpcUrl, req);

  // Chain check on every carried tx (legacy txs with no chainId are not compared).
  for (const r of carried.raws) {
    let signedChainId: number | undefined;
    try {
      signedChainId = parseRawTransaction(r as Hex).tx.chainId ?? undefined;
    } catch {
      signedChainId = undefined;
    }
    if (signedChainId != null && signedChainId !== chain.chainId) {
      return chainMismatchResponse(config, req, chain, chainKey, signedChainId);
    }
  }

  // Layer 2: policy, caps, idempotency, bypass detection. Every tx must pass.
  const guard = config.guard;
  const checks: Extract<Check, { action: "forward" }>[] = [];
  if (guard) {
    const headerKey = headers?.get("idempotency-key")?.trim() || undefined;
    for (const [i, r] of carried.raws.entries()) {
      const key = headerKey && carried.raws.length > 1 ? `${headerKey}#${i}` : headerKey;
      const c = await guard.check(r as Hex, { chainId: chain.chainId, idempotencyKey: key });
      if (c.action === "deny") {
        for (const done of checks) await guard.settle(done, "rejected");
        return guardDeniedResponse(config, req.id, chain, chainKey, req.method, {
          reason: c.reason,
          policyCode: c.code,
          path: c.path,
          to: c.tx?.to,
          valueWei: c.tx?.value ?? 0n,
          priorTxHash: c.priorTxHash,
          ...(carried.raws.length > 1 ? { index: i } : {}),
        });
      }
      checks.push(c);
    }
  }

  const send = async (decisionMeta: GuardResponseMeta): Promise<JsonRpcResponse> => {
    let upstream: JsonRpcResponse;
    try {
      upstream = await forward(chain.upstreamRpcUrl, req);
    } catch (err) {
      if (guard) for (const c of checks) await guard.settle(c, "unknown");
      throw err;
    }
    const outcome = classifyUpstream(upstream, false);
    if (guard) for (const c of checks) await guard.settle(c, outcome);
    // Re-sending bytes the node already has is the idempotent case: answer with the hash.
    const only = checks.length === 1 ? checks[0] : undefined;
    if (only && upstream.error && outcome === "accepted" && (req.method === "eth_sendRawTransaction" || req.method === "eth_sendPrivateRawTransaction")) {
      upstream = { jsonrpc: "2.0", id: upstream.id, result: only.tx.hash };
    }
    if (only?.replay) decisionMeta.replay = true;
    return attachL2sg(config, upstream, chain, chainKey, req.method, decisionMeta);
  };

  // An idempotent retry of bytes the guard already forwarded. Simulating them again is
  // meaningless (once mined, the nonce is used and the simulation "fails"), so don't.
  // Known sent → answer with the hash. Outcome unknown → rebroadcast the same bytes,
  // which can only land once.
  const replay = checks.length === 1 && carried.raws.length === 1 && checks[0]!.replay ? checks[0]! : undefined;
  if (replay) {
    const meta: GuardResponseMeta = {
      l2SendGuard: true,
      decision: "forward",
      confidence: "unknown",
      certainty: "definite",
      chainId: chain.chainId,
      simMethod: "unavailable",
      layer: 2,
      policyCode: null,
      aborted: false,
      failOpen: false,
      replay: true,
      reason:
        replay.priorStatus === "sent"
          ? "idempotent retry: this transaction was already sent under this key"
          : "idempotent retry: the first send's outcome is unknown, so the same bytes were rebroadcast",
    };
    if (replay.priorStatus === "sent") {
      return attachL2sg(config, { jsonrpc: "2.0", id: req.id, result: replay.tx.hash }, chain, chainKey, req.method, meta);
    }
    return send(meta);
  }

  // Bundles go to a builder that simulates them atomically and drops ones that revert,
  // so a revert there costs no gas. Each tx in a bundle can depend on the one before it,
  // which a per-tx simulation can't model; Layer 1 is skipped and the response says so.
  if (carried.bundle) {
    return send({
      l2SendGuard: true,
      decision: "forward",
      confidence: "unknown",
      certainty: "uncertain",
      chainId: chain.chainId,
      simMethod: "unavailable",
      layer: 2,
      policyCode: null,
      aborted: false,
      failOpen: false,
      reason: "bundle: policy checked for every tx; simulation is left to the builder",
    });
  }
  const raw = carried.raws[0] as Hex;

  // Not sent: give back caps and idempotency keys reserved above.
  const abortWithRelease = async (r: Extract<SimResult, { ok: false }>): Promise<JsonRpcResponse> => {
    if (guard) for (const c of checks) await guard.settle(c, "rejected");
    return abortResponse(config, req.id, chain, chainKey, req.method, r, "abort");
  };

  let sim: SimResult;
  try {
    sim = await simulate(chain, raw as Hex);
  } catch (err) {
    const thrown: SimResult = {
      ok: false,
      method: "unavailable",
      confidence: "uncertain",
      reason: `simulation threw: ${err instanceof Error ? err.message : String(err)}`,
      code: "SIM_FAILURE",
    };
    if (config.guardMode === "open") {
      return send(buildMeta(chain, "fail_open", thrown, { failOpen: true, aborted: false }));
    }
    return abortWithRelease(thrown);
  }

  // Success path → forward
  if (sim.ok) {
    return send(buildMeta(chain, "forward", sim, { aborted: false, failOpen: false }));
  }

  // Definite revert → abort (never forward)
  if (sim.confidence === "definite" && sim.code === "DEFINITE_REVERT") {
    return abortWithRelease(sim);
  }

  // Uncertain / sim failure
  if (config.guardMode === "open") {
    return send(buildMeta(chain, "fail_open", sim, { failOpen: true, aborted: false }));
  }

  // strict: abort on missing / unknown / low-confidence
  return abortWithRelease(sim);
}

export async function handlePayload(
  config: GuardConfig,
  payload: JsonRpcRequest | JsonRpcRequest[],
  headers?: Headers,
  deps: HandlerDeps = {}
): Promise<JsonRpcResponse | JsonRpcResponse[]> {
  if (Array.isArray(payload)) {
    return Promise.all(
      payload.map((r) => handleRequest(config, r, headers, deps))
    );
  }
  return handleRequest(config, payload, headers, deps);
}
