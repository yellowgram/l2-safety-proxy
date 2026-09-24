/**
 * Process-lifetime send-decision counters for /health (and ops).
 * No PII / addresses — counts only.
 */

import type { GuardDecision } from "../types/index.js";

export interface DecisionCounters {
  abort: number;
  fail_open: number;
  forward: number;
  policy_denied: number;
  /** Non-send methods are not counted */
  totalSendDecisions: number;
}

const counters: DecisionCounters = {
  abort: 0,
  fail_open: 0,
  forward: 0,
  policy_denied: 0,
  totalSendDecisions: 0,
};

export function recordDecision(decision: GuardDecision): void {
  if (decision === "abort") counters.abort += 1;
  else if (decision === "fail_open") counters.fail_open += 1;
  else if (decision === "forward") counters.forward += 1;
  else if (decision === "policy_denied") counters.policy_denied += 1;
  else return;
  counters.totalSendDecisions += 1;
}

export function getDecisionCounters(): Readonly<DecisionCounters> {
  return { ...counters };
}

/** Test helper — reset between cases. */
export function resetDecisionCounters(): void {
  counters.abort = 0;
  counters.fail_open = 0;
  counters.forward = 0;
  counters.policy_denied = 0;
  counters.totalSendDecisions = 0;
}
