import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDecision } from "../evaluation/classify.js";
import {
  runEval,
  runFixture,
  DEFAULT_CORPUS,
} from "../evaluation/runner.js";
import type { EvalFixture } from "../evaluation/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "evaluation/fixtures/corpus.jsonl");

describe("evaluation harness (offline)", () => {
  it("corpus exists in 200–500 band", () => {
    expect(existsSync(corpusPath)).toBe(true);
    const lines = readFileSync(corpusPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(200);
    expect(lines.length).toBeLessThanOrEqual(500);
  });

  it("classifyDecision maps surface decisions to METRICS classes", () => {
    expect(
      classifyDecision({
        decision: "abort",
        certainty: "definite",
        code: "DEFINITE_REVERT",
      })
    ).toBe("abort_definite");
    expect(
      classifyDecision({ decision: "fail_open", certainty: "uncertain" })
    ).toBe("probable");
    expect(
      classifyDecision({
        decision: "abort",
        certainty: "uncertain",
        code: "UNCERTAIN_REVERT",
      })
    ).toBe("probable");
    expect(classifyDecision({ decision: "forward", certainty: "definite" })).toBe(
      "forward"
    );
    expect(
      classifyDecision({
        decision: "abort",
        certainty: "uncertain",
        code: "SIM_FAILURE",
        simMethod: "unavailable",
      })
    ).toBe("infra_abort");
  });

  it("single fixture runs without network (mocked deps)", async () => {
    const fixture: EvalFixture = {
      id: "fx-test-definite",
      chainKey: "arb-sepolia",
      chainId: 421614,
      guardMode: "open",
      rawTx:
        "0x02f86d83066eee80843b9aca00843b9aca008252089400000000000000000000000000000000000000018080c001a07eade7c743ff2ea60f61c687ccca4b77553a14de08378371ac40c7d52a8f1d74a06fed4faa592ac84bae32b9311844176fc059eb70057c18450d4310072a880629",
      sim: {
        kind: "definite_revert",
        method: "eth_call",
        reason: "test",
      },
      expected: {
        decisionClass: "abort_definite",
        decision: "abort",
        forwarded: false,
      },
    };
    const result = await runFixture(fixture);
    expect(result.pass).toBe(true);
    expect(result.actual.forwarded).toBe(false);
    expect(result.actual.decisionClass).toBe("abort_definite");
  });

  it("full corpus eval is offline and all fixtures pass", async () => {
    const { report } = await runEval({
      corpusPath: DEFAULT_CORPUS,
      writeReport: false,
    });
    expect(report.offline).toBe(true);
    expect(report.liveBroadcast).toBe(false);
    expect(report.corpusSize).toBeGreaterThanOrEqual(200);
    expect(report.corpusSize).toBeLessThanOrEqual(500);
    expect(report.corpusPath).toContain("evaluation/fixtures/corpus.jsonl");
    expect(report.totals.fail).toBe(0);
    expect(report.totals.pass).toBe(report.corpusSize);
    expect(report.byDecisionClass.abort_definite.total).toBeGreaterThan(0);
    expect(report.byDecisionClass.probable.total).toBeGreaterThan(0);
    expect(report.byDecisionClass.forward.total).toBeGreaterThan(0);
    expect(report.byDecisionClass.infra_abort.total).toBeGreaterThan(0);
    for (const c of Object.values(report.byDecisionClass)) {
      expect(c.failRate).toBe(0);
      expect(c.passRate).toBe(1);
    }
  });
});
