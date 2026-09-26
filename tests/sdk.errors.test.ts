import { describe, it, expect } from "vitest";
import {
  ERR_CHAIN_MISMATCH,
  ERR_DEFINITE_REVERT,
  ERR_POLICY_DENIED,
  ERR_STRICT_UNCERTAIN,
  ERR_UNSIGNED_SEND_REFUSED,
  classifyGuardError,
  guardErrorCode,
  guardErrorData,
  isChainMismatchError,
  isDefiniteRevertError,
  isGuardAbortError,
  isPolicyDeniedError,
  isStrictUncertainError,
  isUnsignedSendRefusedError,
} from "../src/sdk/index.js";

describe("sdk typed guard errors", () => {
  it("classifies raw JSON-RPC error codes", () => {
    expect(isDefiniteRevertError({ code: ERR_DEFINITE_REVERT })).toBe(true);
    expect(isPolicyDeniedError({ code: ERR_POLICY_DENIED })).toBe(true);
    expect(isStrictUncertainError({ code: ERR_STRICT_UNCERTAIN })).toBe(true);
    expect(isUnsignedSendRefusedError({ code: ERR_UNSIGNED_SEND_REFUSED })).toBe(
      true
    );
    expect(isChainMismatchError({ code: ERR_CHAIN_MISMATCH })).toBe(true);
    expect(classifyGuardError({ code: ERR_CHAIN_MISMATCH })).toBe(
      "chain_mismatch"
    );
    expect(classifyGuardError({ code: ERR_POLICY_DENIED })).toBe(
      "policy_denied"
    );
    expect(classifyGuardError({ code: -32000 })).toBe("other");
  });

  it("unwraps viem-style .cause and ethers-style .error", () => {
    expect(
      guardErrorCode({ message: "x", cause: { code: ERR_DEFINITE_REVERT } })
    ).toBe(ERR_DEFINITE_REVERT);
    expect(
      isPolicyDeniedError({
        error: { code: ERR_POLICY_DENIED, data: { layer: 2 } },
      })
    ).toBe(true);
    expect(
      guardErrorData({
        code: ERR_POLICY_DENIED,
        data: { layer: 2, decision: "policy_denied" },
      })
    ).toEqual({ layer: 2, decision: "policy_denied" });
  });

  it("isGuardAbortError covers all intercept codes", () => {
    for (const code of [
      ERR_DEFINITE_REVERT,
      ERR_POLICY_DENIED,
      ERR_STRICT_UNCERTAIN,
      ERR_UNSIGNED_SEND_REFUSED,
      ERR_CHAIN_MISMATCH,
    ]) {
      expect(isGuardAbortError({ code })).toBe(true);
    }
    expect(isGuardAbortError({ code: -32603 })).toBe(false);
  });
});
