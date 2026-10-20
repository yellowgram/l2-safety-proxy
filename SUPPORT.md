# Support

l2-send-guard is MIT-licensed and free. Support is best-effort, with no SLA.

- **Bugs:** [open an issue](https://github.com/yellowgram/l2-safety-proxy/issues/new?template=bug_report.md)
  with the package version, Node version, OS, and the output of `npm test` and `npm run demo` (or the smallest
  offline repro you have). Never paste private keys, mnemonics or funded raw transactions.
- **Questions:** [Discussions](https://github.com/yellowgram/l2-safety-proxy/discussions).
- **Security problems:** privately, as described in [SECURITY.md](./SECURITY.md).

Bug reports without a repro get a `needs-repro` label and an automated comment listing what's missing. If the
label is still there after 14 days with no update, the issue is closed. Editing the issue to add the repro
removes the label; `keep-open` pauses the timer. Security reports are never closed this way.

Out of scope: key custody, hosted services, and smart-account modules (Safe / Zodiac / ERC-7579). See
[docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) for common errors.
