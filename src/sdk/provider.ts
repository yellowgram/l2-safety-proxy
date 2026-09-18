/**
 * Thin RPC helpers so wallets / agents / bots can point at L2 Send Guard.
 *
 * No private-key custody — only URL + optional x-l2sg-chain header wiring.
 * Works with viem `http()` and ethers v6 `FetchRequest` / `JsonRpcProvider`
 * without bundling either library as a hard dependency of this package.
 */

/** Header the proxy uses to select a configured chain template. */
export const GUARD_CHAIN_HEADER = "x-l2sg-chain" as const;

export interface GuardProviderOptions {
  /** Proxy base URL, e.g. `http://127.0.0.1:8545` */
  proxyUrl: string;
  /**
   * Chain key (`arb-sepolia`, `base-sepolia`, `op-sepolia`) or numeric chain id.
   * Omitted → proxy default chain.
   */
  chain?: string;
  /** Extra headers merged after the chain header (caller wins on collisions). */
  headers?: Record<string, string>;
}

export interface GuardConnection {
  url: string;
  headers: Record<string, string>;
}

/** Normalize proxy URL (strip trailing slash) and build header map. */
export function createGuardConnection(
  opts: GuardProviderOptions
): GuardConnection {
  const url = opts.proxyUrl.replace(/\/+$/, "");
  if (!url) {
    throw new Error("proxyUrl is required");
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.chain != null && opts.chain !== "") {
    headers[GUARD_CHAIN_HEADER] = opts.chain;
  }
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers[k] = v;
    }
  }
  return { url, headers };
}

/**
 * `fetch` wrapper that injects guard headers on every request to the proxy.
 * Pass as `http(url, { fetch: createGuardFetch(opts) })` in viem, or use
 * standalone for raw JSON-RPC.
 */
export function createGuardFetch(
  opts: GuardProviderOptions
): typeof globalThis.fetch {
  const { url: proxyUrl, headers: guardHeaders } = createGuardConnection(opts);
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    // Only inject when talking to the proxy (or relative / empty → proxy)
    const abs =
      !target || target.startsWith("/")
        ? proxyUrl
        : target;
    const sameProxy =
      abs === proxyUrl ||
      abs.startsWith(proxyUrl + "/") ||
      abs.startsWith(proxyUrl + "?");
    const nextHeaders = new Headers(init?.headers);
    if (sameProxy || abs === target) {
      for (const [k, v] of Object.entries(guardHeaders)) {
        if (!nextHeaders.has(k)) nextHeaders.set(k, v);
      }
    }
    const nextInput =
      !target || target.startsWith("/")
        ? proxyUrl
        : input;
    return globalThis.fetch(nextInput as RequestInfo, {
      ...init,
      headers: nextHeaders,
    });
  };
}

/**
 * Args for viem `http(...viemHttpArgs(opts))`.
 *
 * @example
 * ```ts
 * import { createWalletClient, http } from "viem";
 * import { viemHttpArgs } from "l2-send-guard/sdk";
 *
 * const transport = http(
 *   ...viemHttpArgs({ proxyUrl: "http://127.0.0.1:8545", chain: "base-sepolia" })
 * );
 * ```
 */
export function viemHttpArgs(
  opts: GuardProviderOptions
): [
  string,
  { fetchOptions: { headers: Record<string, string> } },
] {
  const { url, headers } = createGuardConnection(opts);
  return [url, { fetchOptions: { headers } }];
}

/**
 * Connection info for ethers v6 `FetchRequest` + `JsonRpcProvider`.
 * Does not import ethers — apply headers yourself (see README).
 *
 * @example
 * ```ts
 * import { FetchRequest, JsonRpcProvider } from "ethers";
 * import { ethersV6Connection } from "l2-send-guard/sdk";
 *
 * const { url, headers } = ethersV6Connection({
 *   proxyUrl: "http://127.0.0.1:8545",
 *   chain: "arb-sepolia",
 * });
 * const req = new FetchRequest(url);
 * for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
 * const provider = new JsonRpcProvider(req);
 * ```
 */
export function ethersV6Connection(
  opts: GuardProviderOptions
): GuardConnection {
  return createGuardConnection(opts);
}

/**
 * Apply guard headers onto an ethers-like FetchRequest (`setHeader` API).
 * Safe no-op helper for apps that already constructed a FetchRequest.
 */
export function applyGuardHeaders(
  req: { setHeader: (name: string, value: string) => void },
  opts: Pick<GuardProviderOptions, "chain" | "headers">
): void {
  if (opts.chain != null && opts.chain !== "") {
    req.setHeader(GUARD_CHAIN_HEADER, opts.chain);
  }
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      req.setHeader(k, v);
    }
  }
}
