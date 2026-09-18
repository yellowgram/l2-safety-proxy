import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import {
  GUARD_CHAIN_HEADER,
  createGuardConnection,
  createGuardFetch,
  viemHttpArgs,
  ethersV6Connection,
  applyGuardHeaders,
} from "../src/sdk/index.js";

describe("sdk provider helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createGuardConnection strips trailing slash and sets chain header", () => {
    const c = createGuardConnection({
      proxyUrl: "http://127.0.0.1:8545/",
      chain: "base-sepolia",
    });
    expect(c.url).toBe("http://127.0.0.1:8545");
    expect(c.headers[GUARD_CHAIN_HEADER]).toBe("base-sepolia");
    expect(c.headers["content-type"]).toBe("application/json");
  });

  it("createGuardConnection omits chain header when unset", () => {
    const c = createGuardConnection({ proxyUrl: "http://127.0.0.1:8545" });
    expect(c.headers[GUARD_CHAIN_HEADER]).toBeUndefined();
  });

  it("createGuardConnection rejects empty proxyUrl", () => {
    expect(() => createGuardConnection({ proxyUrl: "" })).toThrow(/proxyUrl/);
  });

  it("viemHttpArgs returns url + fetchOptions.headers", () => {
    const [url, opts] = viemHttpArgs({
      proxyUrl: "http://127.0.0.1:8545",
      chain: "arb-sepolia",
    });
    expect(url).toBe("http://127.0.0.1:8545");
    expect(opts.fetchOptions.headers[GUARD_CHAIN_HEADER]).toBe("arb-sepolia");
  });

  it("ethersV6Connection matches createGuardConnection", () => {
    const a = ethersV6Connection({
      proxyUrl: "http://proxy",
      chain: "op-sepolia",
    });
    const b = createGuardConnection({
      proxyUrl: "http://proxy",
      chain: "op-sepolia",
    });
    expect(a).toEqual(b);
  });

  it("applyGuardHeaders calls setHeader", () => {
    const headers: Record<string, string> = {};
    applyGuardHeaders(
      { setHeader: (k, v) => { headers[k] = v; } },
      { chain: "base-sepolia", headers: { "x-custom": "1" } }
    );
    expect(headers[GUARD_CHAIN_HEADER]).toBe("base-sepolia");
    expect(headers["x-custom"]).toBe("1");
  });

  it("createGuardFetch injects x-l2sg-chain on proxy requests", async () => {
    const seen: Record<string, string | null> = {};
    const server = http.createServer((req, res) => {
      seen.chain = req.headers[GUARD_CHAIN_HEADER] ?? null;
      seen.ct = req.headers["content-type"] ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const proxyUrl = `http://127.0.0.1:${addr.port}`;

    const fetchGuard = createGuardFetch({
      proxyUrl,
      chain: "base-sepolia",
    });
    const res = await fetchGuard(proxyUrl, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
    });
    const json = await res.json();
    expect(json.result).toBe("0x1");
    expect(seen.chain).toBe("base-sepolia");

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("extra headers override defaults when provided last", () => {
    const c = createGuardConnection({
      proxyUrl: "http://127.0.0.1:8545",
      chain: "arb-sepolia",
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    expect(c.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(c.headers[GUARD_CHAIN_HEADER]).toBe("arb-sepolia");
  });
});
