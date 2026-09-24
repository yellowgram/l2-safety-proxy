import { describe, it, expect, vi } from "vitest";
import { handleRequest } from "../src/proxy/handler.js";
import type { GuardConfig } from "../src/types/index.js";
import { ERR_UNSIGNED_SEND_REFUSED } from "../src/types/index.js";
import { defaultSpendPolicy } from "../src/policy/index.js";

const config = (): GuardConfig => ({
  listenHost: "127.0.0.1",
  listenPort: 8545,
  guardMode: "open",
  failOpen: true,
    policy: defaultSpendPolicy(),
  defaultChain: "op-sepolia",
  chains: {
    "op-sepolia": {
      id: "op-sepolia",
      name: "OP Sepolia",
      chainId: 11155420,
      upstreamRpcUrl: "http://upstream-op",
      preferSimulateV1: true,
      ecosystem: "op-stack",
    },
  },
});

describe("unsigned send refusal (no key custody)", () => {
  it("rejects eth_sendTransaction with -32081 and does not forward", async () => {
    const forward = vi.fn();
    const simulate = vi.fn();
    const res = await handleRequest(
      config(),
      {
        jsonrpc: "2.0",
        id: 42,
        method: "eth_sendTransaction",
        params: [{ from: "0xabc", to: "0xdef", value: "0x0" }],
      },
      undefined,
      { forward, simulate }
    );
    expect(forward).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
    expect(res.error?.code).toBe(ERR_UNSIGNED_SEND_REFUSED);
    expect(res.error?.data).toMatchObject({
      l2SendGuard: true,
      refused: true,
      code: "UNSIGNED_SEND_REFUSED",
      useMethod: "eth_sendRawTransaction",
    });
    expect(res.error?.message).toMatch(/no key custody/i);
  });

  it("still forwards non-send methods on OP Sepolia", async () => {
    const forward = vi.fn(async (url: string) => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: url,
    }));
    const headers = new Headers({ "x-l2sg-chain": "op-sepolia" });
    const res = await handleRequest(
      config(),
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      headers,
      { forward }
    );
    expect(forward).toHaveBeenCalledWith(
      "http://upstream-op",
      expect.anything()
    );
    expect(res.result).toBe("http://upstream-op");
  });
});
