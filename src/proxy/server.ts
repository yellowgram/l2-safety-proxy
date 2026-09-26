import http from "node:http";
import type { GuardConfig, JsonRpcRequest } from "../types/index.js";
import { PACKAGE_VERSION } from "../version.js";
import { handlePayload } from "./handler.js";
import { getDecisionCounters } from "./counters.js";
import { ensureDecisionLogDir } from "./decisionLog.js";

function overlayAllowsAny(policy: GuardConfig["policy"]): boolean {
  if (!policy) return false;
  return Object.values(policy.chains).some((overlay) => overlay.allowAnyDestination === true);
}

/** Distinct addresses on the base map or any chain overlay. Not the effective set for one chain. */
function configuredDestinationCount(policy: GuardConfig["policy"]): number {
  if (!policy) return 0;
  const keys = new Set<string>();
  for (const addr of policy.destinations.keys()) keys.add(addr.toLowerCase());
  for (const overlay of Object.values(policy.chains)) {
    if (!overlay.destinations) continue;
    for (const addr of overlay.destinations.keys()) keys.add(addr.toLowerCase());
  }
  return keys.size;
}

function policyHealthSummary(config: GuardConfig) {
  const p = config.policy;
  const enabled = Boolean(p?.enabled);
  return {
    enabled,
    destinationCount: enabled ? configuredDestinationCount(p) : 0,
    allowAnyDestination: enabled
      ? Boolean(p?.allowAnyDestination) || overlayAllowsAny(p)
      : false,
    allowContractCreation: enabled ? Boolean(p?.allowContractCreation) : false,
    hasGlobalMaxNativeWei: enabled ? p?.globalMaxNativeWei != null : false,
    erc20RecipientCheck: enabled ? Boolean(p?.erc20RecipientCheck) : false,
    notifyConfigured: enabled ? Boolean(p?.humanGate?.notifyUrl) : false,
    // Never expose allowlisted addresses on /health
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
    const pol = config.policy;
    console.log(
      `[l2-send-guard] Layer2 policy=${pol?.enabled ? "ON" : "OFF"}` +
        (pol?.enabled
          ? ` destinations=${configuredDestinationCount(pol)}`
          : " (set L2SG_POLICY_ENABLED / L2SG_POLICY_FILE)")
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
    if (pol?.enabled && (pol.allowAnyDestination || overlayAllowsAny(pol))) {
      console.warn(
        "[l2-send-guard] WARNING: allowAnyDestination=true — the destination allowlist is not a spend fence. Caps still apply. Policy ON is not a safe agent."
      );
    }
  });
  return server;
}
