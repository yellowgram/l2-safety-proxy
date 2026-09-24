import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSpendPolicy } from "../src/policy/load.js";

const ENV_KEYS = [
  "L2SG_POLICY_ENABLED",
  "L2SG_POLICY_FILE",
  "L2SG_POLICY_ALLOWLIST",
  "L2SG_POLICY_GLOBAL_MAX_WEI",
  "L2SG_POLICY_ALLOW_ANY",
  "L2SG_POLICY_NOTIFY_URL",
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("loadSpendPolicy", () => {
  it("defaults to disabled", () => {
    const p = loadSpendPolicy();
    expect(p.enabled).toBe(false);
    expect(p.destinations.size).toBe(0);
  });

  it("enables from env allowlist", () => {
    process.env.L2SG_POLICY_ENABLED = "true";
    process.env.L2SG_POLICY_ALLOWLIST =
      "0x1111111111111111111111111111111111111111";
    process.env.L2SG_POLICY_GLOBAL_MAX_WEI = "1000";
    const p = loadSpendPolicy();
    expect(p.enabled).toBe(true);
    expect(p.globalMaxNativeWei).toBe(1000n);
    expect(
      p.destinations.has("0x1111111111111111111111111111111111111111")
    ).toBe(true);
  });

  it("loads JSON file and merges env override", () => {
    const path = join(tmpdir(), `l2sg-policy-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        enabled: true,
        globalMaxNativeWei: "500",
        destinations: {
          "0x2222222222222222222222222222222222222222": {
            maxNativeWei: "100",
          },
        },
      })
    );
    try {
      process.env.L2SG_POLICY_FILE = path;
      process.env.L2SG_POLICY_GLOBAL_MAX_WEI = "999";
      const p = loadSpendPolicy();
      expect(p.enabled).toBe(true);
      expect(p.globalMaxNativeWei).toBe(999n);
      expect(
        p.destinations.get("0x2222222222222222222222222222222222222222")
          ?.maxNativeWei
      ).toBe(100n);
    } finally {
      unlinkSync(path);
    }
  });
});
