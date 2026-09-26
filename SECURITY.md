# Security

L2 Send Guard is a local JSON-RPC proxy for **testnet** sends (Arbitrum Sepolia, OP Sepolia, Base Sepolia). It does not custody keys. It is not a mainnet SLA, a hosted service, or a Safe.

## Reporting a vulnerability

Do not open a public GitHub Issue for a vulnerability, and do not paste a funded raw transaction or a private key.

This repository does not publish a security email. Report privately with a [GitHub Security Advisory](https://github.com/yellowgram/l2-safety-proxy/security/advisories/new) on `yellowgram/l2-safety-proxy`.

Include the package version or commit, impact, and a repro that does not require a mainnet key. There is no bug-bounty program in this repo.

## Bind

The default listen address is `127.0.0.1`. Binding `0.0.0.0` without an ACL makes the proxy an unauthenticated forwarder onto your upstream RPC. The process prints a warning when it binds a wildcard address.
