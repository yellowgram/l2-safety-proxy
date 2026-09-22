/**
 * Founder-controlled agent decision loop.
 * Reads evaluation fixtures (or generates synthetic signed txs), calls check(),
 * appends ≥N decisions to a JSONL log. Offline / sim OK; external users = 0.
 *
 * Usage:
 *   npx tsx src/agent/loop.ts
 *   npm run agent:loop
 *
 * Env:
 *   AGENT_DECISIONS=120          target decision count (default 200)
 *   AGENT_OUT=docs/agent-decisions.jsonl
 *   AGENT_CORPUS=evaluation/fixtures/corpus.jsonl
 *   GUARD_MODE=open|strict
 */
import { createWriteStream, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import type { ChainConfig, SimResult } from "../types/index.js";
import { check } from "./check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const TARGET = Number(process.env.AGENT_DECISIONS ?? "200");
const OUT = resolve(
  ROOT,
  process.env.AGENT_OUT ?? "docs/agent-decisions.jsonl"
);
const CORPUS = resolve(
  ROOT,
  process.env.AGENT_CORPUS ?? "evaluation/fixtures/corpus.jsonl"
);
const GUARD_MODE = (process.env.GUARD_MODE === "strict" ? "strict" : "open") as
  | "open"
  | "strict";

interface CorpusRow {
  id: string;
  chainKey: string;
  chainId: number;
  guardMode?: "open" | "strict";
  rawTx: `0x${string}`;
  sim: {
    kind: string;
    method: string;
    reason?: string;
    rawData?: `0x${string}`;
  };
}

function etStamp(): string {
  return (
    new Date()
      .toLocaleString("en-CA", {
        timeZone: "America/New_York",
        hour12: false,
      })
      .replace(", ", "T") + " ET"
  );
}

function mockSim(row: CorpusRow): SimResult {
  const method =
    row.sim.method === "eth_simulateV1"
      ? "eth_simulateV1"
      : row.sim.method === "eth_call"
        ? "eth_call"
        : "unavailable";
  switch (row.sim.kind) {
    case "success":
      return { ok: true, method, confidence: "definite" };
    case "definite_revert":
      return {
        ok: false,
        method,
        confidence: "definite",
        reason: row.sim.reason ?? "definite revert",
        code: "DEFINITE_REVERT",
        rawData: row.sim.rawData,
      };
    case "uncertain_revert":
      return {
        ok: false,
        method,
        confidence: "uncertain",
        reason: row.sim.reason ?? "uncertain revert",
        code: "UNCERTAIN_REVERT",
        rawData: row.sim.rawData,
      };
    case "sim_failure":
    case "throw":
      return {
        ok: false,
        method: "unavailable",
        confidence: "uncertain",
        reason: row.sim.reason ?? "sim failure",
        code: "SIM_FAILURE",
      };
    default:
      return {
        ok: false,
        method: "unavailable",
        confidence: "uncertain",
        reason: `unknown sim kind ${row.sim.kind}`,
        code: "SIM_FAILURE",
      };
  }
}

function chainFor(row: CorpusRow): ChainConfig {
  return {
    id: row.chainKey,
    name: row.chainKey,
    chainId: row.chainId,
    upstreamRpcUrl: `http://agent-loop-mock/${row.chainKey}`,
    preferSimulateV1: true,
    ecosystem: row.chainKey.startsWith("arb")
      ? "arbitrum"
      : row.chainKey.startsWith("base")
        ? "base"
        : "op-stack",
  };
}

function loadCorpus(path: string): CorpusRow[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusRow);
}

async function main() {
  const rows = loadCorpus(CORPUS);
  if (rows.length === 0) {
    console.error("empty corpus:", CORPUS);
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  const stream = createWriteStream(OUT, { flags: "w" });

  let n = 0;
  const counts: Record<string, number> = {
    abort: 0,
    fail_open: 0,
    forward: 0,
  };

  while (n < TARGET) {
    const row = rows[n % rows.length]!;
    const mode = (row.guardMode ?? GUARD_MODE) as "open" | "strict";
    const result = await check(row.rawTx as Hex, chainFor(row), {
      guardMode: mode,
      simulate: async () => mockSim(row),
    });
    const entry = {
      ts: etStamp(),
      i: n + 1,
      fixtureId: row.id,
      chainKey: row.chainKey,
      guardMode: mode,
      decision: result.decision,
      reason: result.reason,
      certainty: result.certainty,
      simProvenance: result.simProvenance,
      offline: true,
      externalUsers: 0,
    };
    stream.write(JSON.stringify(entry) + "\n");
    counts[result.decision] = (counts[result.decision] ?? 0) + 1;
    n += 1;
  }

  stream.end();
  await new Promise<void>((r) => stream.on("finish", () => r()));

  console.log(
    JSON.stringify(
      {
        ok: true,
        decisions: n,
        out: OUT.replace(ROOT + "/", ""),
        counts,
        offline: true,
        externalUsers: 0,
        freezeBreaches: 0,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
