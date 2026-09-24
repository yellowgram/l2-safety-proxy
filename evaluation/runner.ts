/**
 * Offline evaluation runner — mocks simulate/forward; never broadcasts.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleRequest } from "../src/proxy/handler.js";
import type {
  GuardConfig,
  GuardResponseMeta,
  SimResult,
} from "../src/types/index.js";
import { defaultSpendPolicy } from "../src/policy/index.js";
import { classifyDecision } from "./classify.js";
import type {
  ClassStats,
  DecisionClass,
  EvalFixture,
  EvalReport,
  FixtureResult,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORPUS = join(__dirname, "fixtures", "corpus.jsonl");
export const DEFAULT_REPORT_DIR = join(__dirname, "report");

const DECISION_CLASSES: DecisionClass[] = [
  "abort_definite",
  "probable",
  "forward",
  "infra_abort",
];

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

function emptyStats(): ClassStats {
  return { total: 0, pass: 0, fail: 0, passRate: 0, failRate: 0 };
}

function finalizeStats(s: ClassStats): ClassStats {
  const passRate = s.total === 0 ? 0 : s.pass / s.total;
  const failRate = s.total === 0 ? 0 : s.fail / s.total;
  return { ...s, passRate, failRate };
}

function loadCorpus(path: string): EvalFixture[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as EvalFixture;
    } catch (err) {
      throw new Error(
        `Invalid JSONL at line ${i + 1} in ${path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
}

function buildConfig(fixture: EvalFixture): GuardConfig {
  const chain = {
    id: fixture.chainKey,
    name: fixture.chainKey,
    chainId: fixture.chainId,
    upstreamRpcUrl: `http://eval-upstream-mock/${fixture.chainKey}`,
    preferSimulateV1: true,
    ecosystem: (fixture.chainKey.startsWith("arb")
      ? "arbitrum"
      : fixture.chainKey.startsWith("base")
        ? "base"
        : "op-stack") as "arbitrum" | "base" | "op-stack",
  };
  return {
    listenHost: "127.0.0.1",
    listenPort: 0,
    guardMode: fixture.guardMode,
    failOpen: fixture.guardMode === "open",
    policy: defaultSpendPolicy(),
    defaultChain: fixture.chainKey,
    chains: { [fixture.chainKey]: chain },
  };
}

function simFromFixture(fixture: EvalFixture): SimResult | "throw" {
  const { sim } = fixture;
  if (sim.kind === "throw") return "throw";
  if (sim.kind === "success") {
    return {
      ok: true,
      method: sim.method === "unavailable" ? "eth_call" : sim.method,
      confidence: "definite",
    };
  }
  if (sim.kind === "definite_revert") {
    return {
      ok: false,
      method: sim.method === "unavailable" ? "eth_call" : sim.method,
      confidence: "definite",
      reason: sim.reason ?? "definite revert",
      code: "DEFINITE_REVERT",
      ...(sim.rawData ? { rawData: sim.rawData } : {}),
    };
  }
  if (sim.kind === "uncertain_revert") {
    return {
      ok: false,
      method: sim.method === "unavailable" ? "eth_call" : sim.method,
      confidence: "uncertain",
      reason: sim.reason ?? "uncertain revert",
      code: "UNCERTAIN_REVERT",
      ...(sim.rawData ? { rawData: sim.rawData } : {}),
    };
  }
  // sim_failure
  return {
    ok: false,
    method: "unavailable",
    confidence: "uncertain",
    reason: sim.reason ?? "sim failure",
    code: "SIM_FAILURE",
  };
}

function extractMeta(res: {
  error?: { code?: number; data?: unknown };
  l2sg?: GuardResponseMeta;
}): Partial<GuardResponseMeta> & { errorCode?: number } {
  const data = (res.error?.data ?? res.l2sg ?? {}) as GuardResponseMeta;
  return { ...data, errorCode: res.error?.code };
}

export async function runFixture(fixture: EvalFixture): Promise<FixtureResult> {
  const config = buildConfig(fixture);
  let forwarded = false;
  const planned = simFromFixture(fixture);

  const simulate = async (): Promise<SimResult> => {
    if (planned === "throw") {
      throw new Error(fixture.sim.reason ?? "eval throw");
    }
    return planned;
  };

  const forward = async () => {
    forwarded = true;
    return {
      jsonrpc: "2.0" as const,
      id: fixture.id,
      result: ("0x" + "cd".repeat(32)) as `0x${string}`,
    };
  };

  const res = await handleRequest(
    config,
    {
      jsonrpc: "2.0",
      id: fixture.id,
      method: "eth_sendRawTransaction",
      params: [fixture.rawTx],
    },
    undefined,
    { simulate, forward }
  );

  const meta = extractMeta(res);
  const decision = meta.decision ?? (res.error ? "abort" : "forward");
  const decisionClass = classifyDecision({
    decision,
    certainty: meta.certainty,
    code: meta.code,
    simMethod: meta.simMethod,
    confidence: meta.confidence,
  });

  const actual = {
    decisionClass,
    decision,
    forwarded,
    errorCode: meta.errorCode,
    certainty: meta.certainty,
    confidence: meta.confidence,
    code: meta.code,
  };

  const failReasons: string[] = [];
  if (actual.decisionClass !== fixture.expected.decisionClass) {
    failReasons.push(
      `decisionClass: expected ${fixture.expected.decisionClass}, got ${actual.decisionClass}`
    );
  }
  if (actual.decision !== fixture.expected.decision) {
    failReasons.push(
      `decision: expected ${fixture.expected.decision}, got ${actual.decision}`
    );
  }
  if (actual.forwarded !== fixture.expected.forwarded) {
    failReasons.push(
      `forwarded: expected ${fixture.expected.forwarded}, got ${actual.forwarded}`
    );
  }

  return {
    id: fixture.id,
    pass: failReasons.length === 0,
    expected: fixture.expected,
    actual,
    failReasons,
  };
}

export interface RunEvalOptions {
  corpusPath?: string;
  reportDir?: string;
  writeReport?: boolean;
}

export async function runEval(
  options: RunEvalOptions = {}
): Promise<{ report: EvalReport; results: FixtureResult[] }> {
  const corpusPath = resolve(options.corpusPath ?? DEFAULT_CORPUS);
  const reportDir = resolve(options.reportDir ?? DEFAULT_REPORT_DIR);
  const writeReport = options.writeReport !== false;

  const fixtures = loadCorpus(corpusPath);
  const t0 = Date.now();
  const results: FixtureResult[] = [];
  for (const fx of fixtures) {
    results.push(await runFixture(fx));
  }
  const durationMs = Date.now() - t0;

  const byDecisionClass = Object.fromEntries(
    DECISION_CLASSES.map((c) => [c, emptyStats()])
  ) as Record<DecisionClass, ClassStats>;
  const byGuardMode: Record<string, ClassStats> = {};
  const byChain: Record<string, ClassStats> = {};

  const bump = (bag: Record<string, ClassStats>, key: string, pass: boolean) => {
    if (!bag[key]) bag[key] = emptyStats();
    bag[key].total += 1;
    if (pass) bag[key].pass += 1;
    else bag[key].fail += 1;
  };

  let pass = 0;
  let fail = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const fx = fixtures[i];
    if (r.pass) pass += 1;
    else fail += 1;
    bump(byDecisionClass, r.expected.decisionClass, r.pass);
    bump(byGuardMode, fx.guardMode, r.pass);
    bump(byChain, fx.chainKey, r.pass);
  }

  for (const c of DECISION_CLASSES) {
    byDecisionClass[c] = finalizeStats(byDecisionClass[c]);
  }
  for (const k of Object.keys(byGuardMode)) {
    byGuardMode[k] = finalizeStats(byGuardMode[k]);
  }
  for (const k of Object.keys(byChain)) {
    byChain[k] = finalizeStats(byChain[k]);
  }

  // Prefer repo-relative path for weekly METRICS
  const cwd = process.cwd();
  const corpusPathForReport = corpusPath.startsWith(cwd + "/")
    ? corpusPath.slice(cwd.length + 1)
    : corpusPath;

  const report: EvalReport = {
    generatedAtEt: etStamp(),
    corpusPath: corpusPathForReport,
    corpusSize: fixtures.length,
    offline: true,
    liveBroadcast: false,
    durationMs,
    totals: {
      pass,
      fail,
      passRate: fixtures.length === 0 ? 0 : pass / fixtures.length,
      failRate: fixtures.length === 0 ? 0 : fail / fixtures.length,
    },
    byDecisionClass,
    byGuardMode,
    byChain,
    failures: results
      .filter((r) => !r.pass)
      .map((r) => ({ id: r.id, reasons: r.failReasons })),
  };

  if (writeReport) {
    mkdirSync(reportDir, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
    const jsonPath = join(reportDir, `eval-${stamp}.json`);
    const latestPath = join(reportDir, "latest.json");
    const mdPath = join(reportDir, "latest.md");
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
    writeFileSync(latestPath, JSON.stringify(report, null, 2) + "\n");
    writeFileSync(mdPath, renderMarkdown(report), "utf8");
  }

  return { report, results };
}

export function renderMarkdown(report: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const rows = DECISION_CLASSES.map((c) => {
    const s = report.byDecisionClass[c];
    return `| ${c} | ${s.total} | ${s.pass} | ${s.fail} | ${pct(s.passRate)} | ${pct(s.failRate)} |`;
  }).join("\n");

  return `# Eval report

- **generatedAtEt:** ${report.generatedAtEt}
- **corpusPath:** \`${report.corpusPath}\`
- **corpusSize:** ${report.corpusSize}
- **offline:** ${report.offline} (liveBroadcast=${report.liveBroadcast})
- **durationMs:** ${report.durationMs}
- **totals:** pass=${report.totals.pass} fail=${report.totals.fail} passRate=${pct(report.totals.passRate)} failRate=${pct(report.totals.failRate)}

## Pass/fail by decision class

| decisionClass | n | pass | fail | passRate | failRate |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows}

## By guard mode

| mode | n | pass | fail | passRate |
| --- | ---: | ---: | ---: | ---: |
${Object.entries(report.byGuardMode)
  .map(
    ([k, s]) =>
      `| ${k} | ${s.total} | ${s.pass} | ${s.fail} | ${pct(s.passRate)} |`
  )
  .join("\n")}

## By chain

| chain | n | pass | fail | passRate |
| --- | ---: | ---: | ---: | ---: |
${Object.entries(report.byChain)
  .map(
    ([k, s]) =>
      `| ${k} | ${s.total} | ${s.pass} | ${s.fail} | ${pct(s.passRate)} |`
  )
  .join("\n")}

## Failures

${
  report.failures.length === 0
    ? "_none_"
    : report.failures
        .map((f) => `- \`${f.id}\`: ${f.reasons.join("; ")}`)
        .join("\n")
}
`;
}
