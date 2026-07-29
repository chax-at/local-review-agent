# Context exploration pass — design

Date: 2026-07-16
Status: approved (design discussed and accepted in review session)

## Problem

The review pass is diff-only by design: reviewers run `pi --no-tools` with no repo
mount and see only the diff chunks, code standards, and existing PR comments
(`pi.service.ts`, `buildReviewPrompt`). The validator stage restores *precision*
(it can read files and `git grep` to kill false positives), but nothing restores
*recall*: a bug that is only visible outside the diff — a caller broken by a
contract change, a removed invariant something else depends on — is structurally
invisible to every reviewer, and validators can only judge findings that exist.

## Decision

Run **one agentic exploration pass per PR**, before the review loop. It explores
the repository starting from the diff and produces a markdown context blob
(callers of changed code, type/interface definitions, related code). That blob is
attached as a fourth `@`-file (`context.md`) to **every** reviewer run, so the
council stays tool-less and injection-inert while gaining cross-file context.
Exploration cost is paid once per PR instead of once per (model × role) run.

Out of scope for this iteration (tracked in `FOLLOWUP.md` at the repo root):
feeding PR title/description and the originating Jira ticket to reviewers.

## Approaches considered

1. **Host-side LLM action loop reusing `IInfoTool`** (chosen). A new
   `ContextExplorer` runs a small propose→execute→refine loop with `LlmClient`
   (same JSON-actions contract as `InfoGatherer`: `file` / `search` actions,
   executed via provider `readFile` + `git grep`). No new security surface — the
   model only ever emits JSON action requests; tools run host-side with fixed,
   argument-safe implementations.
2. pi-in-Docker with repo mounted `:ro` and `--tools read`. True agentic session,
   but: adds a repo mount + tool execution driven by untrusted diff content
   (prompt-injection surface), pi's read tool alone cannot search (no grep
   without `bash`), and it spawns an extra container per PR. Rejected.
3. Full agentic review per council seat. Best recall, but multiplies cost and
   latency across every (model × role) run and maximizes injection surface.
   Rejected (revisit only if the shared pass proves insufficient).

## New module: `src/reviewer/context-explorer.ts`

- `class ContextExplorer` — constructor `(llm: LlmClient | null, maxExplorationTokens: number)`,
  mirroring `InfoGatherer`. `isEnabled` when `llm !== null && maxExplorationTokens > 0`.
- `explore(diff: string, tools: IInfoTool): Promise<{ context: string; usage: IModelUsage[] }>`
  - Up to **3 rounds**. Each round sends: the diff (truncated to 16 000 chars),
    everything gathered so far, and asks for up to **8 actions**
    (`InfoActionsSchema`, reused from `llm-schemas.ts`) or `{ "actions": [] }`
    to finish. Feeding gathered blocks back is what makes the pass agentic —
    the model can follow leads (read a file, then search for a symbol it saw).
  - Char budget shared across all rounds: `maxExplorationTokens × 4` chars,
    per-block cap 16 000 chars (same constants as `InfoGatherer`).
  - Dedup of file paths and search queries persists across rounds.
  - Stops on: empty actions, a round that produced no usable blocks, budget
    exhausted, or round cap.
  - **Never throws.** LLM or tool failure returns whatever was gathered so far
    (empty context at worst); a broken exploration must not block the review.
  - Usage entries are named `` `${llm.name} (exploration)` `` so the summary
    footer separates exploration cost from validation cost, matching the
    `(role)` suffix pattern used by review runs.

## Integration

- **Config**: `Review.MaxExplorationTokens` in `config/default.json`
  (default 8000; 0 disables), env mapping `REVIEW_MAX_EXPLORATION_TOKENS` in
  `config/custom-environment-variables.json`, documented in `.env.sample`.
- **bootstrap.ts**: `new ContextExplorer(validators[0] ?? null, maxExplorationTokens)`
  (same "first validator" convention as `InfoGatherer`/`FindingDeduplicator`),
  passed to `ReviewerService` as a new constructor parameter.
- **reviewer.service.ts**: `runReview` becomes `async` (its only caller,
  `reviewPr`, already is). After chunking and before the review loop it runs the
  explorer once with `buildInfoTool(project, slug, sourceBranch)` and passes the
  resulting context into every `reviewBatch` call. Exploration usage is kept
  separate and merged into `reviewUsage` **after** the "all review runs failed"
  check, so exploration usage can never mask a total review failure.
- **pi.service.ts**: `reviewBatch` gains a `prContext: string | null` parameter
  (after `existingComments`). Non-empty context is written to `context.md` in the
  workspace tmp dir and attached as ` @/workspace/context.md`. The private
  `buildBatchScript` method becomes an exported pure function (precedent:
  `buildLintScript`) so the attachment wiring is unit-testable.
- **personas.ts**: `buildReviewPrompt(directive, hasExistingComments, hasPrContext)`
  gains a line telling the model that `context.md` is read-only repository
  context to *judge* the diff with, and that findings must still only target
  lines present in the diff.

## Error handling

- Explorer disabled (no validator / budget 0): review proceeds exactly as today.
- Explorer LLM error: logged warning, partial-or-empty context, review proceeds.
- `readFile`/`searchSymbol` failures: swallowed per-action (existing `IInfoTool`
  semantics), the action is simply skipped.

## Testing

- `test/reviewer/context-explorer.test.ts` (mock `LlmClient` + fake `IInfoTool`,
  same style as `info-gatherer.test.ts`): disabled cases; single-round gather
  produces file + search blocks and `(exploration)` usage naming; multi-round
  loop feeds round-1 results into round 2 and stops on empty actions; dedup
  across rounds; budget exhaustion stops the loop; LLM failure mid-loop returns
  the partial context without throwing.
- `test/reviewer/personas.test.ts`: prompt gains the context.md line only when
  `hasPrContext` is true.
- `test/reviewer/pi.service.test.ts`: exported `buildBatchScript` includes the
  `@/workspace/context.md` attachment when context is present, omits it when not.
