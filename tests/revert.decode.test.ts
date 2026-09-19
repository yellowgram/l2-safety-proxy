import { describe, it, expect } from "vitest";
import { encodeErrorResult, encodeAbiParameters, parseAbiParameters } from "viem";
import {
  decodeRevertData,
  extractRevertHex,
  COMMON_ERRORS_ABI,
} from "../src/decode/revert.js";

describe("decodeRevertData", () => {
  it("decodes Error(string)", () => {
    const data = encodeErrorResult({
      abi: COMMON_ERRORS_ABI,
      errorName: "Error",
      args: ["insufficient balance"],
    });
    const d = decodeRevertData(data);
    expect(d.kind).toBe("string");
    expect(d.reason).toBe("insufficient balance");
    expect(d.selector).toBe("0x08c379a0");
  });

  it("decodes Panic(uint256) overflow", () => {
    const data = encodeErrorResult({
      abi: COMMON_ERRORS_ABI,
      errorName: "Panic",
      args: [0x11n],
    });
    const d = decodeRevertData(data);
    expect(d.kind).toBe("panic");
    expect(d.reason).toMatch(/overflow/i);
  });

  it.each([
    [0x01n, /assert/i],
    [0x12n, /division by zero/i],
    [0x32n, /out of bounds/i],
    [0x00n, /generic panic/i],
    [0x21n, /enum/i],
    [0x31n, /pop on empty/i],
    [0x41n, /memory/i],
    [0x51n, /uninitialized/i],
  ] as const)("decodes Panic code %s", (code, pattern) => {
    const data = encodeErrorResult({
      abi: COMMON_ERRORS_ABI,
      errorName: "Panic",
      args: [code],
    });
    const d = decodeRevertData(data);
    expect(d.kind).toBe("panic");
    expect(d.reason).toMatch(pattern);
  });

  it("unknown panic code falls back sensibly", () => {
    const data = encodeErrorResult({
      abi: COMMON_ERRORS_ABI,
      errorName: "Panic",
      args: [0x99n],
    });
    const d = decodeRevertData(data);
    expect(d.kind).toBe("panic");
    expect(d.reason).toMatch(/panic code 153|0x99|153/i);
  });

  it("handles empty revert", () => {
    expect(decodeRevertData("0x").kind).toBe("empty");
    expect(decodeRevertData(null).kind).toBe("empty");
  });

  it("labels custom selectors", () => {
    // Random 4-byte selector + padded arg
    const data =
      ("0x12345678" +
        encodeAbiParameters(parseAbiParameters("uint256"), [1n]).slice(
          2
        )) as `0x${string}`;
    const d = decodeRevertData(data);
    expect(d.kind).toBe("custom");
    expect(d.selector).toBe("0x12345678");
  });
});

describe("extractRevertHex", () => {
  it("pulls data from nested RPC error", () => {
    const hex = encodeErrorResult({
      abi: COMMON_ERRORS_ABI,
      errorName: "Error",
      args: ["nope"],
    });
    const err = { code: 3, message: "execution reverted", data: hex };
    expect(extractRevertHex(err)).toBe(hex);
  });

  it("pulls hex from message string", () => {
    const err = {
      message: "err: execution reverted: 0x08c379a00000000000000000000000000000000000000000000000000000000000000020",
    };
    const h = extractRevertHex(err);
    expect(h?.startsWith("0x08c379a0")).toBe(true);
  });
});
