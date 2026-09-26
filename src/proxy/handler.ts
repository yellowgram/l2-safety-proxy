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
  ERR_CHAIN_MISMATCH,
  ERR_DEFINITE_REVERT,
  ERR_POLICY_DENIED,
  ERR_STRICT_UNCERTAIN,
  ERR_UNSIGNED_SEND_REFUSED,
  SEND_METHODS,
  UNSIGNED_SEND_METHODS,
  methodConfidence,
} from "../types/index.js";
import { decodeRevertData } from "../decode/revert.js";
import { evaluateSpendPolicy, notifyPolicyDenied } from "../policy/index.js";
import { forwardRaw } from "../sim/rpcClient.js";
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

function policyDeniedResponse(
  config: GuardConfig,
  id: JsonRpcRequest["id"],
  chain: ChainConfig,
  chainKey: string,
  method: string,
  opts: {
    reason: string;
    policyCode: string;
    to?: `0x${string}`;
    valueWei: bigint;
  }
): JsonRpcResponse {
  const meta: GuardResponseMeta = {
    l2SendGuard: true,
    decision: "policy_denied",
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
    ...(opts.to ? { to: opts.to } : {}),
    value: `0x${opts.valueWei.toString(16)}` as `0x${string}`,
    hint: "Update Layer 2 policy allowlist/caps or disable L2SG_POLICY_ENABLED. Operator keeps keys.",
  };
  recordDecision("policy_denied");
  writeDecisionLog(config, chain, chainKey, method, meta, ERR_POLICY_DENIED);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: ERR_POLICY_DENIED,
      message: `L2 Send Guard: policy_denied — ${opts.reason}`,
      data: meta,
    },
  };
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

/**
 * Core middleware, in order:
 * 1. Resolve chain from `x-l2sg-chain` (key or numeric id) or the default chain.
 * 2. Refuse `eth_sendTransaction` (-32081). No parse, no sim, no forward.
 * 3. Parse the signed raw tx. If `chainId` is present and ≠ the selected chain,
 *    stop with -32084 `chain_mismatch` (no sim, no policy, no forward).
 *    Legacy txs with no chainId are not compared.
 * 4. If Layer 2 policy is enabled, evaluate allowlist + caps. Deny → -32083
 *    `policy_denied` and do not simulate. Policy denials never fail-open.
 * 5. Layer 1 simulate. Definite revert → -32080 abort (no forward).
 *    Uncertain → fail-open forward when GUARD_MODE=open, else -32082.
 *
 * GUARD_MODE only affects Layer 1 simulation uncertainty.
 */
export async function handleRequest(
  config: GuardConfig,
  req: JsonRpcRequest,
  headers?: Headers,
  deps: HandlerDeps = {}
): Promise<JsonRpcResponse> {
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
      hint: "Point your JSON-RPC URL at this proxy; keep signing in your wallet/agent. See docs/AGENTS.md.",
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

  if (!SEND_METHODS.has(req.method)) {
    return forward(chain.upstreamRpcUrl, req);
  }

  const raw = req.params?.[0];
  if (typeof raw !== "string" || !raw.startsWith("0x")) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32602,
        message: "invalid params: expected hex raw transaction",
      },
    };
  }

  // Parse once. Failure skips chain compare and policy, then uses Layer 1.
  let parsed: ReturnType<typeof parseRawTransaction> | undefined;
  try {
    parsed = parseRawTransaction(raw as Hex);
  } catch {
    parsed = undefined;
  }

  if (
    parsed?.tx.chainId != null &&
    parsed.tx.chainId !== chain.chainId
  ) {
    const meta: GuardResponseMeta = {
      l2SendGuard: true,
      decision: "chain_mismatch",
      confidence: "unknown",
      certainty: "definite",
      chainId: chain.chainId,
      signedChainId: parsed.tx.chainId,
      simMethod: "unavailable",
      layer: null,
      policyCode: null,
      aborted: true,
      failOpen: false,
      code: "CHAIN_MISMATCH",
      reason: `signed chainId ${parsed.tx.chainId} does not match selected chain ${chain.chainId} (${chainKey})`,
      hint: "Set x-l2sg-chain to the chain you signed, or re-sign for the selected chain. Not forwarded.",
    };
    recordDecision("chain_mismatch");
    writeDecisionLog(config, chain, chainKey, req.method, meta, ERR_CHAIN_MISMATCH);
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: ERR_CHAIN_MISMATCH,
        message: `L2 Send Guard: chain_mismatch — ${meta.reason}`,
        data: meta,
      },
    };
  }

  const policy = config.policy;
  if (policy?.enabled && parsed) {
    const check = evaluateSpendPolicy(policy, {
      chainKey,
      chainId: chain.chainId,
      to: parsed.to,
      value: parsed.value,
      data: parsed.data,
    });
    if (!check.allow) {
      notifyPolicyDenied(
        policy,
        {
          chainKey,
          chainId: chain.chainId,
          to: parsed.to,
          value: parsed.value,
          data: parsed.data,
        },
        check
      );
      return policyDeniedResponse(config, req.id, chain, chainKey, req.method, {
        reason: check.reason ?? "policy denied",
        policyCode: check.code ?? "DESTINATION_NOT_ALLOWLISTED",
        to: check.effectiveTo ?? parsed.to,
        valueWei: check.valueWei,
      });
    }
  }

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
      const upstream = await forward(chain.upstreamRpcUrl, req);
      return attachL2sg(
        config,
        upstream,
        chain,
        chainKey,
        req.method,
        buildMeta(chain, "fail_open", thrown, { failOpen: true, aborted: false })
      );
    }
    return abortResponse(config, req.id, chain, chainKey, req.method, thrown);
  }

  // Success path → forward
  if (sim.ok) {
    const upstream = await forward(chain.upstreamRpcUrl, req);
    return attachL2sg(
      config,
      upstream,
      chain,
      chainKey,
      req.method,
      buildMeta(chain, "forward", sim, { aborted: false, failOpen: false })
    );
  }

  // Definite revert → abort (never forward)
  if (sim.confidence === "definite" && sim.code === "DEFINITE_REVERT") {
    return abortResponse(config, req.id, chain, chainKey, req.method, sim, "abort");
  }

  // Uncertain / sim failure
  if (config.guardMode === "open") {
    const upstream = await forward(chain.upstreamRpcUrl, req);
    return attachL2sg(
      config,
      upstream,
      chain,
      chainKey,
      req.method,
      buildMeta(chain, "fail_open", sim, { failOpen: true, aborted: false })
    );
  }

  // strict: abort on missing / unknown / low-confidence
  return abortResponse(config, req.id, chain, chainKey, req.method, sim, "abort");
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
