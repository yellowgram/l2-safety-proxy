import { describe, expect, it } from "vitest";
import { migrateLegacyPolicy } from "../src/config/migrate.js";
import { parsePolicy } from "../src/guard/policy/load.js";
import { evaluateTx } from "../src/guard/policy/evaluate.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const SENDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

function allows(policy: Record<string, unknown>, to: string, value = 1n) {
  return evaluateTx(parsePolicy(policy), { from: SENDER, to, value, data: "0x", authorizationList: [] } as never, { chainId: 421614 }).allow;
}

describe("migrate-policy (0.x → 1.0)", () => {
  it("keeps requireApproval destinations refused (0.x refused them)", () => {
    const { policy, notes } = migrateLegacyPolicy({ destinations: { [A]: {}, [B]: { requireApproval: true } } });
    expect(allows(policy, A)).toBe(true);
    expect(allows(policy, B)).toBe(false);
    expect(notes.join("\n")).toMatch(/requireApproval .*still refused/);
  });

  it("a chain overlay that requires approval removes the base listing", () => {
    const { policy } = migrateLegacyPolicy({ destinations: { [B]: {} }, chains: { "arb-sepolia": { destinations: { [B]: { requireApproval: true } } } } });
    expect(allows(policy, B)).toBe(false);
  });

  it("does not widen contract creation from one chain's overlay", () => {
    const { policy, notes } = migrateLegacyPolicy({ destinations: { [A]: {} }, chains: { "base-sepolia": { allowContractCreation: true } } });
    expect(policy.allowContractCreation).toBeUndefined();
    expect(notes.join("\n")).toMatch(/denies contract creation/);
  });

  it("keeps the lower cap and converts ETH amounts to wei", () => {
    const { policy } = migrateLegacyPolicy({ globalMaxNativeEth: "0.5", destinations: { [A]: { maxNativeEth: 0.1 } }, chains: { x: { destinations: { [A]: { maxNativeWei: "1000" } } } } });
    expect(policy.native).toEqual({ maxPerTxWei: "500000000000000000" });
    expect((policy.destinations as Record<string, { maxNativeWei?: string }>)[A]!.maxNativeWei).toBe("1000");
    parsePolicy(policy);
  });
});
