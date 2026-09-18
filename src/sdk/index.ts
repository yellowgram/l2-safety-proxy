/**
 * Client SDK — point wallets / agents at the L2 Send Guard proxy.
 * See ./README.md for viem + ethers v6 usage.
 */
export {
  GUARD_CHAIN_HEADER,
  createGuardConnection,
  createGuardFetch,
  viemHttpArgs,
  ethersV6Connection,
  applyGuardHeaders,
  type GuardProviderOptions,
  type GuardConnection,
} from "./provider.js";
