import { toAccount } from "viem/accounts";
import { zeroAddress, type LocalAccount } from "viem";
import type { Guard } from "./guard.js";
import { checkTypedData } from "./typed.js";

export class GuardDenied extends Error {
  constructor(public code: string, reason: string, public path?: string) {
    super(`l2-send-guard denied (${code}): ${reason}${path ? ` at ${path}` : ""}`);
    this.name = "GuardDenied";
  }
}

/**
 * Wrap a viem account so the policy runs before anything leaves the signer.
 *
 * This is what makes the policy binding: if the agent only has this signer
 * (the key lives in another process, a KMS, or an enclave that exposes only
 * this wrapper), it can't sign a transaction the policy refuses, whichever
 * RPC it tries to broadcast through. Signing counts against the rolling caps,
 * so twenty "small" signatures can't be stockpiled and sent later.
 */
export function createGuardedSigner(account: LocalAccount, guard: Guard, opts: { chainId: number }): LocalAccount {
  const signed = toAccount({
    address: account.address,
    async signMessage(args) {
      return account.signMessage(args);
    },
    async signTransaction(tx, options) {
      const raw = await account.signTransaction(tx, options);
      const check = await guard.check(raw, { chainId: tx.chainId ?? opts.chainId });
      if (check.action === "deny") throw new GuardDenied(check.code, check.reason, check.path);
      return raw;
    },
    async signTypedData(typed) {
      const v = checkTypedData(guard.policy, typed as never, { chainId: opts.chainId });
      if (!v.allow) throw new GuardDenied(v.code!, v.reason!, v.path);
      return account.signTypedData(typed);
    },
  });
  if (account.signAuthorization) {
    const inner = account.signAuthorization.bind(account);
    (signed as LocalAccount).signAuthorization = async (auth) => {
      const delegate = (auth.address ?? (auth as { contractAddress?: string }).contractAddress ?? "").toLowerCase();
      const p = guard.policy.delegation;
      if (delegate !== zeroAddress) {
        if (Number(auth.chainId) === 0 && !p.allowAnyChain) throw new GuardDenied("AUTHORIZATION_ANY_CHAIN", "7702 authorization valid on every chain");
        if (p.mode === "deny" || !p.delegates.has(delegate)) throw new GuardDenied("AUTHORIZATION_DENIED", `delegate ${delegate} is not allowed`);
      }
      return inner(auth);
    };
  }
  return signed;
}
