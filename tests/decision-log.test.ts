import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/proxy/handler.js";
import { defaultSpendPolicy } from "../src/policy/index.js";
import type { GuardConfig } from "../src/types/index.js";
import { FAKE_RAW as RAW } from "./fixtures.js";

describe("decision log JSONL", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("appends a greppable policy_denied line and skips the log when unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "l2sg-log-"));
    dirs.push(dir);
    const logPath = join(dir, "decisions.jsonl");
    const policy = defaultSpendPolicy();
    policy.enabled = true;
    const config: GuardConfig = {
      listenHost: "127.0.0.1",
      listenPort: 8545,
      guardMode: "open",
      failOpen: true,
      policy,
      decisionLogPath: logPath,
      defaultChain: "arb-sepolia",
      chains: {
        "arb-sepolia": {
          id: "arb-sepolia",
          name: "Arbitrum Sepolia",
          chainId: 421614,
          upstreamRpcUrl: "http://upstream",
          preferSimulateV1: true,
          ecosystem: "arbitrum",
        },
      },
    };
    await handleRequest(
      config,
      { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [RAW] },
      undefined,
      { simulate: async () => { throw new Error("should not sim"); }, forward: async () => { throw new Error("should not forward"); } }
    );
    const line = readFileSync(logPath, "utf8").trim();
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(rec.decision).toBe("policy_denied");
    expect(rec.code).toBe(-32083);
    expect(rec.chainId).toBe(421614);
    expect(rec.layer).toBe(2);
    expect(rec.policyCode).toBe("DESTINATION_NOT_ALLOWLISTED");
    expect(rec.failOpen).toBe(false);
    expect(rec.method).toBe("eth_sendRawTransaction");
    expect(line).toMatch(/policy_denied/);
    expect(line).not.toMatch(/0x02f86d/);
  });
});
