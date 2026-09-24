import type { DecisionClass } from "./types.js";

/**
 * Map guard response metadata → weekly METRICS decision class.
 *
 * - abort_definite: definite revert blocked (-32080)
 * - probable: uncertain revert path (fail_open in open, or uncertain abort in strict)
 * - forward: sim success forwarded
 * - infra_abort: sim infra failure / throw aborted (strict) — not a decoded revert
 */
export function classifyDecision(meta: {
  decision?: string;
  certainty?: string;
  code?: string;
  simMethod?: string;
  confidence?: string;
}): DecisionClass {
  const decision = meta.decision ?? "";
  const code = meta.code ?? "";
  const certainty = meta.certainty ?? "";

  if (decision === "forward") return "forward";

  if (decision === "policy_denied") return "policy_denied";

  if (
    decision === "abort" &&
    (certainty === "definite" || code === "DEFINITE_REVERT")
  ) {
    return "abort_definite";
  }

  if (
    decision === "abort" &&
    (code === "SIM_FAILURE" ||
      meta.simMethod === "unavailable" ||
      meta.confidence === "unknown")
  ) {
    // Prefer infra when sim clearly failed; uncertain_revert stays probable below
    if (code === "SIM_FAILURE" || meta.simMethod === "unavailable") {
      return "infra_abort";
    }
  }

  if (decision === "fail_open") return "probable";

  if (decision === "abort" && code === "UNCERTAIN_REVERT") return "probable";

  if (decision === "abort" && certainty === "uncertain") {
    if (code === "SIM_FAILURE") return "infra_abort";
    return "probable";
  }

  // Fallback: treat unknown aborts as infra
  if (decision === "abort") return "infra_abort";

  return "probable";
}
