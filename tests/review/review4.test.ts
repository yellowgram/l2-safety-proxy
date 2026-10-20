import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { Guard } from "../../src/guard/guard.js";
import { createGuardedSigner } from "../../src/guard/signer.js";
import { MemoryStore } from "../../src/guard/store/memory.js";
import { agent, basePolicy, CHAIN } from "../guard/helpers.js";

describe("signer: guarded signer", () => {
  it("PROBE-11 refuses to sign a raw 32-byte hash via signMessage (a Safe eth_sign owner signature / 4337 userOpHash)", async () => {
    const g = new Guard({ policy: basePolicy({ accounts: ["0x5555555555555555555555555555555555555555"] }), store: new MemoryStore() });
    const s = createGuardedSigner(agent, g, { chainId: CHAIN });
    const safeTxHash = keccak256(toHex("any SafeTx the policy would refuse"));
    let signed = false;
    try { await s.signMessage({ message: { raw: safeTxHash } }); signed = true; } catch { signed = false; }
    expect(signed).toBe(false);
  });
});
