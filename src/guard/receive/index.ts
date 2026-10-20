import { decodeAbiParameters, encodeEventTopics, encodeFunctionData, pad, parseAbi, type Address, type Hex } from "viem";
import { EFFECTIVELY_UNLIMITED, PERMIT2_ABI, TOKEN_ABI } from "../abi.js";
import { permit2For } from "../policy/load.js";
import type { Policy } from "../policy/types.js";
import type { AssetRecord, GuardStore } from "../store/types.js";

const EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
]);
const PERMIT2_EVENTS = parseAbi([
  "event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration)",
  "event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)",
]);
export const TOPICS = {
  Transfer: encodeEventTopics({ abi: EVENTS, eventName: "Transfer" })[0],
  Approval: encodeEventTopics({ abi: EVENTS, eventName: "Approval" })[0],
  ApprovalForAll: encodeEventTopics({ abi: EVENTS, eventName: "ApprovalForAll" })[0],
  Permit2Approval: encodeEventTopics({ abi: PERMIT2_EVENTS, eventName: "Approval" })[0],
  Permit2Permit: encodeEventTopics({ abi: PERMIT2_EVENTS, eventName: "Permit" })[0],
};

const lc = (a: string) => a.toLowerCase();
const topicAddr = (t: Hex) => lc(`0x${t.slice(26)}`);

/**
 * Two addresses that share the first and last 4 hex characters but differ:
 * the shape of an address-poisoning lookalike (people and agents copy
 * addresses from history by checking only the ends).
 */
export function looksLike(a: string, b: string): boolean {
  const x = lc(a).slice(2);
  const y = lc(b).slice(2);
  return x !== y && x.slice(0, 4) === y.slice(0, 4) && x.slice(-4) === y.slice(-4);
}

/** Every address the policy trusts: the set a poisoner tries to imitate. */
export function trustedAddresses(policy: Policy, extra: Iterable<string> = []): Set<string> {
  const s = new Set<string>([...policy.destinations.keys(), ...policy.accounts, ...policy.delegation.delegates, ...policy.universalRouter.recipients]);
  for (const [t, r] of policy.tokens) {
    s.add(t);
    for (const a of [...r.transfer.recipients, ...r.approve.spenders, ...r.approve.operators]) s.add(a);
  }
  for (const a of extra) s.add(lc(a));
  return s;
}

export interface ReceiveRules {
  /** Agent addresses being watched. */
  agents: Set<string>;
  /** Senders you expect money from. Empty = don't judge senders. */
  expectedSenders?: Set<string>;
  /** Inbound token amounts at or below this many raw units are dust. Default 0 (only zero-value). */
  dustRaw?: bigint;
  /** Addresses a poisoner would imitate (default: everything in the policy). */
  trusted: Set<string>;
}

export type Finding =
  | { kind: "inbound"; asset: AssetRecord; poisoner?: string }
  | {
      kind: "approval";
      expected: boolean;
      unlimited: boolean;
      owner: string;
      spender: string;
      token: string;
      amount?: bigint;
      reason: string;
      /** Unsigned calldata that removes the approval. The guard never signs it. */
      revoke: { to: Address; data: Hex };
    };

export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  logIndex: Hex | number;
  blockNumber: Hex | number;
}

/** Turn one log into a finding (or nothing). Pure. */
export function classifyLog(log: RawLog, policy: Policy, rules: ReceiveRules, chainId: number): Finding | undefined {
  const t0 = log.topics[0];
  const emitter = lc(log.address);
  const id = `${chainId}:${log.transactionHash}:${Number(log.logIndex)}`;
  const permit2 = permit2For(policy, chainId);

  if (t0 === TOPICS.Transfer && log.topics.length >= 3) {
    const from = topicAddr(log.topics[1]!);
    const to = topicAddr(log.topics[2]!);
    const amount = log.topics.length === 4 ? 1n : (decodeAbiParameters([{ type: "uint256" }], log.data)[0] as bigint);
    if (rules.agents.has(to)) return inbound(id, emitter, from, amount, policy, rules);
    // Zero-value "transfer from the agent" to a lookalike: the other poisoning trick.
    if (rules.agents.has(from) && amount === 0n && [...rules.trusted].some((t) => looksLike(to, t))) {
      return { kind: "inbound", poisoner: to, asset: { assetKey: id, label: "toxic", reasons: ["zero_value_lookalike"], token: emitter, sender: from, amount: "0" } };
    }
    return undefined;
  }

  if (emitter === permit2 && (t0 === TOPICS.Permit2Approval || t0 === TOPICS.Permit2Permit) && log.topics.length === 4) {
    const owner = topicAddr(log.topics[1]!);
    if (!rules.agents.has(owner)) return undefined;
    const token = topicAddr(log.topics[2]!);
    const spender = topicAddr(log.topics[3]!);
    const amount = decodeAbiParameters([{ type: "uint160" }], log.data.slice(0, 66) as Hex)[0] as bigint;
    return approval(policy, owner, token, spender, amount, {
      to: permit2 as Address,
      data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "lockdown", args: [[{ token: token as Address, spender: spender as Address }]] }),
    });
  }

  if (t0 === TOPICS.Approval && log.topics.length >= 3) {
    const owner = topicAddr(log.topics[1]!);
    if (!rules.agents.has(owner)) return undefined;
    const spender = topicAddr(log.topics[2]!);
    if (log.topics.length === 4) {
      // ERC-721 single-token approval: tokenId is indexed.
      const ok = policy.tokens.get(emitter)?.approve.operators.has(spender) ?? false;
      return nftApproval(owner, emitter, spender, ok);
    }
    const amount = decodeAbiParameters([{ type: "uint256" }], log.data)[0] as bigint;
    if (amount === 0n) return undefined;
    return approval(policy, owner, emitter, spender, amount, {
      to: emitter as Address,
      data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [spender as Address, 0n] }),
    });
  }

  if (t0 === TOPICS.ApprovalForAll && log.topics.length === 3) {
    const owner = topicAddr(log.topics[1]!);
    if (!rules.agents.has(owner)) return undefined;
    const approved = decodeAbiParameters([{ type: "bool" }], log.data)[0] as boolean;
    if (!approved) return undefined;
    const operator = topicAddr(log.topics[2]!);
    return nftApproval(owner, emitter, operator, policy.tokens.get(emitter)?.approve.operators.has(operator) ?? false);
  }
  return undefined;
}

function inbound(id: string, token: string, from: string, amount: bigint, policy: Policy, rules: ReceiveRules): Finding {
  const reasons: string[] = [];
  let label: AssetRecord["label"] = "clear";
  let poisoner: string | undefined;
  if (!rules.trusted.has(from) && [...rules.trusted].some((t) => looksLike(from, t))) {
    reasons.push("lookalike_sender");
    label = "toxic";
    poisoner = from;
  }
  if (amount <= (rules.dustRaw ?? 0n)) {
    reasons.push("dust");
    label = "toxic";
  }
  if (!policy.tokens.has(token)) {
    reasons.push("unknown_token");
    if (label === "clear") label = "quarantine";
  }
  if (rules.expectedSenders && rules.expectedSenders.size > 0 && !rules.expectedSenders.has(from)) {
    reasons.push("unexpected_sender");
    if (label === "clear") label = "quarantine";
  }
  return { kind: "inbound", poisoner, asset: { assetKey: id, label, reasons, token, sender: from, amount: amount.toString() } };
}

function approval(policy: Policy, owner: string, token: string, spender: string, amount: bigint, revoke: { to: Address; data: Hex }): Finding {
  const rule = policy.tokens.get(token);
  const unlimited = amount >= EFFECTIVELY_UNLIMITED;
  const expected = !unlimited && !!rule && rule.approve.spenders.has(spender) && rule.approve.maxAmountRaw !== undefined && amount <= rule.approve.maxAmountRaw;
  const reason = expected
    ? "within policy"
    : unlimited
      ? `unlimited approval of ${token} to ${spender}`
      : !rule
        ? `approval on ${token}, which the policy doesn't list`
        : !rule.approve.spenders.has(spender)
          ? `${spender} is not an allowed spender`
          : `amount ${amount} is over the policy cap`;
  return { kind: "approval", expected, unlimited, owner, spender, token, amount, reason, revoke };
}

function nftApproval(owner: string, token: string, operator: string, ok: boolean): Finding {
  return {
    kind: "approval",
    expected: ok,
    unlimited: true,
    owner,
    spender: operator,
    token,
    reason: ok ? "listed operator" : `NFT approval to ${operator}, which the policy doesn't list`,
    revoke: { to: token as Address, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "setApprovalForAll", args: [operator as Address, false] }) },
  };
}

/** Minimal EIP-1193 provider (viem clients, ethers providers and window.ethereum all fit). */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WatchOptions {
  provider: Eip1193;
  store: GuardStore;
  policy: Policy;
  chainId: number;
  agents: Address[];
  expectedSenders?: Address[];
  dustRaw?: bigint;
  /** Blocks to wait before reading (reorg safety). Default 2. */
  confirmations?: number;
  /** Max blocks per eth_getLogs call. Default 2 000. */
  maxRange?: number;
  /** First block to scan when there is no saved cursor. Default: current head. */
  startBlock?: bigint;
  onFinding?: (f: Finding) => void | Promise<void>;
  /** Lock the agent's sends when an approval appears that the policy would never have allowed. Default true. */
  lockOnUnexpectedApproval?: boolean;
}

/**
 * Scan new blocks once: record inbound assets, mark poisoners (the send policy
 * then refuses them), and report approvals. Resumes from a cursor in the store.
 * Returns the last block scanned.
 */
export async function scanOnce(o: WatchOptions): Promise<bigint> {
  const agents = new Set(o.agents.map(lc));
  const rules: ReceiveRules = {
    agents,
    expectedSenders: new Set((o.expectedSenders ?? []).map(lc)),
    dustRaw: o.dustRaw,
    trusted: trustedAddresses(o.policy),
  };
  const cursorName = `watch:${o.chainId}:${[...agents].sort().join(",")}`;
  const head = BigInt((await o.provider.request({ method: "eth_blockNumber" })) as string) - BigInt(o.confirmations ?? 2);
  const saved = await o.store.getCursor(cursorName);
  let from = saved !== undefined ? BigInt(saved) + 1n : (o.startBlock ?? head);
  const max = BigInt(o.maxRange ?? 2000);
  const agentTopics = [...agents].map((a) => pad(a as Hex, { size: 32 }));
  const permit2 = permit2For(o.policy, o.chainId);

  while (from <= head) {
    const to = from + max - 1n < head ? from + max - 1n : head;
    const range = { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
    const queries = [
      { ...range, topics: [TOPICS.Transfer, null, agentTopics] },
      { ...range, topics: [[TOPICS.Transfer, TOPICS.Approval, TOPICS.ApprovalForAll], agentTopics] },
      { ...range, address: permit2, topics: [[TOPICS.Permit2Approval, TOPICS.Permit2Permit], agentTopics] },
    ];
    const seen = new Set<string>();
    for (const q of queries) {
      const logs = (await o.provider.request({ method: "eth_getLogs", params: [q] })) as RawLog[];
      for (const log of logs) {
        const k = `${log.transactionHash}:${Number(log.logIndex)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const f = classifyLog(log, o.policy, rules, o.chainId);
        if (!f) continue;
        if (f.kind === "inbound") {
          await o.store.putAsset(f.asset);
          if (f.poisoner) await o.store.addPoisoned(f.poisoner, `${f.asset.reasons.join(",")} in ${log.transactionHash}`);
        } else if (!f.expected && o.lockOnUnexpectedApproval !== false) {
          await o.store.lock(o.chainId, f.owner, `approval the policy would refuse appeared on-chain (${f.reason}, tx ${log.transactionHash})`, Math.floor(Date.now() / 1000));
        }
        await o.onFinding?.(f);
      }
    }
    await o.store.setCursor(cursorName, to.toString());
    from = to + 1n;
  }
  return head;
}

/** Poll `scanOnce` every `intervalMs` (default 15 s). Returns a stop function. Errors go to `onError`. */
export function watchInbound(o: WatchOptions & { intervalMs?: number; onError?: (e: unknown) => void }): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      await scanOnce(o);
    } catch (e) {
      o.onError?.(e);
    }
    if (!stopped) timer = setTimeout(tick, o.intervalMs ?? 15_000);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** For callers who track inbound funds by asset key: only `clear` assets may be moved. */
export async function maySpend(store: GuardStore, assetKey: string): Promise<{ allow: boolean; label: AssetRecord["label"]; reasons: string[] }> {
  const rec = await store.getAsset(assetKey);
  const label = rec?.label ?? "quarantine";
  return { allow: label === "clear", label, reasons: rec?.reasons ?? ["unknown_asset"] };
}

/** Operator decision after reviewing a quarantined asset. A reason is required and kept. */
export async function reclassify(store: GuardStore, assetKey: string, label: AssetRecord["label"], reason: string): Promise<AssetRecord> {
  if (!reason.trim()) throw new Error("reclassify needs a reason");
  const prev = await store.getAsset(assetKey);
  const rec: AssetRecord = { ...(prev ?? { reasons: [] }), assetKey, label, reasons: label === "clear" ? [] : (prev?.reasons ?? []), note: reason.trim() };
  await store.putAsset(rec);
  return rec;
}
