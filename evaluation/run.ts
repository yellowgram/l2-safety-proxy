/**
 * CLI: npm run eval
 * Offline corpus evaluation — no live RPC broadcast.
 */
import { runEval, renderMarkdown, DEFAULT_CORPUS } from "./runner.js";

const corpusArg = process.argv.find((a) => a.startsWith("--corpus="));
const corpusPath = corpusArg?.slice("--corpus=".length) || DEFAULT_CORPUS;

const { report } = await runEval({ corpusPath, writeReport: true });

console.log(renderMarkdown(report));
console.log(
  JSON.stringify(
    {
      corpusPath: report.corpusPath,
      corpusSize: report.corpusSize,
      passRate: report.totals.passRate,
      failRate: report.totals.failRate,
      byDecisionClass: Object.fromEntries(
        Object.entries(report.byDecisionClass).map(([k, v]) => [
          k,
          {
            n: v.total,
            passRate: v.passRate,
            failRate: v.failRate,
          },
        ])
      ),
    },
    null,
    2
  )
);

if (report.totals.fail > 0) {
  console.error(`\nEVAL FAIL: ${report.totals.fail}/${report.corpusSize} fixtures`);
  process.exit(1);
}
console.error(`\nEVAL PASS: ${report.totals.pass}/${report.corpusSize} fixtures`);
