#!/usr/bin/env node
// Builds tests/fixtures/ur21-onchain.json from raw transaction dumps.
//
// The dumps are public mainnet transactions sent to the Universal Router 2.1.2
// deployments (addresses from Uniswap/universal-router deploy-addresses/*.json,
// commit 64027f3). They were read with eth_getBlockByNumber over public RPCs:
//   base     blocks 52861211-52861390  router 0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40
//   mainnet  blocks 26234827-26234862  router 0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85
//   arbitrum blocks 516644783-516645777 router 0x2d01411773c8C24805306E89A41F7855C3c4Fe65
//   optimism blocks 158455188-158456373 router 0xC09255D86DB563cBc11C2fCf4a0C512e160111B4
// and the receipt status came from eth_getTransactionReceipt.
//
// This script uses viem only, not the guard's own decoder, so the expected
// payees and hooks in the fixture are an independent reading of the calldata.
//
// usage: node scripts/ur21-fixtures.mjs <receipts.json> <chainId>:<router>:<dump.json> ...
import { readFileSync, writeFileSync } from "node:fs";
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, parseAbi, parseAbiParameters } from "viem";

const EXECUTE = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const P = (s) => parseAbiParameters(s);
const PK = "(address,address,uint24,int24,address)";
const PATHK = "(address,uint24,int24,address,bytes)";
const V4 = {
  0x06: `(${PK},bool,uint128,uint128,uint256,bytes)`,
  0x07: `(address,${PATHK}[],uint256[],uint128,uint128)`,
  0x08: `(${PK},bool,uint128,uint128,uint256,bytes)`,
  0x09: `(address,${PATHK}[],uint256[],uint128,uint128)`,
  0x0b: "address,uint256,bool",
  0x0c: "address,uint256",
  0x0e: "address,address,uint256",
  0x0f: "address,uint256",
  0x10: "address,address,uint256",
};
const ZERO = "0x0000000000000000000000000000000000000000";

const [receiptsFile, ...sets] = process.argv.slice(2);
const receipts = JSON.parse(readFileSync(receiptsFile, "utf8"));
const out = [];
for (const set of sets) {
  const [chainId, router, file] = set.split(":");
  for (const t of JSON.parse(readFileSync(file, "utf8"))) {
    const d = decodeFunctionData({ abi: EXECUTE, data: t.input });
    const canonical = encodeFunctionData({ abi: EXECUTE, functionName: "execute", args: d.args });
    const suffix = "0x" + t.input.slice(canonical.length);
    const from = t.from.toLowerCase();
    const who = (a) => { const x = a.toLowerCase(); return x === "0x0000000000000000000000000000000000000001" ? from : x === "0x0000000000000000000000000000000000000002" ? router.toLowerCase() : x; };
    const payees = new Set(), hooks = new Set(), permitTokens = new Set();
    const cmds = d.args[0].slice(2).match(/../g);
    cmds.forEach((c, i) => {
      const n = parseInt(c, 16) & 0x7f, inp = d.args[1][i];
      if (n === 0x00 || n === 0x01) payees.add(who(decodeAbiParameters(P("address,uint256,uint256,bytes,bool,uint256[]"), inp)[0]));
      else if (n === 0x08 || n === 0x09) payees.add(who(decodeAbiParameters(P("address,uint256,uint256,address[],bool,uint256[]"), inp)[0]));
      else if ([0x04, 0x05, 0x06, 0x07].includes(n)) payees.add(who(decodeAbiParameters(P("address,address,uint256"), inp)[1]));
      else if (n === 0x0b || n === 0x0c) payees.add(who(decodeAbiParameters(P("address,uint256"), inp)[0]));
      else if (n === 0x0a) permitTokens.add(decodeAbiParameters(P("((address,uint160,uint48,uint48),address,uint256),bytes"), inp)[0][0][0].toLowerCase());
      else if (n === 0x10) {
        const [acts, params] = decodeAbiParameters(P("bytes,bytes[]"), inp);
        (acts.slice(2).match(/../g) ?? []).forEach((a, j) => {
          const k = parseInt(a, 16), v = decodeAbiParameters(P(V4[k]), params[j]);
          if (k === 0x06 || k === 0x08) { if (v[0][0][4] !== ZERO) hooks.add(v[0][0][4].toLowerCase()); }
          if (k === 0x07 || k === 0x09) for (const pk of v[0][1]) if (pk[3] !== ZERO) hooks.add(pk[3].toLowerCase());
          if (k === 0x0e || k === 0x10) payees.add(who(v[1]));
          if (k === 0x0f) payees.add(from);
          if (!(k in V4)) throw new Error(`${t.hash}: V4 action ${a} not modelled`);
        });
      } else throw new Error(`${t.hash}: command ${c} not modelled`);
    });
    out.push({
      chainId: Number(chainId), router, block: t.block, hash: t.hash, status: receipts[t.hash].status,
      from: t.from, value: t.value, commands: d.args[0], suffix,
      payees: [...payees].sort(), hooks: [...hooks].sort(), permitTokens: [...permitTokens].sort(),
      input: t.input,
    });
  }
}
writeFileSync("tests/fixtures/ur21-onchain.json", JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${out.length} transactions`);
