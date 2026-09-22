import { describe, it, expect } from "vitest";
import { isGascapSplit } from "../scripts/gascap-split.mjs";

describe("isGascapSplit", () => {
  const cap = 100_000;

  it("true when call fails, estimate ok, gas > cap", () => {
    expect(
      isGascapSplit({ callOk: false, estimateOk: true, gas: 200_000, cap }),
    ).toBe(true);
  });

  it("false when call ok", () => {
    expect(
      isGascapSplit({ callOk: true, estimateOk: true, gas: 200_000, cap }),
    ).toBe(false);
  });

  it("false when estimate fails", () => {
    expect(
      isGascapSplit({ callOk: false, estimateOk: false, gas: null, cap }),
    ).toBe(false);
  });

  it("false when gas <= cap", () => {
    expect(
      isGascapSplit({ callOk: false, estimateOk: true, gas: 100_000, cap }),
    ).toBe(false);
    expect(
      isGascapSplit({ callOk: false, estimateOk: true, gas: 50_000, cap }),
    ).toBe(false);
  });

  it("false when gas missing", () => {
    expect(
      isGascapSplit({ callOk: false, estimateOk: true, gas: null, cap }),
    ).toBe(false);
  });
});
