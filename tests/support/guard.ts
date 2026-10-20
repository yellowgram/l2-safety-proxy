import { Guard } from "../../src/guard/guard.js";
import { parsePolicy } from "../../src/guard/policy/load.js";
import { MemoryStore } from "../../src/guard/store/memory.js";

/** A Guard over an in-memory store, for handler tests. */
export function guardWith(policy: unknown = {}, opts: Partial<ConstructorParameters<typeof Guard>[0]> = {}): Guard {
  return new Guard({ policy: parsePolicy(policy), store: new MemoryStore(), ...opts });
}
