/**
 * Evaluation harness types (offline / synthetic corpus).
 * Decision classes for weekly METRICS pass/fail rates.
 */

export type DecisionClass =
  | "abort_definite"
  | "probable"
  | "forward"
  | "infra_abort"
  | "policy_denied";

export type FixtureGuardMode = "open" | "strict";

export type SimKind =
  | "success"
  | "definite_revert"
  | "uncertain_revert"
  | "sim_failure"
  | "throw";

export type SimMethodHint = "eth_simulateV1" | "eth_call" | "unavailable";

export interface FixtureSim {
  kind: SimKind;
  method: SimMethodHint;
  reason?: string;
  /** Optional revert data hex for definite / uncertain reverts */
  rawData?: `0x${string}`;
}

export interface FixtureExpected {
  /** Metrics decision class */
  decisionClass: DecisionClass;
  /** Guard surface decision */
  decision: "abort" | "fail_open" | "forward" | "policy_denied";
  /** Whether eth_sendRawTransaction must reach upstream */
  forwarded: boolean;
}

export interface EvalFixture {
  id: string;
  chainKey: string;
  chainId: number;
  guardMode: FixtureGuardMode;
  /** Signed raw tx hex (synthetic / public anvil fixture — never broadcast) */
  rawTx: `0x${string}`;
  sim: FixtureSim;
  expected: FixtureExpected;
  tags?: string[];
  /**
   * When set, runner enables Layer 2 with this allowlist (lowercase addresses).
   * Empty array → deny all destinations (policy_denied before sim).
   */
  policyAllowlist?: string[];
}

export interface FixtureResult {
  id: string;
  pass: boolean;
  expected: FixtureExpected;
  actual: {
    decisionClass: DecisionClass;
    decision: string;
    forwarded: boolean;
    errorCode?: number;
    certainty?: string;
    confidence?: string;
    code?: string;
  };
  failReasons: string[];
}

export interface ClassStats {
  total: number;
  pass: number;
  fail: number;
  passRate: number;
  failRate: number;
}

export interface EvalReport {
  generatedAtEt: string;
  corpusPath: string;
  corpusSize: number;
  offline: true;
  liveBroadcast: false;
  durationMs: number;
  totals: {
    pass: number;
    fail: number;
    passRate: number;
    failRate: number;
  };
  byDecisionClass: Record<DecisionClass, ClassStats>;
  byGuardMode: Record<string, ClassStats>;
  byChain: Record<string, ClassStats>;
  failures: Array<{ id: string; reasons: string[] }>;
}
