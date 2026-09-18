import {
  decodeErrorResult,
  hexToString,
  type Hex,
  type Abi,
} from "viem";

/** Minimal common errors for decoding without full contract ABI. */
export const COMMON_ERRORS_ABI = [
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }],
  },
  {
    type: "error",
    name: "Panic",
    inputs: [{ name: "code", type: "uint256" }],
  },
] as const satisfies Abi;

const PANIC_REASONS: Record<number, string> = {
  0x00: "generic panic",
  0x01: "assert(false)",
  0x11: "arithmetic overflow/underflow",
  0x12: "division by zero",
  0x21: "invalid enum value",
  0x22: "storage encoding error",
  0x31: "pop on empty array",
  0x32: "array out of bounds",
  0x41: "too much memory",
  0x51: "uninitialized function pointer",
};

export interface DecodedRevert {
  reason: string;
  selector?: string;
  kind: "string" | "panic" | "custom" | "empty" | "unknown";
}

/**
 * Decode revert data from eth_call / eth_simulateV1.
 * Handles Error(string), Panic(uint256), empty, and raw custom selectors.
 */
export function decodeRevertData(data: Hex | undefined | null): DecodedRevert {
  if (!data || data === "0x" || data === "0x0") {
    return { reason: "execution reverted (no data)", kind: "empty" };
  }

  const selector = data.slice(0, 10).toLowerCase();

  // Error(string) — 0x08c379a0
  if (selector === "0x08c379a0") {
    try {
      const decoded = decodeErrorResult({
        abi: COMMON_ERRORS_ABI,
        data,
      });
      if (decoded.errorName === "Error") {
        return {
          reason: String(decoded.args[0]),
          selector,
          kind: "string",
        };
      }
    } catch {
      /* fall through */
    }
  }

  // Panic(uint256) — 0x4e487b71
  if (selector === "0x4e487b71") {
    try {
      const decoded = decodeErrorResult({
        abi: COMMON_ERRORS_ABI,
        data,
      });
      if (decoded.errorName === "Panic") {
        const code = Number(decoded.args[0]);
        const hint = PANIC_REASONS[code] ?? `panic code ${code}`;
        return {
          reason: `Panic(${code}): ${hint}`,
          selector,
          kind: "panic",
        };
      }
    } catch {
      /* fall through */
    }
  }

  if (data.length >= 10) {
    // Legacy: some nodes return ASCII in data
    try {
      const asText = hexToString(data as Hex);
      if (asText && /^[\x20-\x7E]+$/.test(asText)) {
        return { reason: asText, kind: "string" };
      }
    } catch {
      /* ignore */
    }

    return {
      reason: `custom error ${selector}`,
      selector,
      kind: "custom",
    };
  }

  return {
    reason: `execution reverted: ${data.slice(0, 66)}${data.length > 66 ? "…" : ""}`,
    selector: data.length >= 10 ? selector : undefined,
    kind: "unknown",
  };
}

/**
 * Extract revert hex from various JSON-RPC error shapes
 * (geth, erigon, OP, Arb, viem-style nested data).
 */
export function extractRevertHex(err: unknown): Hex | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;

  const candidates: unknown[] = [
    e.data,
    e.cause,
    (e.data as Record<string, unknown>)?.data,
    (e.data as Record<string, unknown>)?.result,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x")) {
      return c as Hex;
    }
    if (c && typeof c === "object") {
      const nested = c as Record<string, unknown>;
      if (typeof nested.data === "string" && nested.data.startsWith("0x")) {
        return nested.data as Hex;
      }
    }
  }

  if (typeof e.message === "string") {
    const m = e.message.match(/0x[0-9a-fA-F]{8,}/);
    if (m) return m[0] as Hex;
  }

  return undefined;
}
