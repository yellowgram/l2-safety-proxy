import {
  parseTransaction,
  type Hex,
  type TransactionSerializable,
} from "viem";

export interface ParsedSend {
  raw: Hex;
  tx: TransactionSerializable;
  fromHint?: Hex; // recovered later if needed; optional for eth_call
  to?: Hex;
  data?: Hex;
  value: bigint;
  gas?: bigint;
}

/**
 * Parse a signed raw tx (RLP / typed) without needing the private key.
 * We only read fields for simulation — never custody keys.
 */
export function parseRawTransaction(raw: Hex): ParsedSend {
  const tx = parseTransaction(raw);
  return {
    raw,
    tx,
    to: tx.to ?? undefined,
    data: (tx.data as Hex | undefined) ?? "0x",
    value: tx.value ?? 0n,
    gas: tx.gas,
  };
}
