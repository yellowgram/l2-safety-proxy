import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPolicyDocument,
  checkPolicyText,
  isPoisonAddress,
  policyReportOk,
} from "../src/policy/check.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("policy:check rules", () => {
  it("treats repeated non-zero nibbles as poison and ignores the zero address", () => {
    expect(isPoisonAddress("0x1111111111111111111111111111111111111111")).toBe(true);
    expect(isPoisonAddress("0x2222222222222222222222222222222222222222")).toBe(true);
    expect(isPoisonAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(isPoisonAddress("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(isPoisonAddress("0x0000000000000000000000000000000000000001")).toBe(false);
  });

  it("agent example is schema-valid and poison-labeled", () => {
    const text = readFileSync(join(root, "policy.agent.example.json"), "utf8");
    const report = checkPolicyText(text);
    expect(report.schemaErrors).toEqual([]);
    expect(report.sanityErrors).toEqual([]);
    expect(report.poisons.length).toBeGreaterThan(0);
    expect(policyReportOk(report)).toBe(false);
  });

  it("clean fixture passes schema, sanity, and placeholder checks", () => {
    const text = readFileSync(join(root, "tests/fixtures/policy.clean.json"), "utf8");
    const report = checkPolicyText(text);
    expect(report.schemaErrors).toEqual([]);
    expect(report.sanityErrors).toEqual([]);
    expect(report.poisons).toEqual([]);
    expect(policyReportOk(report)).toBe(true);
  });

  it("rejects comments, bad addresses, and allowAnyDestination", () => {
    expect(checkPolicyText("{ enabled: true }").schemaErrors[0]).toMatch(/invalid JSON/i);
    const bad = checkPolicyDocument({
      enabled: true,
      allowAnyDestination: true,
      destinations: { "0xzzzz": {} },
    });
    expect(bad.schemaErrors.join(" ")).toMatch(/not a 0x/);
    expect(bad.sanityErrors.join(" ")).toMatch(/allowAnyDestination/);
  });
});
