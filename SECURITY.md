# Security

## Reporting a vulnerability

Please report privately through a
[GitHub Security Advisory](https://github.com/yellowgram/l2-safety-proxy/security/advisories/new). Don't open a
public issue, and don't include private keys or funded raw transactions. Include the version or commit, the
impact, and a repro that doesn't need a mainnet key. There is no bug bounty.

A policy bypass counts as a vulnerability: any signed transaction that moves value, grants an approval or
delegates the account in a way the policy should refuse, but is forwarded (or signed by the guarded signer).

## What the guard does and doesn't protect against

See [README: Threat model and limits](./README.md#threat-model-and-limits). In short: the proxy bounds what
untrusted software can send through it, and detects (then locks) sends that went around it. Only the guarded
signer, with the key held outside the agent's process, prevents a key holder from going around the policy.

## Deployment

- The proxy has no authentication. It listens on `127.0.0.1` by default. On `0.0.0.0` without a firewall or
  ACL, anyone who can reach it can broadcast through your upstream RPC. It warns when bound to a wildcard address.
- The state file holds idempotency keys, sent nonces and rolling-cap reservations, not secrets. It is created
  with mode `0600`.
- `/health` reports counts and settings, never policy addresses.
