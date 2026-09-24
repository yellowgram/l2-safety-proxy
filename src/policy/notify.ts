import type { PolicyCheckInput, PolicyCheckResult, SpendPolicyConfig } from "./types.js";

/**
 * Fire-and-forget webhook on policy deny. Never blocks the send path.
 * Failures are swallowed (logged to stderr).
 */
export function notifyPolicyDenied(
  policy: SpendPolicyConfig,
  input: PolicyCheckInput,
  result: PolicyCheckResult
): void {
  const url = policy.humanGate.notifyUrl;
  if (!url || result.allow) return;
  const body = JSON.stringify({
    event: "l2sg.policy_denied",
    chainId: input.chainId,
    chainKey: input.chainKey,
    to: input.to ?? null,
    effectiveTo: result.effectiveTo ?? null,
    valueWei: input.value.toString(),
    policyCode: result.code,
    reason: result.reason,
  });
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(2_000),
  }).catch((err) => {
    console.warn(
      `[l2-send-guard] policy notify failed: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}
