import type { JsonRpcRequest, JsonRpcResponse } from "../types/index.js";

export type RpcCaller = (
  method: string,
  params?: unknown[]
) => Promise<unknown>;

/**
 * Minimal JSON-RPC HTTP client against an upstream endpoint.
 * No private keys — read/sim/forward only.
 */
export function createRpcCaller(upstreamUrl: string): RpcCaller {
  let nextId = 1;
  return async (method: string, params: unknown[] = []) => {
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params,
    };
    const res = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`upstream HTTP ${res.status} for ${method}`);
    }
    const json = (await res.json()) as JsonRpcResponse;
    if (json.error) {
      const err = new Error(json.error.message) as Error & {
        code?: number;
        data?: unknown;
      };
      err.code = json.error.code;
      err.data = json.error.data;
      throw err;
    }
    return json.result;
  };
}

/** Forward a full JSON-RPC request body to upstream; return raw response. */
export async function forwardRaw(
  upstreamUrl: string,
  body: JsonRpcRequest | JsonRpcRequest[]
): Promise<JsonRpcResponse | JsonRpcResponse[]> {
  const res = await fetch(upstreamUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`upstream HTTP ${res.status}`);
  }
  return (await res.json()) as JsonRpcResponse | JsonRpcResponse[];
}
