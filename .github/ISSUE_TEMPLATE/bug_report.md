---
name: Bug report
about: A defect in the proxy, simulation, policy, or docs — with an offline repro
title: "[bug] "
labels: bug
---

Issues without the repro block are labeled `needs-repro` and closed after 14 days without an update (`.github/workflows/repro-triage.yml`). Add the label `keep-open` to pause that. How-to questions belong in Discussions. Vulnerability reports do not belong here — see SECURITY.md.

**Pin**
- Package version or commit SHA (not `@latest`):
- Node version:
- OS:

**Setup**
- [ ] Proxy (`l2-send-guard serve`)
- [ ] Library (`createGuardedSigner` / `Guard`)

**Offline repro** (required)

```text
npm test:
npm run demo:
```

If the offline demo cannot run, say why. Do not substitute a public Sepolia log as the only repro.

**Redacted env booleans** (no URLs, no keys, no allowlist)

```text
GUARD_MODE=
policy file set (yes/no, or L2SG_POLICY=off)=
L2SG_STORE kind (file/postgres/memory)=
L2SG_HOST_IS_LOOPBACK=
```

**Expected**

**Actual** (include JSON-RPC `error.code` and `error.data.decision` / `policyCode` / `path` when present)

**Safety**
- Do not paste private keys, mnemonics, or funded raw transactions.
