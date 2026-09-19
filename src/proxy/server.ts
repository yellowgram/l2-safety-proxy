import http from "node:http";
import type { GuardConfig, JsonRpcRequest } from "../types/index.js";
import { handlePayload } from "./handler.js";

export function createServer(config: GuardConfig): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "l2-send-guard",
          chains: Object.keys(config.chains),
          chainDetails: Object.values(config.chains).map((c) => ({
            id: c.id,
            name: c.name,
            chainId: c.chainId,
            ecosystem: c.ecosystem,
          })),
          defaultChain: config.defaultChain,
          guardMode: config.guardMode,
          failOpen: config.failOpen,
          submit: {
            accepted: ["eth_sendRawTransaction", "eth_sendRawTransactionSync"],
            refused: ["eth_sendTransaction"],
            note: "Sign externally; proxy never holds keys. See docs/AGENTS.md.",
          },
          confidence: ["simulate_v1", "eth_call", "unknown"],
        })
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, GET" });
      res.end("Method Not Allowed");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");

    let payload: JsonRpcRequest | JsonRpcRequest[];
    try {
      payload = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        })
      );
      return;
    }

    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v) && v[0]) headers.set(k, v[0]);
      }
      const result = await handlePayload(config, payload, headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : "Internal error",
          },
        })
      );
    }
  });
}

export function listen(config: GuardConfig): http.Server {
  const server = createServer(config);
  server.listen(config.listenPort, config.listenHost, () => {
    console.log(
      `[l2-send-guard] listening on http://${config.listenHost}:${config.listenPort}`
    );
    console.log(
      `[l2-send-guard] chains: ${Object.keys(config.chains).join(", ")} (default=${config.defaultChain})`
    );
    console.log(
      `[l2-send-guard] GUARD_MODE=${config.guardMode} (fail-open=${config.failOpen}) | no private-key custody`
    );
  });
  return server;
}
