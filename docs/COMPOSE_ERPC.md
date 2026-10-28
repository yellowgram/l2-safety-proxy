# Running behind eRPC (complementary, no rebuild)

`l2-send-guard` is a **policy guard**, not a load balancer. It sits between the caller and the
upstream RPC and checks each signed transaction before it is forwarded:

```text
client / agent  ->  L2 Send Guard  ->  eRPC  ->  Alchemy / public / other upstreams
```

The two tools solve different problems and are meant to be composed:

- **L2 Send Guard** does Layer 1 simulation-abort and optional Layer 2 policy (destination and
  selector allowlists, caps, approvals, Permit2, EIP-7702, batch unwrapping). It holds no keys and
  never retries a send.
- **eRPC** (or any similar reliability router) does multi-upstream failover, retries, caching and
  load balancing across providers.

So: **complement, do not rebuild.** Do not add eRPC as a dependency of the guard, and do not
rebuild failover, hedging or caching inside it. Point the guard's `L2SG_RPC_<NAME>` at the eRPC
endpoint and let each layer do its own job. (`L2SG_RPC_FALLBACK_<NAME>` is a second RPC used only
for simulation — it is not a substitute for eRPC's own failover.)

```yaml
# Sample-grade sketch only — not required for the offline demo or CI.
# The guard forwards to eRPC; eRPC fans out to the upstream providers.
# No third-party image is needed to run the guard itself (see docker-compose.yml).
services:
  l2-send-guard:
    build: .
    environment:
      L2SG_POLICY_FILE: /config/policy.json
      # Point at eRPC, not at a single provider. NAME is the chain name, e.g. BASE.
      L2SG_RPC_BASE: http://erpc:4000/main/evm/8453
    ports:
      - "127.0.0.1:8545:8545"
    volumes:
      - ./policy.json:/config/policy.json:ro
    depends_on:
      - erpc

  erpc:
    # Replace with your own eRPC deployment (container image or hosted endpoint).
    image: your-registry/erpc:latest
    # eRPC's config file lists the upstreams and the failover/caching policy.
    volumes:
      - ./erpc.yaml:/root/.config/erpc/erpc.yaml:ro
    ports:
      - "127.0.0.1:4000:4000"
```

See [README › Configuration](../README.md#configuration) for `L2SG_RPC_<NAME>` and
[README › Docker](../README.md#docker) for the standalone compose file that runs the guard alone.
