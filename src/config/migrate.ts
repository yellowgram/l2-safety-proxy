import { parseEther } from "viem";

type Legacy = {
  enabled?: boolean;
  allowContractCreation?: boolean;
  allowAnyDestination?: boolean;
  globalMaxNativeWei?: string;
  globalMaxNativeEth?: string | number;
  destinations?: Record<string, { maxNativeWei?: string; maxNativeEth?: string | number; requireApproval?: boolean }>;
  chains?: Record<string, Omit<Legacy, "chains" | "humanGate" | "enabled">>;
  erc20RecipientCheck?: boolean;
  humanGate?: { mode?: string; notifyUrl?: string | null };
};

function wei(w?: string, e?: string | number): string | undefined {
  if (w !== undefined && `${w}` !== "") return BigInt(w).toString();
  if (e !== undefined && `${e}` !== "") return parseEther(`${e}`).toString();
  return undefined;
}

/**
 * Convert a 0.x policy file to the 1.0 format. Returns the new policy and notes about
 * what could not be carried over (printed to stderr by the CLI). Review the result:
 * 1.0 is stricter, and token rules have to be written by hand.
 */
export function migrateLegacyPolicy(old: Legacy): { policy: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  if (old.enabled === false) notes.push("the old file had enabled=false; in 1.0 a policy file is always enforced (use L2SG_POLICY=off for simulation only)");
  if (old.allowAnyDestination) notes.push("allowAnyDestination has no 1.0 equivalent: list the destinations you send to");
  if (old.humanGate?.notifyUrl) notes.push("humanGate.notifyUrl: set L2SG_ALERT_WEBHOOK (bypass alerts); denials are in the decision log");
  if (old.humanGate?.mode && old.humanGate.mode !== "stop") notes.push(`humanGate.mode=${old.humanGate.mode} is gone; denials always stop`);

  const destinations: Record<string, { maxNativeWei?: string; type?: "eoa"; note?: string }> = {};
  // 0.x refused sends to requireApproval destinations, so 1.0 must not allow them. If any listing
  // (base or a chain overlay) required approval, the address is left out entirely.
  const held = new Set<string>();
  const add = (src: Legacy["destinations"], where: string) => {
    for (const [a, d] of Object.entries(src ?? {})) {
      const key = a.toLowerCase();
      if (d?.requireApproval || held.has(key)) {
        if (d?.requireApproval) notes.push(`${where}${a}: requireApproval has no 1.0 equivalent; left out, so sends to it are still refused`);
        held.add(key);
        delete destinations[key];
        continue;
      }
      const cap = wei(d?.maxNativeWei, d?.maxNativeEth);
      const prev = destinations[key];
      if (prev && prev.maxNativeWei !== cap) {
        notes.push(`${a} has different caps per chain; kept the lower one`);
        const lower = [prev.maxNativeWei, cap].filter((x): x is string => x !== undefined).map(BigInt).sort((x, y) => (x < y ? -1 : 1))[0];
        destinations[key] = lower !== undefined ? { maxNativeWei: lower.toString(), type: "eoa" } : { type: "eoa" };
        continue;
      }
      destinations[key] = cap !== undefined ? { maxNativeWei: cap, type: "eoa" } : { type: "eoa" };
    }
  };
  add(old.destinations, "");
  let allowCreate = old.allowContractCreation === true;
  let maxPerTx = wei(old.globalMaxNativeWei, old.globalMaxNativeEth);
  for (const [chainKey, o] of Object.entries(old.chains ?? {})) {
    notes.push(`chains.${chainKey}: per-chain overlays are merged into one policy (1.0 has one policy per process; use "chains" to restrict chain ids)`);
    add(o.destinations, `chains.${chainKey}.`);
    if (o.allowContractCreation === true && !allowCreate) {
      notes.push(`chains.${chainKey}.allowContractCreation: only that chain allowed it; the merged policy denies contract creation (set allowContractCreation yourself if you need it)`);
    }
    if (o.allowContractCreation === false && allowCreate) {
      allowCreate = false;
      notes.push(`chains.${chainKey}.allowContractCreation=false: the merged policy denies contract creation everywhere`);
    }
    if (o.destinations && Object.keys(o.destinations).length > 0) {
      notes.push(`chains.${chainKey}.destinations are now allowed on every chain the policy covers; split into one proxy per chain if that's too wide`);
    }
    if (o.allowAnyDestination) notes.push(`chains.${chainKey}.allowAnyDestination has no 1.0 equivalent`);
    const c = wei(o.globalMaxNativeWei, o.globalMaxNativeEth);
    if (c !== undefined) maxPerTx = maxPerTx === undefined || BigInt(c) < BigInt(maxPerTx) ? c : maxPerTx;
  }
  if (Object.keys(destinations).length > 0) {
    notes.push(
      'destinations are written as "type": "eoa" (plain ETH transfers only). For a contract you call, replace it with a "selectors" list of the functions the agent may call'
    );
  }
  if (old.erc20RecipientCheck !== false) {
    notes.push('ERC-20 transfers now need a "tokens" entry per token (recipients and caps); none were generated');
  }
  const policy: Record<string, unknown> = {
    destinations,
    ...(maxPerTx !== undefined ? { native: { maxPerTxWei: maxPerTx } } : {}),
    ...(allowCreate ? { allowContractCreation: true } : {}),
    delegation: { mode: "deny" },
  };
  return { policy, notes };
}
