import type { Hex } from "viem";
import type { RpcCaller } from "./rpcClient.js";
import type { ParsedSend } from "./txParse.js";
import { decodeRevertData, extractRevertHex } from "../decode/revert.js";
import type { SimResult } from "../types/index.js";

/**
 * Prefer eth_simulateV1 (EIP-simulation / Flashblocks-aware on Base).
 * Spec shape (pragmatic subset):
 *   eth_simulateV1([{ blockStateCalls: [{ calls: [{ from, to, data, value, gas }] }],
 *                     traceTransfers: false, validation: true }], "latest")
 *
 * Returns null if method is unsupported so caller can fall back.
 */
export async function simulateV1(
  call: RpcCaller,
  parsed: ParsedSend,
  from: Hex
): Promise<SimResult | null> {
  const callObj: Record<string, string> = {
    from,
    data: parsed.data ?? "0x",
    value: `0x${parsed.value.toString(16)}`,
  };
  if (parsed.to) callObj.to = parsed.to;
  if (parsed.gas) callObj.gas = `0x${parsed.gas.toString(16)}`;

  const params = [
    [
      {
        blockStateCalls: [{ calls: [callObj] }],
        traceTransfers: false,
        validation: true,
      },
    ],
    "latest",
  ];

  try {
    const result = (await call("eth_simulateV1", params)) as unknown;
    return interpretSimulateV1(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Method not found / unsupported → signal fallback
    if (
      /method not found|not supported|does not exist|-32601/i.test(msg) ||
      (err as { code?: number }).code === -32601
    ) {
      return null;
    }
    // Other errors: treat as sim failure (uncertain)
    const hex = extractRevertHex(err);
    if (hex) {
      const decoded = decodeRevertData(hex);
      return {
        ok: false,
        method: "eth_simulateV1",
        confidence: "definite",
        reason: decoded.reason,
        rawData: hex,
        code: "DEFINITE_REVERT",
      };
    }
    return {
      ok: false,
      method: "eth_simulateV1",
      confidence: "uncertain",
      reason: `eth_simulateV1 error: ${msg}`,
      code: "SIM_FAILURE",
    };
  }
}

function interpretSimulateV1(result: unknown): SimResult {
  // Expected: array of block results → calls[] with status / error / returnData
  if (!Array.isArray(result) || result.length === 0) {
    return {
      ok: false,
      method: "eth_simulateV1",
      confidence: "uncertain",
      reason: "eth_simulateV1 returned empty/unexpected shape",
      code: "SIM_FAILURE",
    };
  }

  const block = result[0] as Record<string, unknown>;
  const calls = (block.calls ?? block.results ?? []) as Array<
    Record<string, unknown>
  >;
  if (!Array.isArray(calls) || calls.length === 0) {
    // Some implementations return status at block level
    if (block.error) {
      const errObj = block.error as Record<string, unknown>;
      const data =
        typeof errObj.data === "string"
          ? (errObj.data as Hex)
          : undefined;
      const decoded = decodeRevertData(data);
      return {
        ok: false,
        method: "eth_simulateV1",
        confidence: "definite",
        reason:
          typeof errObj.message === "string"
            ? errObj.message
            : decoded.reason,
        rawData: data,
        code: "DEFINITE_REVERT",
      };
    }
    return {
      ok: true,
      method: "eth_simulateV1",
      confidence: "definite",
    };
  }

  const first = calls[0]!;
  const status = first.status ?? first.error;
  const returnData = (first.returnData ?? first.data) as Hex | undefined;
  const gasUsed = first.gasUsed
    ? BigInt(first.gasUsed as string)
    : undefined;

  // status 0 / "0x0" / error present → revert
  const reverted =
    first.error != null ||
    status === 0 ||
    status === "0x0" ||
    status === false ||
    (typeof first.status === "string" &&
      first.status.toLowerCase() === "0x0");

  if (reverted) {
    let reason = "execution reverted";
    let rawData: Hex | undefined = returnData;
    if (first.error && typeof first.error === "object") {
      const e = first.error as Record<string, unknown>;
      if (typeof e.message === "string") reason = e.message;
      if (typeof e.data === "string") rawData = e.data as Hex;
    } else if (typeof first.error === "string") {
      reason = first.error;
    }
    if (rawData) {
      const decoded = decodeRevertData(rawData);
      reason = decoded.reason;
    }
    return {
      ok: false,
      method: "eth_simulateV1",
      confidence: "definite",
      reason,
      rawData,
      code: "DEFINITE_REVERT",
      gasUsed,
    };
  }

  return {
    ok: true,
    method: "eth_simulateV1",
    confidence: "definite",
    gasUsed,
  };
}
