import type { Hex } from "viem";
import { parseSignedTx } from "../guard/tx.js";
import type { RpcCaller } from "./rpcClient.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/** State override map in the shape eth_call / eth_simulateV1 take: address → { code }. */
export type CodeOverrides = Record<string, { code: Hex }>;

export type DelegationPlan =
  | { kind: "none" }
  | { kind: "overrides"; overrides: CodeOverrides; applied: number; skipped: string[] }
  | { kind: "uncertain"; reason: string };

/**
 * What an EIP-7702 transaction's authorizations will do, as code overrides for simulation.
 *
 * On chain, each authorization in a type-4 tx sets the authority's code to the delegation
 * designator 0xef0100 ‖ delegate before the call runs, but only when its chain id is 0 or
 * this chain, and the authority's nonce equals the authorization nonce at that point.
 * The sender's own nonce is bumped first, so a self-sponsored authorization must carry
 * tx.nonce + 1. A delegate of the zero address clears the code. Authorizations that would
 * be skipped on chain are skipped here too, so the simulation runs the code that will run.
 */
export async function planDelegation(raw: Hex, chainId: number, call: RpcCaller): Promise<DelegationPlan> {
  let tx;
  try {
    tx = await parseSignedTx(raw);
  } catch (err) {
    return { kind: "uncertain", reason: `can't parse the 7702 authorization list: ${(err as Error).message}` };
  }
  if (tx.authorizationList.length === 0) return { kind: "none" };

  const overrides: CodeOverrides = {};
  const skipped: string[] = [];
  const expected = new Map<string, number>();
  const sender = tx.from?.toLowerCase();
  let applied = 0;

  for (const [i, a] of tx.authorizationList.entries()) {
    if (a.chainId !== 0 && a.chainId !== chainId) {
      skipped.push(`#${i}: chain ${a.chainId}`);
      continue;
    }
    if (!a.authority) {
      skipped.push(`#${i}: signature does not recover`);
      continue;
    }
    const who = a.authority.toLowerCase();
    let next = expected.get(who);
    if (next === undefined) {
      try {
        next = Number(BigInt((await call("eth_getTransactionCount", [who, "latest"])) as string));
      } catch (err) {
        return { kind: "uncertain", reason: `can't read the nonce of authority ${who}: ${(err as Error).message}` };
      }
      if (who === sender) next += 1;
    }
    if (a.nonce !== next) {
      skipped.push(`#${i}: nonce ${a.nonce}, authority is at ${next}`);
      expected.set(who, next);
      continue;
    }
    expected.set(who, next + 1);
    overrides[who] = { code: a.delegate.toLowerCase() === ZERO ? "0x" : (`0xef0100${a.delegate.slice(2).toLowerCase()}` as Hex) };
    applied += 1;
  }
  return { kind: "overrides", overrides, applied, skipped };
}

/** Returns 32 bytes holding 1: PUSH1 1 PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN. */
const PROBE_CODE = "0x600160005260206000f3" as Hex;
const PROBE_ADDRESS = "0x00000000000000000000000000000000000ff7a2";
const honorsOverrides = new Map<string, boolean>();

/**
 * Some nodes ignore eth_call's state-override argument instead of rejecting it, which
 * would simulate a 7702 tx without its delegation and report a confident wrong answer.
 * Probe once per upstream: give an empty address code that returns 1 and see if it does.
 */
export async function ethCallHonorsOverrides(call: RpcCaller, key: string): Promise<boolean> {
  const known = honorsOverrides.get(key);
  if (known !== undefined) return known;
  let ok = false;
  try {
    const out = (await call("eth_call", [{ to: PROBE_ADDRESS, data: "0x" }, "latest", { [PROBE_ADDRESS]: { code: PROBE_CODE } }])) as string;
    ok = typeof out === "string" && BigInt(out === "0x" ? 0 : out) === 1n;
  } catch {
    ok = false;
  }
  honorsOverrides.set(key, ok);
  return ok;
}

export function clearOverrideProbeCache(): void {
  honorsOverrides.clear();
}
