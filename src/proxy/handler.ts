import type { Hex } from "viem";
import type {
  ChainConfig,
  GuardConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  SimResult,
} from "../types/index.js";
import {
  ERR_DEFINITE_REVERT,
  SEND_METHODS,
} from "../types/index.js";
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
  // Also allow params meta via non-standard last-arg object — skip for KISS
  const key = headerKey?.trim() || config.defaultChain;
  const chain = config.chains[key];
  if (!chain) {
    // Try match by numeric chainId header
    const byId = Object.values(config.chains).find(
      (c) => String(c.chainId) === key
    );
    if (byId) return byId;
    throw new Error(`unknown chain '${key}'`);
  }
  return chain;
}

function abortResponse(
  id: JsonRpcRequest["id"],
  sim: Extract<SimResult, { ok: false }>
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: ERR_DEFINITE_REVERT,
      message: `L2 Send Guard: definite revert — ${sim.reason}`,
      data: {
        l2SendGuard: true,
        confidence: sim.confidence,
        code: sim.code,
        reason: sim.reason,
        simMethod: sim.method,
        rawData: sim.rawData,
        aborted: true,
      },
    },
  };
}

/**
 * Core middleware: intercept send methods → simulate → abort or fail-open.
 * All other methods are forwarded untouched.
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
    // Unexpected throw → fail-open if configured
    if (config.failOpen) {
      return forward(chain.upstreamRpcUrl, req);
    }
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32000,
        message: `simulation threw: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // Success path → forward
  if (sim.ok) {
    return forward(chain.upstreamRpcUrl, req);
  }

  // Definite revert → abort (never forward)
  if (sim.confidence === "definite" && sim.code === "DEFINITE_REVERT") {
    return abortResponse(req.id, sim);
  }

  // Uncertain / sim failure → fail-open (default) or surface error
  if (config.failOpen) {
    return forward(chain.upstreamRpcUrl, req);
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    error: {
      code: -32000,
      message: `L2 Send Guard: ${sim.code} — ${sim.reason}`,
      data: {
        l2SendGuard: true,
        confidence: sim.confidence,
        code: sim.code,
        reason: sim.reason,
        simMethod: sim.method,
        aborted: false,
        failOpen: false,
      },
    },
  };
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
