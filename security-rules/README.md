# Vendored security rule sets

These rules are fetched **once** and committed — not auto-refreshed on every
PR review. Live-fetching rule content on every scan would make results
non-deterministic across otherwise-identical runs, and would let a
compromised upstream registry inject rule changes with no review step. To
update, re-run the fetch commands below against a newer commit, diff the
result, and commit it as a deliberate, reviewable change.

## `gitleaks.toml`

gitleaks' own default ruleset (generic + provider-specific secret patterns).

- Source: https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml
- Fetched from commit: `b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b`
- Fetched: 2026-08-16

Refresh:
```bash
curl -fsSL https://raw.githubusercontent.com/gitleaks/gitleaks/<new-commit>/config/gitleaks.toml -o security-rules/gitleaks.toml
```

## `semgrep/javascript/`, `semgrep/typescript/`

Curated Node/TypeScript security-relevant rule directories, vendored directly
from Semgrep's open-source rules repository (the same repository the
`p/javascript`/`p/typescript` Semgrep Registry packs are built from). Vendoring
the directories directly — instead of referencing `p/javascript` live — means
scans never depend on network access to Semgrep's registry.

- Source: https://github.com/semgrep/semgrep-rules (`javascript/`, `typescript/`)
- Fetched from commit: `40b8c63f75dc7c22c8a77482d73bfb864b146f7e`
- Fetched: 2026-08-16
- Secret-pattern rules in these directories are intentionally still included by
  Semgrep at scan time (harmless overlap) — gitleaks is the dedicated secret
  scanner, but not excluding these costs nothing and keeps the vendor copy a
  faithful, unmodified mirror of the upstream directories.

Refresh:
```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/semgrep/semgrep-rules.git /tmp/semgrep-rules-src
cd /tmp/semgrep-rules-src && git checkout <new-commit> && git sparse-checkout set javascript typescript && cd -
rm -rf security-rules/semgrep/javascript security-rules/semgrep/typescript
cp -r /tmp/semgrep-rules-src/javascript security-rules/semgrep/javascript
cp -r /tmp/semgrep-rules-src/typescript security-rules/semgrep/typescript
rm -rf /tmp/semgrep-rules-src
```
