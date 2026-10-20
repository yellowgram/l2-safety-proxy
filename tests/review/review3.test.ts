import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { evaluateTx } from "../../src/guard/policy/evaluate.js";
import { parsePolicy } from "../../src/guard/policy/load.js";
import { parseSignedTx } from "../../src/guard/tx.js";
import { ATTACKER, sign } from "../guard/helpers.js";

const SAFE = "0x5555555555555555555555555555555555555555" as Address;
const execTx = (to: Address, data: Hex) => encodeFunctionData({
  abi: parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)"]),
  args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x"] });
const enableModule = encodeFunctionData({ abi: parseAbi(["function enableModule(address)"]), args: [ATTACKER] });
const addOwner = encodeFunctionData({ abi: parseAbi(["function addOwnerWithThreshold(address,uint256)"]), args: [ATTACKER, 1n] });

describe("example policy: shipped agent example policy", () => {
  it("PROBE-10 the agent's Safe cannot be told (via execTransaction) to enable a module or add an owner", async () => {
    const p = parsePolicy(JSON.parse(readFileSync("policy.agent.example.json", "utf8")));
    const out = [];
    for (const d of [enableModule, addOwner]) {
      const tx = await parseSignedTx(await sign({ to: SAFE, data: execTx(SAFE, d), chainId: 84532 }));
      out.push(evaluateTx(p, tx, { chainId: 84532, now: 1_000_000 }).allow);
    }
    expect(out).toEqual([false, false]);
  });
});
