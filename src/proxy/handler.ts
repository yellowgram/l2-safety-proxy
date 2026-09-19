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
  ERR_DEFINITE_REVERT,
  ERR_STRICT_UNCERTAIN,
  ERR_UNSIGNED_SEND_REFUSED,
  SEND_METHODS,
  UNSIGNED_SEND_METHODS,
  methodConfidence,
} from "../types/index.js";
import { decodeRevertData } from "../decode/revert.js";
import { forwardRaw } from "../sim/rpcClient.js";
import { simulateRawTransaction } from "../sim/simulator.js";

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
): ChainConfig {
  const headerKey =
    headers?.get("x-l2sg-chain") ?? headers?.get("x-chain-id");
  const key = headerKey?.trim() || config.defaultChain;
  const chain = config.chains[key];
  if (!chain) {
    const byId = Object.values(config.chains).find(
      (c) => String(c.chainId) === key
    );
    if (byId) return byId;
    throw new Error(`unknown chain '${key}'`);
  }
  return chain;
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

function abortResponse(
  id: JsonRpcRequest["id"],
  chain: ChainConfig,
  sim: Extract<SimResult, { ok: false }>,
  decision: GuardDecision = "abort"
): JsonRpcResponse {
  const code =
    sim.code === "DEFINITE_REVERT" ? ERR_DEFINITE_REVERT : ERR_STRICT_UNCERTAIN;
  const meta = buildMeta(chain, decision, sim, {
    aborted: true,
    failOpen: false,
  });
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

function attachL2sg(
  res: JsonRpcResponse,
  meta: GuardResponseMeta
): JsonRpcResponse {
  return { ...res, l2sg: meta };
}

/**
 * Core middleware: intercept send methods → simulate → abort or fail-open.
 * All other methods are forwarded untouched.
 *
 * GUARD_MODE=open (default): uncertain → fail_open forward.
 * GUARD_MODE=strict: uncertain / missing / unknown → abort.
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
  try {
    chain = resolveChain(config, req, headers);
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
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: ERR_UNSIGNED_SEND_REFUSED,
        message:
          "L2 Send Guard: eth_sendTransaction refused — no key custody. Sign externally and submit via eth_sendRawTransaction.",
        data: {
          l2SendGuard: true,
          refused: true,
          code: "UNSIGNED_SEND_REFUSED",
          useMethod: "eth_sendRawTransaction",
          hint: "Point your JSON-RPC URL at this proxy; keep signing in your wallet/agent. See docs/AGENTS.md.",
          chainId: chain.chainId,
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
        upstream,
        buildMeta(chain, "fail_open", thrown, { failOpen: true, aborted: false })
      );
    }
    return abortResponse(req.id, chain, thrown);
  }

  // Success path → forward
  if (sim.ok) {
    const upstream = await forward(chain.upstreamRpcUrl, req);
    return attachL2sg(
      upstream,
      buildMeta(chain, "forward", sim, { aborted: false, failOpen: false })
    );
  }

  // Definite revert → abort (never forward)
  if (sim.confidence === "definite" && sim.code === "DEFINITE_REVERT") {
    return abortResponse(req.id, chain, sim, "abort");
  }

  // Uncertain / sim failure
  if (config.guardMode === "open") {
    const upstream = await forward(chain.upstreamRpcUrl, req);
    return attachL2sg(
      upstream,
      buildMeta(chain, "fail_open", sim, { failOpen: true, aborted: false })
    );
  }

  // strict: abort on missing / unknown / low-confidence
  return abortResponse(req.id, chain, sim, "abort");
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
