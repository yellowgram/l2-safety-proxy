import http from "node:http";
import { SEND_METHODS, UNSIGNED_SEND_METHODS, WRAPPED_SEND_METHODS, type GuardConfig, type JsonRpcRequest } from "../types/index.js";
import { PACKAGE_VERSION } from "../version.js";
import { handlePayload } from "./handler.js";
import { getDecisionCounters } from "./counters.js";
import { ensureDecisionLogDir } from "./decisionLog.js";

/** Largest JSON-RPC request accepted. A full bundle of large transactions fits well inside this. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

function policyHealthSummary(config: GuardConfig) {
  const p = config.guard?.policy;
  // Counts and switches only: never the addresses themselves.
  return {
    enabled: Boolean(p),
    source: config.policySource === "off" ? "off" : p ? "file" : "missing",
    store: config.guardSpec?.store.kind ?? null,
    bypass: config.guardSpec?.bypass ?? null,
    destinationCount: p?.destinations.size ?? 0,
    tokenCount: p?.tokens.size ?? 0,
    delegation: p?.delegation.mode ?? null,
    allowContractCreation: p?.allowContractCreation ?? false,
    windowSeconds: p?.windowSeconds ?? null,
  };
}

export function createServer(config: GuardConfig): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url?.startsWith("/health?"))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "l2-send-guard",
          version: PACKAGE_VERSION,
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
          policy: policyHealthSummary(config),
          decisions: getDecisionCounters(),
          submit: {
            accepted: [...SEND_METHODS, ...WRAPPED_SEND_METHODS],
            refused: [...UNSIGNED_SEND_METHODS],
            note: "Sign externally; the guard never holds keys. Other submit-like methods are refused.",
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
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `request body over ${MAX_BODY_BYTES} bytes` } }));
        req.destroy();
        return;
      }
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
  ensureDecisionLogDir(config.decisionLogPath);
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
    const p = config.guard?.policy;
    console.log(
      p
        ? `[l2-send-guard] policy ON (${config.policySource}): ${p.destinations.size} destinations, ${p.tokens.size} tokens, 7702 ${p.delegation.mode}; store=${config.guardSpec?.store.kind}; bypass=${config.guardSpec?.bypass}; receive watch=${config.guardSpec?.watch ? `${config.guardSpec.watch.agents.length} agent(s)` : "off"}`
        : "[l2-send-guard] WARNING: policy OFF (L2SG_POLICY=off). Simulation only: nothing limits where funds go."
    );
    if (
      config.listenHost === "0.0.0.0" ||
      config.listenHost === "::" ||
      config.listenHost === "::0"
    ) {
      console.warn(
        `[l2-send-guard] WARNING: L2SG_HOST=${config.listenHost} accepts unauthenticated requests. ` +
          "Anyone who can reach this port can forward raw transactions through your upstream RPC. " +
          "Prefer 127.0.0.1 unless a network ACL sits in front. " +
          "Docker: publish 127.0.0.1:8545:8545 on the host, not 0.0.0.0:8545:8545."
      );
    }
  });
  return server;
}
