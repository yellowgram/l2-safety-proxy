# Arbitrum Foundation Infra & Tools — traction prep

**Status: preparation only — do not apply yet.** This checklist is for a future
Arbitrum Foundation Infrastructure & Tools application after L2 Send Guard has
real, repeatable traction. An idea-stage application is not ready and is
expected to fail the late-development bar.

## Eligibility and timing notes

- [ ] Re-check the [Arbitrum Foundation grants page](https://arbitrum.foundation/grants)
      immediately before applying; the Foundation page is authoritative.
- [ ] Confirm that **Infrastructure & Tools** is accepting applications on a
      rolling basis and that this project still fits the active scope.
- [ ] Treat the published typical award as an **ARB range of 20,000–150,000
      ARB**, not as a promised award or a project budget. Do not invent a
      requested amount, milestones, or conversion to fiat here.
- [ ] Be prepared for KYC/KYB and any required checks for key team members and
      receiving-wallet controllers.
- [ ] Apply only after late development is demonstrated: a working public OSS
      release, Arbitrum usage, and credible testnet/mainnet readiness. The
      research pack explicitly says not to apply blind while the project is
      idea-stage.

These notes are based on the public [Foundation grants page](https://arbitrum.foundation/grants)
and the internal research pack at
`/workspace/blockchain/research/03-superchain-l2-safety-observability.md`.
The research pack records the rolling Infrastructure & Tools track, the
published ARB range, KYC/KYB expectations, and the late-development/traction
requirement. Verify all terms again before any application.

## Traction gates before an application

Do not start an application until the evidence below is true and can be
reproduced. These are project readiness gates, not promises by the Foundation.

- [ ] **OSS users:** at least two independent external teams or users are using
      the public package repeatedly, not just following the demo. Record the
      release, version, chain, and anonymized usage evidence where permission
      is not available.
- [ ] **Weekly simulations:** publish a multi-week trend of simulation volume
      on Arbitrum (with successes, definite blocks, and uncertain/fail-open
      outcomes). Keep raw counters or reproducible export notes so the number
      is auditable; do not count local mock tests as user traction.
- [ ] **Integrating teams:** at least two teams have a documented integration
      or recurring test deployment. If that is not yet true, the research pack
      identifies written paid-interest as a fallback signal—not a substitute
      for pretending the product has adoption.
- [ ] **Arbitrum Sepolia:** maintain a reproducible public-testnet demo with
      guarded sends, definite-revert aborts, decoded errors, and fail-open
      behavior for uncertainty.
- [ ] **Arbitrum One readiness:** complete a read-only/dry-run readiness review
      covering chain configuration, upstream RPC operations, monitoring,
      rollback, rate limits, security notes, and incident handling. No funding
      or broadcast is required to claim readiness.
- [ ] **No custody / honest safety claims:** confirm that signing stays with
      the user, the proxy accepts signed transactions only, and docs clearly
      distinguish simulation confidence from on-chain truth.

## Evidence pack to gather

- [ ] **Repo URL:** public GitHub URL, license, release/tag, commit used for
      the application, issue history, and contribution/adoption snapshot.
- [ ] **Demo:** short reproducible Arbitrum Sepolia walkthrough showing a
      definite revert blocked before broadcast and an uncertain case failing
      open. Include environment assumptions and no secrets.
- [ ] **BENCH:** [BENCH.md](../BENCH.md) with the mocked raw-vs-guarded
      methodology, cache behavior, and a clearly labeled latency snapshot.
- [ ] **SMOKE:** [docs/SMOKE.md](./SMOKE.md) with dated public-testnet health,
      read-RPC, guarded-send, and capability-cache results. Keep unfunded,
      non-broadcast safety constraints explicit.
- [ ] **ARCHITECTURE:** [ARCHITECTURE.md](../ARCHITECTURE.md) covering request
      flow, confidence model, simulation fallback, threat model, and no-key-
      custody boundary.
- [ ] **Traction appendix:** weekly simulation counts, active integrations,
      chain split, blocked/forwarded/uncertain rates, release history, and
      concise permissioned user feedback. Redact addresses, keys, and private
      business information.
- [ ] **Milestone plan:** a small number of measurable OSS and Arbitrum
      milestones with acceptance tests and links to the evidence above. Use
      the ARB range only as published context; do not fabricate a budget.

## Differentiation to preserve

L2 Send Guard is a thin, fail-open, multi-L2 pre-broadcast safety layer—not a
replacement RPC cloud: it differs from **OP Security Proxy** by supporting
Arbitrum plus OP/Base and native `eth_simulateV1`-aware routing rather than
being an OP-only clone; from **Tenderly** by being a small self-hostable RPC
middleware instead of a full simulation/DevOps suite; and from **eRPC** by
adding send-safety and confidence classification in front of a reliability
proxy rather than rebuilding failover or indexing.

## Explicit hold

**Do not apply yet.** No grant application should be submitted from this
checklist. Wait for the traction gates, assemble the evidence pack, re-check
the Foundation page and KYC/KYB requirements, and only then decide whether a
future application is warranted. Idea-stage work without late-development
evidence is not an acceptable application basis.
