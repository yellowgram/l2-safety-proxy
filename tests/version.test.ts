import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "../src/version.js";

describe("package version pin", () => {
  it("PACKAGE_VERSION matches package.json", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string;
    };
    expect(pkg.version).toBe(PACKAGE_VERSION);
    expect(PACKAGE_VERSION).toBe("0.5.0");
  });
});