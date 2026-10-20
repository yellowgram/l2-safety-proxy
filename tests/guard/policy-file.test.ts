/**
 * Policy file hygiene: a key written twice is refused (JSON.parse would silently keep the last
 * one), and the Universal Router recipient constants can't be listed as accounts or recipients.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPolicyFile } from "../../src/config/env.js";
import { duplicateJsonKeys, loadPolicyFile, parsePolicy, PolicyError } from "../../src/guard/policy/load.js";
import { ALLOWED, RECIPIENT } from "./helpers.js";

const DEX = "0x8888888888888888888888888888888888888888";
const file = (text: string) => {
  const f = join(mkdtempSync(join(tmpdir(), "l2sg-pf-")), "policy.json");
  writeFileSync(f, text);
  return f;
};
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts", ...args], { encoding: "utf8" });

describe("duplicate JSON keys", () => {
  it("finds a key repeated in one object, with its path, at any depth", () => {
    expect(duplicateJsonKeys(`{"destinations":{"${DEX}":{"type":"eoa"},"${DEX}":{"allowAnySelector":true}}}`)).toEqual([`destinations.${DEX}`]);
    expect(duplicateJsonKeys(`{"a":1,"a":2}`)).toEqual(["a"]);
    expect(duplicateJsonKeys(`{"tokens":{"t":{"transfer":{"recipients":[],"recipients":["x"]}}}}`)).toEqual(["tokens.t.transfer.recipients"]);
    expect(duplicateJsonKeys(`{"x":[{"k":1,"k":2},{"k":3}]}`)).toEqual(["x[].k"]);
  });
  it("does not flag the same key in different objects, keys inside strings, or escaped quotes", () => {
    expect(duplicateJsonKeys(`{"a":{"k":1},"b":{"k":1},"c":[{"k":1},{"k":2}]}`)).toEqual([]);
    expect(duplicateJsonKeys(`{"note":"\\"a\\":1,\\"a\\":2","a":["a","a"]}`)).toEqual([]);
    expect(duplicateJsonKeys(` { "a" : { } , "b" : [ ] } `)).toEqual([]);
    expect(duplicateJsonKeys(`{"a":"b","b":"a"}`)).toEqual([]);
    expect(duplicateJsonKeys(`{"destinations":{"x":{"note":"y"},"y":{"note":"x"}}}`)).toEqual([]);
  });
  const twice = `{"destinations":{"${DEX}":{"type":"eoa"},"${DEX}":{"allowAnySelector":true}}}`;
  it("loadPolicyFile and readPolicyFile refuse it, naming the key", () => {
    const f = file(twice);
    expect(() => loadPolicyFile(f)).toThrow(PolicyError);
    expect(() => loadPolicyFile(f)).toThrow(`policy file ${f}: "destinations.${DEX}" appears twice in the same object; JSON keeps only the last one. Merge the entries`);
    expect(() => readPolicyFile(f)).toThrow(`${f}: "destinations.${DEX}" appears twice in the same object`);
  });
  it("check-policy and migrate-policy refuse it", () => {
    const f = file(twice);
    const check = cli("check-policy", f);
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain(`"destinations.${DEX}" appears twice`);
    const migrate = cli("migrate-policy", f);
    expect(migrate.status).not.toBe(0);
    expect(migrate.stderr).toContain(`"destinations.${DEX}" appears twice`);
    expect(migrate.stdout).toBe("");
  }, 30_000);
  it("a file without duplicates still loads", () => {
    expect(loadPolicyFile(file(`{"destinations":{"${DEX}":{"type":"eoa"}}}`)).destinations.size).toBe(1);
  });
});

describe("migrate-policy from the command line", () => {
  it("refuses a 0.x file with an unknown key: non-zero exit, the reason, nothing on stdout", () => {
    const r = cli("migrate-policy", file(JSON.stringify({ destinations: { [ALLOWED]: {} }, newLimit: 5 })));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not converted: policy: unknown key "newLimit"');
    expect(r.stdout).toBe("");
  }, 30_000);
  it("converts a 1.x file, keeping its caps", () => {
    const r = cli("migrate-policy", file(JSON.stringify({ native: { maxPerTxWei: "5" }, destinations: { [ALLOWED]: {} } })));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ native: { maxPerTxWei: "5" }, destinations: { [ALLOWED]: { type: "eoa" } } });
    expect(r.stderr).toContain('no "selectors" list, which 1.x read as "any function"');
  }, 30_000);
});

describe("router recipient constants are not accounts", () => {
  const MSG_SENDER = "0x0000000000000000000000000000000000000001";
  const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
  it("refuses MSG_SENDER and ADDRESS_THIS in accounts and universalRouter.recipients", () => {
    expect(() => parsePolicy({ accounts: [MSG_SENDER] })).toThrow(`policy.accounts: ${MSG_SENDER} is a Universal Router recipient constant (MSG_SENDER), not an account. Remove it`);
    expect(() => parsePolicy({ accounts: [ADDRESS_THIS] })).toThrow("(ADDRESS_THIS)");
    expect(() => parsePolicy({ universalRouter: { recipients: [RECIPIENT, ADDRESS_THIS] } })).toThrow(`policy.universalRouter.recipients: ${ADDRESS_THIS} is a Universal Router recipient constant (ADDRESS_THIS)`);
    expect(() => parsePolicy({ universalRouter: { recipients: [MSG_SENDER.toUpperCase().replace("0X", "0x")] } })).toThrow("(MSG_SENDER)");
  });
  it("neighbouring addresses are fine", () => {
    expect(() => parsePolicy({ accounts: ["0x0000000000000000000000000000000000000003"], universalRouter: { recipients: [RECIPIENT] } })).not.toThrow();
  });
});
