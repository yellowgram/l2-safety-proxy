import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from "viem";
import { recoverAuthorizationAddress } from "viem/utils";

export interface Authorization {
  /** Account whose code is being set (recovered from the authorization signature). */
  authority?: Address;
  /** Contract the authority delegates to. Zero address = remove delegation. */
  delegate: Address;
  chainId: number;
  nonce: number;
}

/** A signed transaction, parsed and with its sender recovered. Never needs a key. */
export interface SignedTx {
  raw: Hex;
  hash: Hex;
  type: string;
  chainId?: number;
  nonce?: number;
  from?: Address;
  to?: Address;
  value: bigint;
  data: Hex;
  gas?: bigint;
  authorizationList: Authorization[];
}

export class TxParseError extends Error {}

export async function parseSignedTx(raw: Hex): Promise<SignedTx> {
  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(raw);
  } catch (err) {
    throw new TxParseError(err instanceof Error ? err.message.split("\n")[0] : String(err));
  }
  let from: Address | undefined;
  try {
    from = await recoverTransactionAddress({ serializedTransaction: raw as never });
  } catch {
    from = undefined;
  }
  const authorizationList: Authorization[] = [];
  for (const a of (tx as { authorizationList?: unknown[] }).authorizationList ?? []) {
    const auth = a as { address: Address; chainId: number; nonce: number; r: Hex; s: Hex; yParity?: number; v?: bigint };
    let authority: Address | undefined;
    try {
      authority = await (recoverAuthorizationAddress as (p: { authorization: unknown }) => Promise<Address>)({ authorization: auth });
    } catch {
      authority = undefined;
    }
    authorizationList.push({ authority, delegate: auth.address, chainId: Number(auth.chainId), nonce: Number(auth.nonce) });
  }
  return {
    raw,
    hash: keccak256(raw),
    type: tx.type ?? "legacy",
    chainId: tx.chainId,
    nonce: tx.nonce,
    from,
    to: tx.to ?? undefined,
    value: tx.value ?? 0n,
    data: (tx.data as Hex | undefined) ?? "0x",
    gas: tx.gas,
    authorizationList,
  };
}
