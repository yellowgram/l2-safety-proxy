import { zeroAddress, type TypedDataDefinition } from "viem";
import { EFFECTIVELY_UNLIMITED, UINT160_MAX } from "./abi.js";
import { permit2For } from "./policy/load.js";
import type { DenyCode, Policy, Verdict } from "./policy/types.js";

interface Ctx {
  chainId: number;
  now?: number;
}

const lc = (a: unknown) => String(a).toLowerCase();

/** Safe transactions, Safe messages and ERC-4337 user operations. */
const TX_AUTHORIZING_TYPES = new Set(["SafeTx", "SafeMessage", "PackedUserOperation", "UserOperation"]);

/**
 * Judge an EIP-712 signature request (Permit2 permits, EIP-2612 and DAI permits)
 * with the same token rules as on-chain approvals. Off-chain permits are where
 * most token drains start, and they never pass through an RPC proxy, so this
 * belongs in the signer.
 */
export function checkTypedData(policy: Policy, typed: TypedDataDefinition, ctx: Ctx): Verdict {
  const spend = { native: 0n, tokens: new Map<string, bigint>() };
  const deny = (code: DenyCode, reason: string): Verdict => ({ allow: false, code, reason, spend });
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const domain = (typed.domain ?? {}) as { name?: string; chainId?: number | bigint; verifyingContract?: string };
  const msg = (typed.message ?? {}) as Record<string, unknown>;
  if (domain.chainId !== undefined && Number(domain.chainId) !== ctx.chainId) {
    return deny("CHAIN_NOT_ALLOWED", `typed data is for chain ${domain.chainId}, signer is on ${ctx.chainId}`);
  }

  const approve = (token: string, spender: string, amount: bigint, unlimitedAt: bigint): Verdict | undefined => {
    if (amount === 0n) return undefined;
    const rule = policy.tokens.get(token);
    if (!rule) return deny("TOKEN_NOT_ALLOWED", `${token} is not in the policy's tokens`);
    if (amount >= unlimitedAt) return deny("APPROVAL_UNLIMITED", `unlimited permit of ${token} to ${spender}`);
    if (!rule.approve.spenders.has(spender)) return deny("SPENDER_NOT_ALLOWED", `${spender} is not an allowed spender of ${token}`);
    if (rule.approve.maxAmountRaw === undefined || amount > rule.approve.maxAmountRaw) {
      return deny("APPROVAL_OVER_CAP", `permit of ${amount} ${token} to ${spender} is over its cap ${rule.approve.maxAmountRaw ?? "(none set)"}`);
    }
    spend.tokens.set(token, (spend.tokens.get(token) ?? 0n) + amount);
    return undefined;
  };
  const expiry = (e: unknown, what: string): Verdict | undefined => {
    const v = BigInt(e as bigint);
    return v !== 0n && v > BigInt(now + policy.permit2.maxExpirySeconds)
      ? deny("PERMIT2_EXPIRY_TOO_LONG", `${what} lasts until ${v}, beyond the policy's ${policy.permit2.maxExpirySeconds}s limit`)
      : undefined;
  };

  const isPermit2 = domain.name === "Permit2" && lc(domain.verifyingContract) === permit2For(policy, ctx.chainId);
  if (isPermit2) {
    const spender = lc(msg.spender);
    type D = { token: string; amount: bigint; expiration: bigint };
    type P = { token: string; amount: bigint };
    switch (typed.primaryType) {
      case "PermitSingle": {
        const d = msg.details as D;
        return expiry(d.expiration, "Permit2 permit") ?? approve(lc(d.token), spender, BigInt(d.amount), UINT160_MAX) ?? { allow: true, spend };
      }
      case "PermitBatch": {
        for (const d of msg.details as D[]) {
          const v = expiry(d.expiration, "Permit2 permit") ?? approve(lc(d.token), spender, BigInt(d.amount), UINT160_MAX);
          if (v) return v;
        }
        return { allow: true, spend };
      }
      case "PermitTransferFrom":
      case "PermitWitnessTransferFrom": {
        const p = msg.permitted as P;
        return expiry(msg.deadline, "Permit2 signature transfer") ?? approve(lc(p.token), spender, BigInt(p.amount), EFFECTIVELY_UNLIMITED) ?? { allow: true, spend };
      }
      case "PermitBatchTransferFrom":
      case "PermitBatchWitnessTransferFrom": {
        const e = expiry(msg.deadline, "Permit2 signature transfer");
        if (e) return e;
        for (const p of msg.permitted as P[]) {
          const v = approve(lc(p.token), spender, BigInt(p.amount), EFFECTIVELY_UNLIMITED);
          if (v) return v;
        }
        return { allow: true, spend };
      }
    }
    return deny("TYPED_DATA_UNKNOWN", `unknown Permit2 message type ${typed.primaryType}`);
  }

  if (typed.primaryType === "Permit" && domain.verifyingContract) {
    const token = lc(domain.verifyingContract);
    if ("allowed" in msg) {
      return msg.allowed === true
        ? deny("APPROVAL_UNLIMITED", `DAI-style permit grants ${lc(msg.spender)} unlimited ${token}`)
        : { allow: true, spend };
    }
    if ("value" in msg && "spender" in msg) {
      return approve(token, lc(msg.spender), BigInt(msg.value as bigint), EFFECTIVELY_UNLIMITED) ?? { allow: true, spend };
    }
  }

  // These authorize an on-chain transaction from a smart account. The policy can't see
  // what they execute, so they are refused even when allowUnknown is set.
  if (TX_AUTHORIZING_TYPES.has(String(typed.primaryType))) {
    return deny(
      "TYPED_DATA_AUTHORIZES_TX",
      `typed data ${typed.primaryType} authorizes a transaction from a smart account; send that transaction through the guard instead`
    );
  }
  if (policy.typedData.allowUnknown) return { allow: true, spend };
  return deny(
    "TYPED_DATA_UNKNOWN",
    `typed data ${typed.primaryType} (${domain.name ?? "no domain name"} at ${domain.verifyingContract ?? zeroAddress}) is not a known permit; set typedData.allowUnknown to sign other messages`
  );
}
