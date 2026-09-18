import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createServer } from "../src/proxy/server.js";
import type { GuardConfig } from "../src/types/index.js";
import { encodeErrorResult } from "viem";
import { COMMON_ERRORS_ABI } from "../src/decode/revert.js";
import { FAKE_RAW } from "./fixtures.js";

/**
 * Mocked integration: fake upstream RPC + real HTTP proxy server.
 * Covers end-to-end JSON-RPC path without public testnet or secrets.
 */

function startMockUpstream(handler: (method: string, params: unknown[]) => unknown) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      try {
        const result = handler(body.method, body.params ?? []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result })
        );
      } catch (err) {
        const e = err as Error & { code?: number; data?: unknown };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: e.code ?? 3,
              message: e.message,
              data: e.data,
            },
          })
        );
      }
    });
  });
  return new Promise<{ server: http.Server; url: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function rpc(
  url: string,
  method: string,
  params: unknown[],
  headers?: Record<string, string>
) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
}

const RAW_OK = FAKE_RAW;

describe("mocked HTTP integration", () => {
  const closers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      closers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => s.close(() => resolve()))
      )
    );
  });

  it("health endpoint reports multi-chain config", async () => {
    const upstream = await startMockUpstream(() => "0x1");
    closers.push(upstream.server);
    const config: GuardConfig = {
      listenHost: "127.0.0.1",
      listenPort: 0,
      failOpen: true,
      defaultChain: "arb-sepolia",
      chains: {
        "arb-sepolia": {
          id: "arb-sepolia",
          name: "Arbitrum Sepolia",
          chainId: 421614,
          upstreamRpcUrl: upstream.url,
          preferSimulateV1: false,
          ecosystem: "arbitrum",
        },
        "op-sepolia": {
          id: "op-sepolia",
          name: "OP Sepolia",
          chainId: 11155420,
          upstreamRpcUrl: upstream.url,
          preferSimulateV1: false,
          ecosystem: "op-stack",
        },
      },
    };
    const proxy = createServer(config);
    await new Promise<void>((resolve) =>
      proxy.listen(0, "127.0.0.1", () => resolve())
    );
    closers.push(proxy);
    const addr = proxy.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const health = await fetch(`http://127.0.0.1:${addr.port}/health`).then(
      (r) => r.json()
    );
    expect(health.ok).toBe(true);
    expect(health.chains).toContain("arb-sepolia");
    expect(health.chains).toContain("op-sepolia");
    expect(health.failOpen).toBe(true);
  });

  it("blocks definite revert from upstream eth_call", async () => {
    const revertData = encodeErrorResult({
      abi: COMMON_ERRORS_ABI,
      errorName: "Error",
      args: ["transfer failed"],
    });
    const upstream = await startMockUpstream((method) => {
      if (method === "eth_call") {
        const err = new Error("execution reverted") as Error & {
          code?: number;
          data?: string;
        };
        err.code = 3;
        err.data = revertData;
        throw err;
      }
      if (method === "eth_sendRawTransaction") {
        return "0xshould-not-reach";
      }
      return null;
    });
    closers.push(upstream.server);

    const config: GuardConfig = {
      listenHost: "127.0.0.1",
      listenPort: 0,
      failOpen: true,
      defaultChain: "arb-sepolia",
      chains: {
        "arb-sepolia": {
          id: "arb-sepolia",
          name: "Arbitrum Sepolia",
          chainId: 421614,
          upstreamRpcUrl: upstream.url,
          preferSimulateV1: false,
          ecosystem: "arbitrum",
        },
      },
    };
    const proxy = createServer(config);
    await new Promise<void>((resolve) =>
      proxy.listen(0, "127.0.0.1", () => resolve())
    );
    closers.push(proxy);
    const addr = proxy.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");

    const res = await rpc(
      `http://127.0.0.1:${addr.port}`,
      "eth_sendRawTransaction",
      [RAW_OK]
    );
    expect(res.jsonrpc).toBe("2.0");
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32080);
    expect(res.error.data.confidence).toBe("definite");
    expect(res.error.data.aborted).toBe(true);
    expect(String(res.error.message + res.error.data.reason)).toMatch(/transfer failed/i);
  });

  it("forwards eth_blockNumber to upstream", async () => {
    const upstream = await startMockUpstream((method) => {
      if (method === "eth_blockNumber") return "0xabc";
      throw new Error("unexpected " + method);
    });
    closers.push(upstream.server);
    const config: GuardConfig = {
      listenHost: "127.0.0.1",
      listenPort: 0,
      failOpen: true,
      defaultChain: "base-sepolia",
      chains: {
        "base-sepolia": {
          id: "base-sepolia",
          name: "Base Sepolia",
          chainId: 84532,
          upstreamRpcUrl: upstream.url,
          preferSimulateV1: true,
          ecosystem: "base",
        },
      },
    };
    const proxy = createServer(config);
    await new Promise<void>((resolve) =>
      proxy.listen(0, "127.0.0.1", () => resolve())
    );
    closers.push(proxy);
    const addr = proxy.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const res = await rpc(
      `http://127.0.0.1:${addr.port}`,
      "eth_blockNumber",
      []
    );
    expect(res.result).toBe("0xabc");
  });
});
