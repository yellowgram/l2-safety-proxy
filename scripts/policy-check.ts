/**
 * policy:check — schema, fence sanity, and placeholder detection.
 *
 *   npm run policy:check
 *     Self-test used by CI. The shipped examples MUST still contain
 *     poison placeholders, and tests/fixtures/policy.clean.json MUST pass.
 *
 *   npm run policy:check -- ./policy.json
 *     Strict check of your file. Exit 1 if schema/sanity fails or
 *     0x1111…/0x2222… style placeholders remain.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPolicyText,
  policyReportOk,
  type PolicyCheckReport,
} from "../src/policy/check.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function load(path: string): PolicyCheckReport {
  const text = readFileSync(path, "utf8");
  return checkPolicyText(text);
}

function printReport(label: string, report: PolicyCheckReport): void {
  const schema = report.schemaErrors.length ? "FAIL" : "ok";
  const sanity = report.sanityErrors.length ? "FAIL" : "ok";
  const poison =
    report.poisons.length > 0 ? `present(${report.poisons.length})` : "none";
  console.log(`${label}: schema=${schema} sanity=${sanity} placeholders=${poison}`);
  for (const err of report.schemaErrors) console.log(`  schema: ${err}`);
  for (const err of report.sanityErrors) console.log(`  sanity: ${err}`);
  for (const addr of report.poisons) {
    console.log(`  placeholder: ${addr} (replace before enabling policy)`);
  }
}

function selfTest(): number {
  const example = load(join(root, "policy.agent.example.json"));
  const plain = load(join(root, "policy.example.json"));
  const clean = load(join(root, "tests/fixtures/policy.clean.json"));
  printReport("policy.agent.example.json", example);
  printReport("policy.example.json", plain);
  printReport("tests/fixtures/policy.clean.json", clean);

  const exampleOk =
    example.schemaErrors.length === 0 &&
    example.sanityErrors.length === 0 &&
    example.poisons.length > 0;
  const plainOk =
    plain.schemaErrors.length === 0 &&
    plain.sanityErrors.length === 0 &&
    plain.poisons.length > 0;
  const cleanOk = policyReportOk(clean);
  if (!exampleOk || !plainOk || !cleanOk) {
    console.error("policy:check self-test FAIL");
    return 1;
  }
  console.log("policy:check OK");
  return 0;
}

function strict(path: string): number {
  const abs = resolve(path);
  let report: PolicyCheckReport;
  try {
    report = load(abs);
  } catch (err) {
    console.error(
      `policy:check FAIL: cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }
  printReport(abs, report);
  if (!policyReportOk(report)) {
    console.error("policy:check FAIL — fix schema, fence flags, and placeholders before start");
    return 1;
  }
  console.log("policy:check OK");
  return 0;
}

const arg = process.argv.slice(2).find((a) => a !== "--");
const code = !arg || arg === "--self-test" ? selfTest() : strict(arg);
process.exit(code);
