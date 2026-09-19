import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createServer } from "../src/proxy/server.js";
import type { GuardConfig } from "../src/types/index.js";
import {
  clearSimulateV1CapabilityCache,
  isSimulateV1Unsupported,
} from "../src/sim/capabilityCache.js";
import { FAKE_RAW } from "./fixtures.js";
import { encodeErrorResult } from "viem";
import { COMMON_ERRORS_ABI } from "../src/decode/revert.js";
import { ERR_DEFINITE_REVERT } from "../src/types/index.js";

/**
 * HTTP-level re-smoke of the capability-cache path:
 * first send hits eth_simulateV1 (-32602) then eth_call;
 * subsequent sends use eth_call only (no re-hit of -32602).
 */

function startCountingUpstream() {
  const methods: string[] = [];
  const revertData = encodeErrorResult({
    abi: COMMON_ERRORS_ABI,
    errorName: "Error",
    args: ["cached-path-revert"],
  });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      methods.push(body.method);
      if (body.method === "eth_simulateV1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: "Invalid params" },
          })
        );
        return;
      }
      if (body.method === "eth_call") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: 3,
              message: "execution reverted",
              data: revertData,
            },
          })
        );
        return;
      }
      if (body.method === "eth_sendRawTransaction") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: "0xshould-not-forward",
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "unexpected" },
        })
      );
    });
  });
  return new Promise<{
    server: http.Server;
    url: string;
    methods: string[];
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        methods,
      });
    });
  });
}

async function sendRaw(proxyUrl: string) {
  const res = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-l2sg-chain": "base-sepolia",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [FAKE_RAW],
    }),
  });
  return res.json();
}

describe("capability-cache HTTP path", () => {
  const closers: http.Server[] = [];
  beforeEach(() => {
    clearSimulateV1CapabilityCache();
  });
  afterEach(async () => {
    await Promise.all(
      closers.splice(0).map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve()))
      )
    );
  });

  it("first -32602 then eth_call abort; later sends skip V1", async () => {
    const upstream = await startCountingUpstream();
    closers.push(upstream.server);

    const config: GuardConfig = {
      listenHost: "127.0.0.1",
      listenPort: 0,
      guardMode: "open",
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
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    closers.push(proxy);
    const addr = proxy.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const proxyUrl = `http://127.0.0.1:${addr.port}`;

    const first = await sendRaw(proxyUrl);
    expect(first.error?.code).toBe(ERR_DEFINITE_REVERT);
    expect(first.error?.data?.simMethod).toBe("eth_call");
    expect(upstream.methods).toEqual(["eth_simulateV1", "eth_call"]);
    expect(isSimulateV1Unsupported(upstream.url)).toBe(true);

    upstream.methods.length = 0;
    const second = await sendRaw(proxyUrl);
    expect(second.error?.code).toBe(ERR_DEFINITE_REVERT);
    expect(second.error?.data?.simMethod).toBe("eth_call");
    expect(upstream.methods).toEqual(["eth_call"]);

    upstream.methods.length = 0;
    const third = await sendRaw(proxyUrl);
    expect(third.error?.code).toBe(ERR_DEFINITE_REVERT);
    expect(upstream.methods).toEqual(["eth_call"]);
  });
});
