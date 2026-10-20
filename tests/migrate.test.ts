import { describe, expect, it } from "vitest";
import { MigrateError, migrateLegacyPolicy } from "../src/config/migrate.js";
import { parsePolicy, PolicyError } from "../src/guard/policy/load.js";
import { evaluateTx } from "../src/guard/policy/evaluate.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const SENDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

function allows(policy: Record<string, unknown>, to: string, value = 1n) {
  return evaluateTx(parsePolicy(policy), { from: SENDER, to, value, data: "0x", authorizationList: [] } as never, { chainId: 421614 }).allow;
}

describe("migrate-policy (0.x → 2.0)", () => {
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

describe("migrate-policy refuses what it can't carry over", () => {
  const refused = (input: unknown, msg: RegExp) => {
    expect(() => migrateLegacyPolicy(input)).toThrow(MigrateError);
    expect(() => migrateLegacyPolicy(input)).toThrow(msg);
  };
  it("unknown keys anywhere in a 0.x file, never dropped", () => {
    refused({ destinations: { [A]: {} }, someNewKey: true }, /^policy: unknown key "someNewKey" \(a 0\.x file has only: enabled, .*\)\. Nothing was converted/);
    refused({ destinations: { [A]: { maxNativeWei: "1", allowedMethods: ["0x12345678"] } } }, new RegExp(`^destinations\\.${A}: unknown key "allowedMethods"`));
    refused({ chains: { x: { destinations: { [A]: { maxNativeEth: 1, cap: 2 } } } }, destinations: { [A]: {} } }, new RegExp(`^chains\\.x\\.destinations\\.${A}: unknown key "cap"`));
    refused({ chains: { x: { humanGate: { mode: "stop" } } } }, /^chains\.x: unknown key "humanGate"/);
    refused({ humanGate: { mode: "stop", channel: "slack" } }, /^humanGate: unknown key "channel"/);
  });
  it("a destination only one chain's overlay allowed (it would become allowed on every chain)", () => {
    refused({ destinations: { [A]: {} }, chains: { "arb-sepolia": { destinations: { [B]: { maxNativeWei: "5" } } } } }, new RegExp(`^chains\\.arb-sepolia\\.destinations\\.${B}: only chain "arb-sepolia" allows this destination`));
  });
  it("a file mixing 0.x keys with the 2.0 format", () => {
    refused({ globalMaxNativeWei: "1", native: { maxPerTxWei: "1" } }, /^policy: mixes 0\.x keys \(globalMaxNativeWei\)/);
  });
  it("amounts that aren't amounts", () => {
    refused({ destinations: { [A]: { maxNativeEth: "lots" } } }, new RegExp(`^destinations\\.${A}: not an amount: "lots"`));
  });
  it("unknown keys in a 1.x file (the result is checked like any policy file)", () => {
    expect(() => migrateLegacyPolicy({ native: { maxPerTxWei: "1", maxPerDayWei: "2" }, destinations: {} })).toThrow(PolicyError);
    expect(() => migrateLegacyPolicy({ native: { maxPerTxWei: "1" }, destinations: {}, extra: 1 })).toThrow(/unknown key "extra"/);
  });
});

describe("migrate-policy carries every 1.x limit across", () => {
  const ROUTER = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
  const TOKEN = "0x3333333333333333333333333333333333333333";
  const SAFE = "0x9999999999999999999999999999999999999999";
  const v1 = {
    chains: [421614],
    window: { seconds: 600 },
    native: { maxPerTxWei: "100000000000000000", windowMaxWei: "500000000000000000" },
    destinations: { [ROUTER]: { selectors: ["execute(bytes,bytes[],uint256)"], maxNativeWei: "7" }, [A]: { maxNativeWei: "1000", note: "payee" }, [B]: {} },
    tokens: { [TOKEN]: { transfer: { recipients: [B], maxAmountRaw: "10" }, approve: { spenders: [ROUTER], maxAmountRaw: "20" }, windowMaxAmountRaw: "30" } },
    accounts: [SAFE],
    universalRouter: { recipients: [B] },
    delegation: { mode: "deny" },
    allowContractCreation: false,
    typedData: { allowUnknown: false },
  };
  it("keeps chains, window, native caps, tokens, accounts, recipients and per-destination caps exactly", () => {
    const { policy, notes } = migrateLegacyPolicy(v1);
    const { destinations, ...rest } = policy;
    const { destinations: oldDestinations, ...oldRest } = v1;
    expect(rest).toEqual(oldRest);
    expect(destinations).toEqual({
      [ROUTER]: oldDestinations[ROUTER],
      [A]: { maxNativeWei: "1000", note: "payee", type: "eoa" },
      [B]: { type: "eoa" },
    });
    expect(notes).toEqual([
      `${A}, ${B}: no "selectors" list, which 1.x read as "any function". Written as "type": "eoa" (plain ETH transfers only). For a contract the agent calls, replace that with a "selectors" list (or "allowAnySelector": true to keep the 1.x behaviour, with a warning)`,
    ]);
    expect(v1.destinations[B]).toEqual({}); // the input is not modified
  });
  it("the converted policy denies what 1.x denied and never allows more", () => {
    const p = parsePolicy(migrateLegacyPolicy(v1).policy);
    expect(p.native.maxPerTxWei).toBe(10n ** 17n);
    expect(p.tokens.get(TOKEN)!.windowMaxAmountRaw).toBe(30n);
    expect(p.accounts.has(SAFE)).toBe(true);
    expect(evaluateTx(p, { from: SENDER, to: A, value: 1001n, data: "0x", authorizationList: [] } as never, { chainId: 421614 }).code).toBe("OVER_CAP");
    expect(evaluateTx(p, { from: SENDER, to: B, value: 1n, data: "0xdeadbeef", authorizationList: [] } as never, { chainId: 421614 }).allow).toBe(false);
    expect(evaluateTx(p, { from: SENDER, to: B, value: 1n, data: "0x", authorizationList: [] } as never, { chainId: 1 }).code).toBe("CHAIN_NOT_ALLOWED");
  });
  it("a file already in the 2.0 format comes back unchanged", () => {
    const v2 = migrateLegacyPolicy(v1).policy;
    expect(migrateLegacyPolicy(v2)).toEqual({ policy: v2, notes: ["already in the 2.0 format; nothing changed"] });
  });
});
