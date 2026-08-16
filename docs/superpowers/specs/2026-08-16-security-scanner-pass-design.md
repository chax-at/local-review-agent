# Security scanner pass (Semgrep + gitleaks) — design

Date: 2026-08-16
Status: approved (design discussed and accepted in review session)

## Problem

The `security` (and `generic`) personas currently rely entirely on an LLM reading
the diff to spot injection, secret exposure, unsafe crypto, etc. (`personas.ts`,
`PERSONA_DIRECTIVES.security`). LLM review has no deterministic pattern-matching
backstop: it can miss well-known vulnerable code patterns a SAST rule would catch
outright, and it has no dedicated secret-detection pass at all — a committed API
key or token is just another diff line unless the model happens to notice it.

A prior attempt at deterministic scanning would naively re-scan the whole repo
every cycle, which starves the point of this: the reviewer would re-report the
same pre-existing issue on every single PR, forever, since nothing tracks "already
seen." Any scanner added here must be scoped to *only what changed in this PR*.

## Decision

Run **one static-analysis pass per PR**, before the review loop, using two
host-installed, non-LLM tools:

- **Semgrep** (SAST) — `semgrep --config <vendored-rules-dir> --baseline-commit=origin/<targetBranch> --json <repoDir>`.
  Semgrep's own diff-aware mode (`--baseline-commit`) accepts any git ref and
  filters output to findings introduced since it, so pre-existing issues in the
  target branch never resurface.
- **gitleaks** (secrets) — `gitleaks detect --source <repoDir> --log-opts="origin/<targetBranch>..origin/<sourceBranch>" --report-format json --no-banner`.
  Scanning only the commit range unique to the PR means secrets already sitting in
  target-branch history are never re-flagged.

Both refer to branches the same way `GitService.getDiff` already does
(`origin/<branch>`), so no separate SHA-resolution step is needed.

Both run **host-side**, inside the main app container next to the existing
`git grep` call in `ReviewerService.buildInfoTool` — not inside the ephemeral
`pi-runner` container. Neither tool executes repo code (Semgrep pattern-matches
source text; gitleaks regex/entropy-matches git blobs), so this carries the same
trust level as `git grep` against an untrusted third-party diff.

Results are normalized into one markdown blob and attached as a new `@`-file
(`scanner-findings.md`), exactly like `context.md` today — **not** posted
directly. The `security` and `generic` persona runs read it, correlate it against
the diff, discard false positives, and fold real findings into their normal JSON
output. Every scanner-derived finding flows through the *existing*
dedup → validator → inline-comment pipeline; there is no new posting path and no
new dedup mechanism to maintain.

## Approaches considered

1. **Host-side scan, fed as LLM context** (chosen). Mirrors `ContextExplorer`:
   deterministic tool output feeds the review, but the LLM still makes the final
   call on relevance/false-positives, and everything rides the pipeline that
   already handles dedup, validation, and comment posting.
2. Post scanner findings directly as inline comments, bypassing the LLM. Faster
   and removes LLM judgment calls, but needs its own independent dedup-against-
   previous-runs mechanism (the existing dedup/validator stages are LLM-findings-
   only), and a raw regex hit ("looks like a secret") posted without review risks
   more false-positive noise than a judged one. Rejected for this iteration.
3. Run scanners inside the `pi-runner` container so they share the LLM's sandbox.
   Adds tool installation to an image that's rebuilt/derived per configured base
   (`pi-runner-image.ts`), multiplies image-build surface, and buys nothing since
   these tools don't need the LLM sandbox's isolation. Rejected.

## Rule sets

Vendored into the repo under `security-rules/`, fetched **once** during this
implementation and committed — not auto-refreshed on every run. Auto-fetching
live rule content on every PR review would mean scan results (and thus what gets
reported) are non-deterministic across otherwise-identical runs, and it means a
compromised upstream registry could inject rule changes with no review step.

- `security-rules/gitleaks.toml` — gitleaks' own default ruleset, fetched from the
  gitleaks project's tagged release.
- `security-rules/semgrep/` — curated Semgrep Registry packs pulled once:
  `p/security-audit`, `p/javascript`, `p/typescript`. Secret-pattern rules in
  these packs are skipped/excluded since gitleaks already covers that ground;
  no point flagging the same secret twice from two different tools.

Each vendored file/directory gets a short header comment noting the source and
fetch date, and `security-rules/README.md` documents how to manually re-fetch and
review an update later.

## New module: `src/reviewer/security-scanner.ts`

- `class SecurityScanner` — constructor `(enabled: boolean)`, exposing an
  `isEnabled` getter (mirrors `ContextExplorer`'s gate, minus the LLM/token
  plumbing this pass doesn't need).
- `scan(repoDir: string, targetBranch: string, sourceBranch: string): Promise<string>`
  — returns the markdown blob (empty string when disabled or nothing found). No
  LLM usage is involved, so unlike `IExplorationResult` there's no usage array to
  thread through.
  - Runs Semgrep and gitleaks as separate `execFileSync` calls with a bounded
    timeout each; each tool's failure (missing binary, non-zero unexpected exit,
    unparsable JSON, timeout) is caught independently and logged — one tool
    failing must not suppress the other's results.
  - Parses each tool's JSON into a small internal finding shape
    (`filePath`, `line`, `ruleId`, `message`, `severity`), then renders both into
    one markdown blob grouped by tool.
  - **Redaction**: gitleaks' JSON includes the actual matched secret text
    (`Secret`/`Match` fields). Every matched value is masked before it reaches
    the blob — first 4 characters plus a fixed `***` suffix — so a real secret
    is never written into a file an LLM reads (and could echo back into a posted
    PR comment). Semgrep findings carry no secret material and pass through
    unmasked.
  - Never throws. Any failure (missing binaries, scan timeout, parse failure)
    degrades to an empty blob, same philosophy as `ContextExplorer.explore()`.

## Integration

- **Config**: `Review.SecurityScannersEnabled` in `config/default.json`, default
  `false` (opt-in), env mapping `REVIEW_SECURITY_SCANNERS_ENABLED` in
  `config/custom-environment-variables.json`, documented in `.env.sample`.
- **bootstrap.ts**: `new SecurityScanner(securityScannersEnabled)`, passed to
  `ReviewerService` as a new constructor parameter.
- **reviewer.service.ts**: `runReview` calls `securityScanner.scan(...)` once,
  after `this.git.cloneOrFetch` and before the review loop (parallel in spirit to
  the existing `contextExplorer.explore()` call — both are pre-review, once-per-PR
  passes). The resulting blob is passed only into `reviewBatch` calls whose
  `role` is `security` or `generic`; `correctness`/`readability`/`vegetable-police`
  runs never see it, matching how `PERSONA_DIRECTIVES` already scope each role's
  focus.
- **pi.service.ts**: `reviewBatch`'s options gain `scannerFindings?: string | null`.
  Non-empty content is written to `scanner-findings.md` and attached as
  ` @/workspace/scanner-findings.md`, following the exact same attachment pattern
  as `context.md`/`pr-context.md`.
- **personas.ts**: `buildReviewPrompt` gains a `hasScannerFindings` flag and a line
  telling the model that `scanner-findings.md` contains automated Semgrep/gitleaks
  output that may include false positives — judge each one against the diff
  before reporting it, and (as with every other context file) only report on
  lines that appear in the diff.
- **Dockerfile** (main app image, not `pi-runner.Dockerfile`): installs `gitleaks`
  (downloaded release binary, pinned version + checksum verified) and `semgrep`
  (`pip install semgrep==<pinned version>`, requiring `python3`/`pip3` added to the
  image). Both are one-time, versioned installs — no runtime rule-fetching.

## Error handling

- Scanners disabled (`SecurityScannersEnabled=false`): `runReview` skips the scan
  entirely, review proceeds exactly as today.
- A tool binary missing or erroring: that tool's contribution is dropped, logged
  as a warning, the other tool's findings (if any) still flow through.
- Scan timeout: same as above — bounded per-tool timeout so a hung scanner can't
  stall the review indefinitely.
- Unparsable JSON output from either tool: logged, treated as no findings from
  that tool.

## Testing

- `test/reviewer/security-scanner.test.ts` (no real subprocess spawned — mirrors
  `pi-runner-image.test.ts`'s pattern of testing pure argv-builders and
  `context-explorer.test.ts`'s pattern of testing the class against fakes):
  Semgrep/gitleaks argv construction (`--baseline-commit`, `--log-opts` range)
  as pure, testable functions; JSON→markdown normalization for both tools;
  secret-value redaction (masks the value, keeps rule id/file/line); disabled
  gate short-circuits with no subprocess calls; one tool failing still returns
  the other tool's findings; malformed JSON from either tool degrades to empty
  for that tool without throwing.
- `test/reviewer/personas.test.ts`: prompt gains the `scanner-findings.md` line
  only when `hasScannerFindings` is true.
- `test/reviewer/pi.service.test.ts`: `buildBatchScript`/attachment wiring
  includes ` @/workspace/scanner-findings.md` when scanner content is present,
  omits it when not.
- `test/reviewer/reviewer.service.test.ts`: scanner blob is passed to
  `security`/`generic` runs and withheld from `correctness`/`readability`/
  `vegetable-police` runs.
