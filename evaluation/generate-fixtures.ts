/**
 * Deterministic synthetic corpus generator (offline — no broadcast).
 * Writes evaluation/fixtures/corpus.jsonl
 *
 * Usage: npx tsx evaluation/generate-fixtures.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalFixture, DecisionClass, FixtureGuardMode, SimKind } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "fixtures", "corpus.jsonl");

/** Public Anvil #0 EIP-1559 raw (Arb Sepolia) — never fund / never live-send from harness */
const BASE_RAW =
  "0x02f86d83066eee80843b9aca00843b9aca008252089400000000000000000000000000000000000000018080c001a07eade7c743ff2ea60f61c687ccca4b77553a14de08378371ac40c7d52a8f1d74a06fed4faa592ac84bae32b9311844176fc059eb70057c18450d4310072a880629" as `0x${string}`;

/** Minimal Error(string) "eval-revert" encoding */
const REVERT_DATA =
  "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b6576616c2d726576657274000000000000000000000000000000000000000000" as `0x${string}`;

const CHAINS = [
  { chainKey: "arb-sepolia", chainId: 421614 },
  { chainKey: "op-sepolia", chainId: 11155420 },
  { chainKey: "base-sepolia", chainId: 84532 },
] as const;

type Scenario = {
  simKind: SimKind;
  method: "eth_simulateV1" | "eth_call" | "unavailable";
  guardMode: FixtureGuardMode;
  decisionClass: DecisionClass;
  decision: "abort" | "fail_open" | "forward" | "policy_denied";
  forwarded: boolean;
  tag: string;
  /** When set, Layer 2 enabled with this allowlist (deny if raw to not listed). */
  policyAllowlist?: string[];
};

/**
 * Target ~340 fixtures across classes including Layer 2 policy_denied (200–500 band).
 * Counts chosen for stable weekly METRICS denominators.
 */
const PLAN: Array<{ scenario: Scenario; count: number }> = [
  // abort_definite (~100)
  {
    count: 50,
    scenario: {
      simKind: "definite_revert",
      method: "eth_call",
      guardMode: "open",
      decisionClass: "abort_definite",
      decision: "abort",
      forwarded: false,
      tag: "definite-open",
    },
  },
  {
    count: 50,
    scenario: {
      simKind: "definite_revert",
      method: "eth_simulateV1",
      guardMode: "strict",
      decisionClass: "abort_definite",
      decision: "abort",
      forwarded: false,
      tag: "definite-strict",
    },
  },
  // probable (~90): fail_open + uncertain strict abort
  {
    count: 45,
    scenario: {
      simKind: "uncertain_revert",
      method: "eth_call",
      guardMode: "open",
      decisionClass: "probable",
      decision: "fail_open",
      forwarded: true,
      tag: "uncertain-open-failopen",
    },
  },
  {
    count: 45,
    scenario: {
      simKind: "uncertain_revert",
      method: "eth_call",
      guardMode: "strict",
      decisionClass: "probable",
      decision: "abort",
      forwarded: false,
      tag: "uncertain-strict-abort",
    },
  },
  // forward (~80)
  {
    count: 40,
    scenario: {
      simKind: "success",
      method: "eth_simulateV1",
      guardMode: "open",
      decisionClass: "forward",
      decision: "forward",
      forwarded: true,
      tag: "success-v1-open",
    },
  },
  {
    count: 40,
    scenario: {
      simKind: "success",
      method: "eth_call",
      guardMode: "strict",
      decisionClass: "forward",
      decision: "forward",
      forwarded: true,
      tag: "success-call-strict",
    },
  },
  // infra_abort (~40): sim failure / throw in strict only
  {
    count: 25,
    scenario: {
      simKind: "sim_failure",
      method: "unavailable",
      guardMode: "strict",
      decisionClass: "infra_abort",
      decision: "abort",
      forwarded: false,
      tag: "infra-sim-failure-strict",
    },
  },
  {
    count: 15,
    scenario: {
      simKind: "throw",
      method: "unavailable",
      guardMode: "strict",
      decisionClass: "infra_abort",
      decision: "abort",
      forwarded: false,
      tag: "infra-throw-strict",
    },
  },
  // policy_denied (~30): Layer 2 deny before sim (allowlist excludes fixture to=0x…0001)
  {
    count: 15,
    scenario: {
      simKind: "success",
      method: "eth_call",
      guardMode: "open",
      decisionClass: "policy_denied",
      decision: "policy_denied",
      forwarded: false,
      tag: "policy-denied-open",
      policyAllowlist: ["0x1111111111111111111111111111111111111111"],
    },
  },
  {
    count: 15,
    scenario: {
      simKind: "definite_revert",
      method: "eth_call",
      guardMode: "strict",
      decisionClass: "policy_denied",
      decision: "policy_denied",
      forwarded: false,
      tag: "policy-denied-strict",
      policyAllowlist: ["0x2222222222222222222222222222222222222222"],
    },
  },
];

function paddedId(n: number): string {
  return `fx-${String(n).padStart(4, "0")}`;
}

function variantRaw(id: string): `0x${string}` {
  // Keep parseable: reuse BASE_RAW; uniqueness via id hash in tags only.
  // Slight nonce nibble flip would break signature — harness mocks sim, so same raw is OK.
  void createHash("sha256").update(id).digest("hex");
  return BASE_RAW;
}

function buildFixtures(): EvalFixture[] {
  const out: EvalFixture[] = [];
  let n = 0;
  for (const { scenario, count } of PLAN) {
    for (let i = 0; i < count; i++) {
      n += 1;
      const chain = CHAINS[(n - 1) % CHAINS.length];
      const id = paddedId(n);
      const reason =
        scenario.simKind === "definite_revert"
          ? `eval definite revert ${id}`
          : scenario.simKind === "uncertain_revert"
            ? `eval uncertain revert ${id}`
            : scenario.simKind === "sim_failure"
              ? `eval sim failure ${id}`
              : scenario.simKind === "throw"
                ? `eval throw ${id}`
                : undefined;

      const fixture: EvalFixture = {
        id,
        chainKey: chain.chainKey,
        chainId: chain.chainId,
        guardMode: scenario.guardMode,
        rawTx: variantRaw(id),
        sim: {
          kind: scenario.simKind,
          method: scenario.method,
          ...(reason ? { reason } : {}),
          ...(scenario.simKind === "definite_revert" ||
          scenario.simKind === "uncertain_revert"
            ? { rawData: REVERT_DATA }
            : {}),
        },
        expected: {
          decisionClass: scenario.decisionClass,
          decision: scenario.decision,
          forwarded: scenario.forwarded,
        },
        tags: [scenario.tag, chain.chainKey, scenario.guardMode],
        ...(scenario.policyAllowlist
          ? { policyAllowlist: scenario.policyAllowlist }
          : {}),
      };
      out.push(fixture);
    }
  }
  return out;
}

function main() {
  const fixtures = buildFixtures();
  mkdirSync(dirname(OUT), { recursive: true });
  const body = fixtures.map((f) => JSON.stringify(f)).join("\n") + "\n";
  writeFileSync(OUT, body, "utf8");
  const byClass: Record<string, number> = {};
  for (const f of fixtures) {
    byClass[f.expected.decisionClass] =
      (byClass[f.expected.decisionClass] ?? 0) + 1;
  }
  console.log(`Wrote ${fixtures.length} fixtures → ${OUT}`);
  console.log("byDecisionClass:", byClass);
}

main();
