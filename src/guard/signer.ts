import { toAccount } from "viem/accounts";
import { zeroAddress, type LocalAccount, type SignableMessage } from "viem";
import type { Guard } from "./guard.js";
import { checkTypedData } from "./typed.js";

export class GuardDenied extends Error {
  constructor(public code: string, reason: string, public path?: string) {
    super(`l2-send-guard denied (${code}): ${reason}${path ? ` at ${path}` : ""}`);
    this.name = "GuardDenied";
  }
}

export interface GuardedSignerOptions {
  chainId: number;
  /**
   * Plain messages (personal_sign / eth_sign) are refused by default: a signature over
   * 32 raw bytes can be a Safe owner approval of any Safe transaction (eth_sign, v > 30)
   * or an ERC-4337 UserOperation, which the policy never sees. Even a text message is
   * unsafe to allow blindly (its bytes can be ground to equal such a hash). Pass a
   * predicate to allow the specific messages your agent needs (for example a login text).
   */
  allowMessage?: (message: SignableMessage) => boolean;
}

/**
 * Wrap a viem account so the policy runs before anything leaves the signer.
 *
 * If the agent only has this signer (the key lives in another process, a KMS, or an
 * enclave that exposes only this wrapper), it can't sign a transaction, a token permit
 * or a 7702 authorization the policy refuses, whichever RPC it broadcasts through, and
 * it can't sign arbitrary messages unless you allow them. Signing counts against the
 * rolling caps, so twenty "small" signatures can't be stockpiled and sent later.
 */
export function createGuardedSigner(account: LocalAccount, guard: Guard, opts: GuardedSignerOptions): LocalAccount {
  const signed = toAccount({
    address: account.address,
    async signMessage(args) {
      if (!opts.allowMessage || !opts.allowMessage(args.message)) {
        throw new GuardDenied(
          "MESSAGE_SIGNING_DENIED",
          "signing plain messages is refused: a message signature can approve a Safe transaction or a UserOperation outside the policy. Pass allowMessage to allow specific messages"
        );
      }
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
      const authChain = Number(auth.chainId);
      if (authChain !== 0 && authChain !== opts.chainId) {
        throw new GuardDenied("AUTHORIZATION_WRONG_CHAIN", `7702 authorization is for chain ${authChain}, the signer is on ${opts.chainId}`);
      }
      if (delegate !== zeroAddress) {
        if (Number(auth.chainId) === 0 && !p.allowAnyChain) throw new GuardDenied("AUTHORIZATION_ANY_CHAIN", "7702 authorization valid on every chain");
        if (p.mode === "deny" || !p.delegates.has(delegate)) throw new GuardDenied("AUTHORIZATION_DENIED", `delegate ${delegate} is not allowed`);
      }
      return inner(auth);
    };
  }
  return signed;
}
