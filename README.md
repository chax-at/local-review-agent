# local-git-reviewer (agent carrot)

Automated PR reviewer and supply-chain security bot for Bitbucket Server / Data Center and Bitbucket Cloud. Reviews code with AI, monitors builds for audit vulnerabilities, and applies fixes. Configured per-repo via `.carrot.jsonc`.


``` 
CAUTION
THIS IS VIBED
Don't expect the quality in the code our company (chax.at) would usually deliver. This is vibed with love, but still vibed.
However, it works really well, so feel free to use and change it on your behalf.
```


## What it does

1. **PR code review** — AI reviews every new PR and posts inline comments (severity, file, line)
2. **Mention commands** — `@carrot` in PR comments to request fixes, reverts, re-reviews, or ask questions
3. **Audit monitoring** — detects npm audit failures on PR builds, creates fix PRs on the target branch
4. **Scheduled audits** — proactive audit checks on branches via configurable schedules

## Prerequisites

- Node.js (v24+)
- Git
- Docker (for isolated AI review containers)
- Bitbucket Server / Data Center instance OR a Bitbucket Cloud workspace
- Any CI system that reports build status to Bitbucket (e.g. Bamboo, Jenkins)

## Setup

```bash
npm ci
cp .env.sample .env
# Fill in credentials (see below)
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BITBUCKET_PAT` | For Server | Bitbucket personal access token (repo read+write) |
| `MODEL1_API_KEY` | For PR review & fixes | API key for Model 1 (any OpenAI-compatible provider) |
| `MODEL1_API_BASE` | For PR review & fixes | API base URL (e.g. `https://api.openai.com/v1`) |
| `MODEL1_MODEL` | For PR review & fixes | Model name |
| `MODEL1_NAME` | Optional | Display name in review comments |
| `MODEL1_AUTH_HEADER` | Optional | Custom auth header name (e.g. `api-key` for Azure) |
| `MODEL1_SUPPORTS_STRUCTURED_OUTPUT` | Optional | Set `false` if the model does not support `json_schema` response format (defaults to `true`) |
| `MODEL1_MAX_TOKEN_PARAM` | Optional | Token limit param name (e.g. `max_tokens` or `max_completion_tokens`) |
| `MODEL1_INPUT_COST` | Optional | Cost per 1M input tokens (for cost tracking in review comments) |
| `MODEL1_OUTPUT_COST` | Optional | Cost per 1M output tokens |
| `MODEL1_REVIEW` | Optional | Set `true` to run the review pass (Docker pi-runner) with this model; the first review-enabled model also handles fix/propose/lint |
| `MODEL1_VALIDATE` | Optional | Set `false` to exclude this model from the validator pool (defaults to `true`). Use for review-only deployments whose endpoint doesn't speak `/chat/completions` — e.g. Azure responses-API codex models — so the bot doesn't try to vote with them and 400. |
| `MODEL1_PROVIDER` | When `MODEL1_REVIEW=true` | pi-runner provider — must match the model. Supported: `anthropic`, `google` (Gemini), `openai`, `azure-openai-responses`, `openrouter`, `xai`, `deepseek`, `mistral`, `groq`. The key is forwarded to pi under that provider's env var (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …). Defaults to `azure-openai-responses` — a Claude/Gemini model left on that default returns a 404. |
| `MODEL1_DOCKER_IMAGE` | When `MODEL1_REVIEW=true` | Docker image for the pi-runner container (e.g. `lgr-pi-runner:latest`) |
| `MODEL1_TIMEOUT_MS` | When `MODEL1_REVIEW=true` | Timeout in milliseconds for the pi-runner container |
| `MODEL2_*` … `MODEL4_*` | Optional | Same fields for Model 2, 3, and 4 |
| `REVIEW_MAX_DIFF_LINES` | Optional | Diffs larger than this line count are skipped (default: 5000) |
| `REVIEW_MAX_FILE_LINES` | Optional | Files larger than this line count are skipped in review (default: 1000) |
| `REVIEW_MAX_INFO_TOKENS` | Optional | Token budget for the info-gatherer's added context (DTOs / symbol matches). Roughly 4 chars per token. Set `0` to disable info-gathering. Default: 8000. |
| `REVIEW_MAX_REVIEWERS` | Optional | Cap on the number of review models that run per PR. If more `MODELn_REVIEW=true` models are configured, a random subset of this size is picked per PR. Set `0` for no cap. Default: 2. |
| `REVIEW_MAX_VALIDATORS` | Optional | Cap on the number of validators that vote per PR. If more validator-enabled models are configured, a random subset of this size is picked per PR and reused across round 1, round 2, suggestion votes, and fix-prompt drafting. Set `0` for no cap. Default: 2. |
| `SUMMARIZER_API_KEY` | Optional | API key for the Bamboo changelog summarizer (separate from PR review — see below) |
| `SUMMARIZER_API_BASE` | Optional | Endpoint URL |
| `SUMMARIZER_MODEL` | Optional | Model name |
| `SUMMARIZER_NAME` | Optional | Display name |
| `SUMMARIZER_INPUT_COST` | Optional | Cost per 1M input tokens |
| `SUMMARIZER_OUTPUT_COST` | Optional | Cost per 1M output tokens |

### Bitbucket Cloud (alternative to Server)

To run against bitbucket.org instead of (or alongside) a Server instance, fill in the Cloud-specific variables.

Bitbucket Cloud supports two credential styles. **Workspace/Repo Access Tokens** (Bearer auth) are the cleanest fit but require a Premium plan. **Scoped Atlassian API tokens** (Basic auth with `email:token`) work on any plan and are the practical default — create one at `id.atlassian.com` → Security → API tokens, signed in as the bot's Atlassian account, with at least the `read:repository:bitbucket`, `write:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`, `read:account`, and `read:user:bitbucket` scopes.

| Variable | Required | Description |
|----------|----------|-------------|
| `BITBUCKET_CLOUD_WORKSPACE` | For Cloud | Workspace slug, e.g. `your-workspace` (the segment between `bitbucket.org/` and the repo name) |
| `BITBUCKET_CLOUD_ACCESS_TOKEN` | For Cloud | Either a Workspace/Repo Access Token (Premium-only) or a scoped Atlassian API token |
| `BITBUCKET_CLOUD_BOT_USERNAME` | For Cloud | Bot account's `account_id` (e.g. `712020:abcd-1234-...`). Used to recognise the bot's own comments and skip them. Find it via the curl probe below. |
| `BITBUCKET_CLOUD_BOT_EMAIL` | When using an Atlassian API token | Atlassian account email of the bot user. Switches the bot to Basic auth (`email:token` for REST, `x-bitbucket-api-token-auth:token` for git over HTTPS). Leave empty when using a Workspace Access Token — Bearer is the default in that case. |

To find the bot's `account_id`, run (substitute the email + token used in the bot's `.env`):

```bash
curl -s -u "$BITBUCKET_CLOUD_BOT_EMAIL:$BITBUCKET_CLOUD_ACCESS_TOKEN" https://api.bitbucket.org/2.0/user | jq -r .account_id
```

(For Workspace Access Tokens, use `-H "Authorization: Bearer $BITBUCKET_CLOUD_ACCESS_TOKEN"` instead of `-u`.)

The Cloud bot polls every repository in the workspace. Discovery is automatic — no per-repo configuration. The `.carrot.jsonc` file in each repo's default branch still gates whether the bot acts on it, exactly as on Server.

### Running both providers side-by-side

Use the dedicated scripts in two separate processes:

```bash
npm run start:server   # talks to BITBUCKET_*
npm run start:cloud    # talks to BITBUCKET_CLOUD_*
```

The default `npm run start` / `npm run start:production` / `npm run start:development` continue to point at the Server entrypoint for back-compat.

Audit monitoring works via Bitbucket's build-status API — no CI system credentials needed.

## Running

```bash
# Development (watch mode, debug logs enabled)
npm run start:development

# Production
npm run build && npm run start:production
```

### Docker

```bash
docker-compose build
docker-compose up -d
```

The `docker-compose.yml` includes an `init-perms` service that fixes `data/` and `repos/` ownership. If switching between local dev and Docker:

```bash
./tools/fix-data-perms.sh docker   # before docker-compose up
./tools/fix-data-perms.sh local    # before npm run start
```

To run a Cloud bot in Docker alongside (or instead of) the Server bot, copy the existing service in `docker-compose.yml` and override the command:

```yaml
local-git-reviewer-cloud:
  extends: local-git-reviewer
  environment:
    - BITBUCKET_CLOUD_WORKSPACE=${BITBUCKET_CLOUD_WORKSPACE}
    - BITBUCKET_CLOUD_ACCESS_TOKEN=${BITBUCKET_CLOUD_ACCESS_TOKEN}
    - BITBUCKET_CLOUD_BOT_USERNAME=${BITBUCKET_CLOUD_BOT_USERNAME}
    - BITBUCKET_CLOUD_BOT_EMAIL=${BITBUCKET_CLOUD_BOT_EMAIL}
  command: ["node", "dist/src/main-cloud.js"]
```

### Reset state

```bash
npm run reset:all          # Clear all state (both pollers start fresh)
npm run reset:audit        # Clear audit state (re-check builds, re-create audit PRs)
npm run reset:pr           # Clear all PR state (re-review all PRs)
npm run reset:pr -- 707    # Clear state for PR #707 only
```

## Build commands

### Local development

```bash
npm run start:development
```

### Build server (CI)

```bash
npm ci --include=dev
npm run ci:lint
npm run ci:typecheck
npm run ci:stylecheck
npm run ci:build
npm run ci:test
npm run audit
```

## Testing

```bash
npm test              # Single run
npm run test:watch    # Watch mode
npm run ci:test       # CI (same as npm test)
```

31 test files via Vitest.

---

## Architecture

A single polling loop runs on a configurable interval (default: 5 minutes). Each cycle does PR work for all repos first, then audit work for all repos — sequential, so the persistent per-repo clone in `repos/` is never written by two flows at once.

```
┌────────────────────────────────────────────────┐
│            Poll cycle (single timer)           │
│                                                │
│  1. PR phase (PollerService)                   │
│     - Discover repos                           │
│     - Check PRs                                │
│     - Detect @mentions                         │
│     - Run AI review                            │
│     - Apply fixes / post comments              │
│                                                │
│  2. Audit phase (BambooPollerService)          │
│     - Check build statuses                     │
│     - Reset persistent clone to target branch  │
│     - npm install + npm audit                  │
│     - Create or update audit PR                │
└────────────────────────────────────────────────┘
                       │
        ┌──────────────▼─────────────┐
        │  Bitbucket Server / Cloud  │
        │       (REST + Git)         │
        └────────────────────────────┘
```

### Key source files

| File | Purpose |
|------|---------|
| `src/main-server.ts` | Entry point for `npm run start:server` (Bitbucket Server) |
| `src/main-cloud.ts` | Entry point for `npm run start:cloud` (Bitbucket Cloud) |
| `src/bootstrap.ts` | Shared service wiring used by both entrypoints |
| `src/provider/provider.ts` | `IGitProvider` interface + neutral types |
| `src/poller/poller.service.ts` | PR polling loop, mention detection, command dispatch |
| `src/poller/state.service.ts` | PR state persistence (`data/state.json`) |
| `src/poller/mention-router.ts` | LLM-based natural language command routing |
| `src/poller/mention-executor.ts` | Mention tool execution |
| `src/poller/mention-context.ts` | Context building around mentions |
| `src/reviewer/reviewer.service.ts` | AI review orchestration, fix/autofix/revert |
| `src/reviewer/pi.service.ts` | Docker container management for pi coding agent |
| `src/reviewer/git.service.ts` | Clone, fetch, diff, push operations |
| `src/reviewer/multi-model-validator.ts` | Council validation of findings, suggestions, and fixes (2-round voting) |
| `src/reviewer/finding-deduplicator.ts` | Single-LLM pass that merges same-run duplicate findings before the council |
| `src/reviewer/info-gatherer.ts` | Per-file context expansion (extra files / symbol search) for validators |
| `src/reviewer/llm-client.ts` | OpenAI-compatible API wrapper |
| `src/reviewer/llm-schemas.ts` | Zod schemas for structured LLM outputs |
| `src/reviewer/diff.utils.ts` | Diff splitting, filtering, batching |
| `src/bamboo/bamboo.poller.service.ts` | Build status monitoring, audit fix PRs |
| `src/bamboo/bamboo.state.service.ts` | Build state persistence (`data/bamboo-state.json`) |
| `src/audit/audit.service.ts` | npm audit analysis, fix proposal generation |
| `src/audit/changelog.service.ts` | Package changelog fetching and summarization |
| `src/audit/npm-registry.client.ts` | npm registry API client |
| `src/provider/bitbucket-server/server.client.ts` | Bitbucket Server REST API wrapper with retry + timeout |
| `src/provider/bitbucket-cloud/cloud.client.ts` | Bitbucket Cloud REST API wrapper |
| `src/config/carrot-config.service.ts` | `.carrot.jsonc` discovery and parsing |
| `src/constants.ts` | Bot branch prefixes, identity helpers |

---

## Configuring repositories

Commit a `.carrot.jsonc` file to the repo's **default branch**. The bot discovers repos dynamically each cycle.

### Minimal (review only)

```jsonc
{
  "prReview": true
}
```

### Full reference

```jsonc
{
  // Directories containing package.json to audit. Default: ["."]
  "packages": [".", "frontend", "backend"],

  // Enable PR code review. Default: false
  "prReview": true,

  // Enable audit monitoring via build statuses. Default: false
  "bambooFix": true,

  // How to deliver audit fixes: "direct" (push to the branch), "pr" (always a
  // separate fix PR), or "protected-only" (PR for protected branches, direct
  // push otherwise). Default: "protected-only"
  "fixDelivery": "protected-only",

  // Bamboo plan keys (e.g. "PROJ-PLAN") to poll for this repo. Optional — if any
  // bamboo-enabled repo lists keys, only those plans are scanned. Default: all plans
  "bambooPlanKeys": ["PROJ-PLAN"],

  // Post validator-approved code suggestions on inline review comments. Default: true
  "suggestCodeFixes": true,

  // Docker image used for AI review + fix containers.
  // Use this to match your repo's Node version. Default: node:lts-slim
  // Examples: "node:22-slim", "node:24-slim"
  "dockerImage": "node:24-slim",

  // Branches considered protected (glob patterns). Default: ["main", "master", "release/*"]
  "protectedBranches": ["main", "master", "release/*"],

  // Files to read for code standards/rules (from target branch).
  // Default: ["CLAUDE.md", "AGENTS.md"] (+ lowercase variants)
  "rulesFiles": ["CLAUDE.md", "AGENTS.md", "CODING_STANDARDS.md"],

  // Include LLM-generated fix prompts in review summaries and rejection comments.
  // Costs extra tokens per review. Default: false
  "generateFixPrompts": true,

  // Scheduled audit checks — run audits on branches even without a failed build.
  // Triggers when the last check is older than staleAfterDays and the configured time is reached.
  "auditSchedules": [
    {
      "branch": "master",        // Branch to audit
      "staleAfterDays": 7,       // Only run if last check is older than 7 days
      "hour": 6,                 // Run at 06:30
      "minute": 30
    },
    {
      "branch": "release",
      "staleAfterDays": 3,
      "hour": 7,
      "minute": 0
    }
  ]
}
```

<details>
<summary>Generate config with an LLM (click to expand prompt)</summary>

```
Generate a `.carrot.jsonc` config file for my repository.

First, look at my repo structure to understand it:
- Find all directories containing a package.json (these are the `packages` to audit)
- Check which branches exist (main, master, release, develop, etc.)
- Look for existing code standards files (CLAUDE.md, AGENTS.md, CODING_STANDARDS.md, etc.)
- Check the Node.js version in package.json engines or .nvmrc (to pick the right `dockerImage`)

Then ask me which features I want:
- PR code review (prReview)
- Audit monitoring on failed builds (bambooFix)
- Scheduled audit checks on specific branches (auditSchedules)

Here is the full schema with defaults:

interface ICarrotConfig {
  packages: string[];              // Dirs with package.json. Default: ["."]
  prReview: boolean;               // AI code review on new PRs. Default: false
  bambooFix: boolean;              // Audit fix on failed builds. Default: false
  fixDelivery: 'direct' | 'pr' | 'protected-only'; // Fix delivery mode. Default: "protected-only"
  protectedBranches: string[];     // Glob patterns. Default: ["main", "master", "release/*"]
  dockerImage?: string;            // For AI review containers. Default: node:lts-slim
  bambooPlanKeys?: string[];       // Bamboo plan keys to poll. Default: all plans
  rulesFiles?: string[];           // Code standards files from target branch. Default: ["CLAUDE.md", "AGENTS.md"]
  generateFixPrompts?: boolean;    // LLM fix prompts in summaries. Default: false
  suggestCodeFixes?: boolean;      // Inline code suggestions on review comments. Default: true
  auditSchedules?: Array<{
    branch: string;                // Branch to audit
    staleAfterDays: number;        // Only run if last check is older than N days
    hour: number;                  // Hour of day (0-23, server-local timezone)
    minute: number;                // Minute (0-59)
  }>;
}

Output valid JSONC. Only include fields I need — omit anything that matches the defaults.
The file must be named `.carrot.jsonc` and committed to the repo's default branch.
```

</details>

---

## Flows in detail

### Flow 1: Automatic PR review

**Trigger:** New PR seen for the first time (not yet successfully reviewed). On failure the review is retried next cycle, **at most 3 attempts**, then auto-review gives up for that PR (the failure comment stays visible; an explicit `@carrot` mention still triggers a review). After a successful review, subsequent reviews also require an explicit `@carrot` mention.

```
PR Poller cycle
└─ For each repo with .carrot.jsonc (prReview: true):
   └─ For each open PR (not draft, not bot-branch):
      └─ If not yet reviewed (and < 3 failed attempts):
         ├─ Clone/fetch repo
         ├─ Get diff (origin/target...origin/source)
         ├─ Load code standards (CLAUDE.md / AGENTS.md from target branch)
         ├─ Run review pi-runners (existing comments shown as context)
         ├─ Same-run dedup (single LLM pass, per file)
         ├─ Info-gather per finding-file, then council validation (2 rounds)
         ├─ Propose + council-validate code suggestions
         ├─ Post inline comments (best-effort): concern / suggestion / note
         └─ Post top-level summary comment with token/cost footer
```

See [End-to-end review workflow](#end-to-end-review-workflow) for the full stage-by-stage detail.

**Decision gates:**
- `.carrot.jsonc` must exist with `prReview: true`
- PR must not be a draft
- PR branch must not start with `audit/` or `carrot/` (bot-created)
- PR must not have been successfully reviewed before (and fewer than 3 failed auto-review attempts)

### Flow 2: Mention commands (`@carrot`)

**Trigger:** Comment or reply containing `@carrot` in a PR.

Tag `@carrot` in any PR comment. The bot understands natural language — no keywords needed. An LLM reads your message in context (the code, the thread, previous review findings) and decides the best action:

| What you can do | Example |
|----------------|---------|
| Ask for a code fix | "@carrot fix the null check on line 42" |
| Fix all review findings | "@carrot autofix everything" |
| Revert a change | "@carrot revert the last commit" |
| Re-run review | "@carrot review this again" |
| Fix audit vulnerabilities | "@carrot run the audit fix" |
| Ask a question | "@carrot why did you flag line 42?" |
| Have a conversation | "@carrot I disagree, this is intentional" |

The bot acknowledges with a reaction, routes via LLM, then executes. Fix/autofix/revert create PRs. Questions and conversations get inline replies.

**Detection:**
- Top-level comments: checked if `activity.id > lastActivityId`
- Thread replies: always scanned, deduped by checking for bot-authored child reply
- State backup: `processedMentionIds` array in PR state prevents reprocessing on restart

**Status feedback on the comment:**
```
User: @carrot fix the null check on line 42
  └─ On it...
  └─ PR #789 (carrot/fix-707-2026-03-23T14-30): Added null check   ← on success
  └─ Failed: Error: ...                                             ← on failure
```

**All fixes create PRs** (never push directly to the source branch):

| Command | Branch pattern | PR targets |
|---------|---------------|------------|
| fix | `carrot/fix-{prId}-{timestamp}` | Source branch of the original PR |
| autofix | `carrot/autofix-{prId}-{timestamp}` | Source branch |
| audit-fix | `audit/mention-{prId}-{timestamp}` | Source branch |
| revert | `carrot/revert-{prId}-{timestamp}` | Source branch |

All fix PRs have `deleteSourceBranchOnMerge` enabled.

### Flow 3: Audit monitoring (build failure → fix PR on target branch)

**Trigger:** Any failed build on an open PR (detected via Bitbucket's build-status API). Requires `bambooFix: true` in `.carrot.jsonc`.

Audit issues on the target branch affect ALL PRs targeting it. The bot fixes the target branch once so all PRs pass.

```
Audit Poller cycle
└─ For each repo with bambooFix:
   └─ For each open PR (not draft, not bot-branch):
      └─ GET build statuses for the latest commit (Server: /rest/build-status/1.0/commits/<hash>; Cloud: /2.0/repositories/<ws>/<repo>/commit/<hash>/statuses)
         └─ For each FAILED build (not yet in bamboo-state.json):
            ├─ Clone TARGET branch (not PR branch)
            ├─ npm install + npm audit --json in Docker
            ├─ Collect high/critical vulnerabilities
            ├─ Generate fix proposals (override or upgrade)
            ├─ Apply all safe fixes
            ├─ Re-verify each dir; exclude dirs that still fail
            ├─ Create or update audit PR (passing dirs only):
            │   ├─ Existing open audit PR for this target branch? → force-push updates
            │   └─ No → create audit/YYYY.MM.DD-HH.mm branch + PR
            └─ Comment on original PR linking to audit fix PR
```

One audit PR per (repo, target branch) at a time. New vulnerabilities update the existing PR.

### Flow 4: Autofix with lint

**Trigger:** `@carrot autofix` mention on a PR.

```
1. Clone/fetch + reset to source branch
2. Get diff
3. Gather existing review comments (non-bot) as context
4. Run pi fix with review comments as guidance
5. Run lint (npm run ci:lint → ci:stylecheck → lint, first found)
6. If lint fails → run pi fix again targeting only lint errors
7. Create carrot/autofix-{prId}-{ts} branch + PR
```

---

## Multi-model review and validation

The bot supports four general-purpose models (`Model1`–`Model4`). Each model is by default a **validator**; setting `MODELn_REVIEW=true` additionally enrolls it in the **review** pool (which runs the Docker pi-runner). The first validator-enabled model also doubles as the **info-gatherer**.

By default the bot uses **at most 2 reviewers and 2 validators per PR** (configurable via `REVIEW_MAX_REVIEWERS` / `REVIEW_MAX_VALIDATORS`; set `0` for no cap). When more models are configured than the cap allows, the active subset is picked **randomly per PR** — different PRs may see different models, giving you cost-bounded diversity over time. Within a single PR the picked subset is stable: round 1, round 2, suggestion votes, and fix-prompt drafting all see the same validators.

### End-to-end review workflow

Each PR review walks through eight stages. Every stage is best-effort: if a stage fails or has nothing to do, the pipeline continues with degraded but well-defined behavior.

```
┌──────────────────────────────────────────────────────────────────────┐
│  1. clone/fetch + compute diff (origin/target...origin/source)       │
│  2. review pass (≤MaxReviewers×roles runs), each shown the existing  │
│     PR comments so it won't re-raise addressed issues  → findings[]  │
│  3. fetch whole files (provider API)                → contentByPath  │
│  4. filter findings on files > MaxFileLines         → keptFindings[] │
│  5. same-run dedup (single LLM pass, per file)      → dedupedFnds[]  │
│  6. info-gather PROACTIVE (one LLM call per file)   → ctxByFile      │
│  7. validation (≤MaxValidators, authors deprioritized):              │
│       round 1 (per-file groups, council votes + infoRequest field)   │
│       ├─ unanimous keep        → kept                                │
│       ├─ unanimous reject      → discarded                           │
│       └─ split                 → info-gather FOLLOW-UP (per-file)    │
│                                  → round 2 deliberation              │
│                                  ├─ all reject  → discarded          │
│                                  └─ otherwise   → kept               │
│  8. propose code suggestions + validate (2-round council)            │
│     post inline comments (best-effort) + algorithmic summary         │
└──────────────────────────────────────────────────────────────────────┘
```

**Stage 1 — Clone/fetch + diff.** `GitService.cloneOrFetch` ensures the local repo is up to date; `GitService.getDiff` produces a three-dot diff against the merge base. If the diff is empty, the review aborts cleanly with no comment.

**Stage 2 — Review pass.** Up to `REVIEW_MAX_REVIEWERS` models (default 2) from the `MODELn_REVIEW=true` pool run the pi-runner inside Docker against the diff and return their own list of findings (`{filePath, line, severity, comment}`). If more review models are configured than the cap allows, the active subset is **picked randomly per PR** — so different PRs may use different models, giving cost-bounded diversity. Each model runs **once per assigned role** (its review personas — e.g. `correctness`, `security`, `readability`, or the catch-all `generic`), each run carrying a role-focused prompt. So the number of review pi-runs per PR is the **sum of roles across the sampled models**, not just the model count — e.g. two sampled models with two roles each is four runs. Each reviewer is also shown the **existing PR comments** (grouped per file, capped at the most recent 60 comments × 500 chars each) and instructed not to re-raise issues that are already addressed — this replaces the old mechanical "same file/line/prefix" dedup filter, which was brittle against rewording. Findings are tagged with the authoring model and the role that produced them. Findings on lockfiles are dropped automatically. If *all* active review models fail, the bot posts an "Automated review failed" comment instead of a misleading "no issues" summary. If the diff is over `REVIEW_MAX_DIFF_LINES`, it's split per-file and packed into batches before review.

**Stage 3 — Fetch whole files.** For each distinct finding path (excluding lockfiles), the provider's `getFileContent` is called once at the source branch. This populates `fileContentByPath`, used both for the line-count check and as full-file context for validators.

**Stage 4 — File-size filter.** Findings on files over `REVIEW_MAX_FILE_LINES` (default 1000) are dropped (those files are noted in the summary as "skipped").

**Stage 5 — Same-run dedup.** With multiple review models, the same issue is often flagged twice with different wording. A dedicated single-LLM pass (the first validator, one call per file with 2+ findings, calls run in parallel) clusters duplicates and merges each cluster into one finding whose comment combines every triggering reason. The merged finding records **every contributing author** (`contributingAuthors`), so no contributor can later vote on it in the council. Fail-safe: any model or parse error keeps that file's findings unmerged — a finding is never dropped because dedup failed.

**Stage 6 — Info-gather, proactive pass.** Before any validator votes, the bot expands the context.
- The working tree is reset to the source branch first (so `git grep` searches the right code).
- Findings are grouped by file, and **one LLM call runs per finding-file** (in parallel). Each call sees only that file's findings plus the diff and asks: "what extra files / symbols would help validators judge these?"
- The LLM returns `{actions: [{type: 'file'|'search', target: '<path or symbol>'}, …]}`. Actions are executed: `file` actions go through `provider.getFileContent`, `search` actions run `execFileSync('git', ['grep', ...])` against the (now-reset) working tree.
- Each file's results are accumulated into a markdown blob, capped at `REVIEW_MAX_INFO_TOKENS × 4` chars **per file** (≈ 32 KB default), with a per-block ceiling of 16 KB so one huge file can't eat the whole budget.
- Result: `additionalContextByFile: Map<filePath, string>`. Each file's blob is injected only into that file's validator group prompt later — no cross-file contamination.
- The info-gatherer model is `validators[0]` (first non-`VALIDATE=false` model). If no validator exists or `REVIEW_MAX_INFO_TOKENS=0`, the stage is a no-op and the pipeline carries on with no extra context.

**Stage 7a — Validation, round 1.** Findings are split into per-file groups. The active validator pool is capped at `REVIEW_MAX_VALIDATORS` (default 2): if more validator-enabled models are configured, a random subset is **picked once per PR** and reused across round 1, round 2, suggestion votes, and fix-prompt drafting (so a model can't flip-flop just because a different subset voted later). The pick **deprioritizes this PR's finding authors**: a model can't vote on findings it (co-)authored, so sampling a reviewer would waste a validator slot — authors are only sampled when there aren't enough non-author validators to fill the subset. For each group, **every active model except the finding's author(s)** is asked to vote (for merged findings, all `contributingAuthors` are excluded).
- The model returns `{results: [{index, relevant, thought, infoRequest}, …]}`. The `infoRequest` field (free text — a specific path or symbol) flags "I'd need more context to judge this confidently".
- The schema is sent strict via JSON Schema, but parsing is **lenient**: if a model (e.g. one with `SUPPORTS_STRUCTURED_OUTPUT=false`) returns the base shape without `infoRequest`, its vote is still accepted with an empty request.
- Per finding, the votes are tallied:
  - **Unanimous yes** or **no validator responded** → keep.
  - **Unanimous no** → discard (logged + counted in the summary's "validators discarded N" line).
  - **Split** → contested, sent to round 2.
- The author rule ensures a model can't validate its own opinion. If a finding's *only* eligible voter is the author, the finding is conservatively kept with no notes.

**Stage 7b — Info-gather, follow-up pass.** Only triggered if at least one contested finding has a non-empty `infoRequest`.
- Requests are grouped by the finding's file (within-file dedup so the same DTO ask from 3 validators only fetches once).
- The gatherer runs one LLM call **only for the files that filed requests** (`onlyRequested=true`). Each call sees the validator requests as the primary signal and translates them into actions, same per-file budget.
- New per-file blobs are merged into the existing `additionalContextByFile` (concatenated, not replaced), so round 2 sees both the proactive context and the new follow-up context.
- Failure here degrades silently: round 2 just runs with whatever context already existed.

**Stage 7c — Validation, round 2 (deliberation).** Contested findings are re-asked, this time each model also sees **every peer's round-1 reasoning**. Same author-exclusion. Schema is the base `FindingsValidationSchema` (no `infoRequest` — info-gathering is done by this point).
- A finding is discarded only if every responding round-2 voter rejects it; any defender keeps it. This is intentionally biased toward keeping signal.
- All vote entries (round 1 + round 2, every model) are rendered into the final inline comment as a "Valid finding / Not important" block under each finding, so the human reader can see the disagreement.

**Stage 8 — Code suggestions.** For every kept finding, the primary review model's pi-runner is asked to `proposeFixes`. Replace-proposals go through the same 2-round council vote (`validateSuggestions`). Approved suggestions are attached to the inline comment as ```suggestion blocks; rejected ones are silently dropped.

**Posting.** Inline comments are posted **best-effort**: one rejected comment (e.g. out-of-diff anchor) is logged and skipped, not fatal. Only if *every* comment fails does the run throw — nothing was posted, so the retry next cycle can't duplicate. The summary post is also non-fatal: once inline comments are out, a failed summary must not prevent the poller from saving review state (that would re-post everything next cycle).

The PR summary comment carries: severity counts, skipped files, optional fix-prompt, and the token/cost footer aggregating every model's usage across review + dedup + gather + validation + propose.

### Robustness guarantees

| Failure mode | Behavior |
|--------------|----------|
| All review models fail | "Automated review failed" comment posted (no false-positive "no issues"). Auto-review retries next cycle, **at most 3 attempts total**, then gives up (a `@mention` review still works). |
| One review model fails | Other models' findings are still pooled. |
| Provider can't fetch a file | That file's findings move to a fallback diff-only group instead of a whole-file group. |
| Dedup LLM throws / returns garbage | That file's findings stay unmerged — never dropped. |
| Info-gatherer LLM throws | Caught, logged, pipeline continues with empty context. |
| Info-gatherer returns unparseable JSON | Caught, usage still counted, empty context. |
| One per-file gather/dedup call hangs/throws | Others still complete (`Promise.allSettled` isolation). |
| `git grep` finds nothing | Returns empty hits (exit code 1 is treated as "no matches", not failure). |
| Validator omits `infoRequest` field | Lenient fallback parse — vote still counted. |
| Validator returns malformed JSON | That model abstains for that group; other models still vote. |
| All validators abstain on a finding | Conservatively kept (no false-discard). |
| Follow-up gather throws | Round 2 falls back to the original `additionalContextByFile`. |
| One inline comment fails to post | Skipped (logged); the rest still post; review state is saved. |
| ALL inline comments fail to post | Run throws → state not saved → full retry next cycle (cannot duplicate, nothing was posted). Counts toward the 3-attempt cap. |
| Summary comment fails to post | Logged, non-fatal — inline comments are already out and state gets saved. |
| `REVIEW_MAX_INFO_TOKENS=0` | Whole info-gather pipeline disables; pure validation still runs. |
| No `VALIDATE=true` models configured | Info-gatherer + dedup disabled; validation no-ops; pure review-only mode. |

### Known limits & cost bounds

Where the money goes, and what bounds it:

| Cost driver | Bound |
|-------------|-------|
| Review pass | ≤ `REVIEW_MAX_REVIEWERS` models × each model's role count pi-runs per PR (one run per model per assigned role); diff over `REVIEW_MAX_DIFF_LINES` is skipped entirely. Comment context capped at 60 × 500 chars. |
| Same-run dedup | One LLM call per file with 2+ findings (files with one finding cost nothing). |
| Info-gather (proactive) | One LLM call per finding-file; output ≤ `REVIEW_MAX_INFO_TOKENS` × 4 chars per call. |
| Info-gather (follow-up) | At most one extra call per file *that filed a request*, same budget. Runs at most once per PR. |
| Validation | ≤ `REVIEW_MAX_VALIDATORS` models × per-file groups × ≤ 2 rounds. File context 60 KB/group, diff 8 KB. |
| Suggestions | One pi-run (`proposeFixes`) + suggestion council (≤ 2 rounds, 12 KB context/item). |
| Fix / autofix | Up to 4 pi-runs (initial + 2 revisions + 1 lint-fix), each agentic with tools — the most expensive ops in the system. Diff 10 KB to validators; lint output capped at 8 KB. |
| Failed auto-review | Retried at most **3 times total** (one per poll cycle), then disabled for that PR. Without this cap, a persistently failing PR would re-spend a full review every cycle, forever. |

Remaining caveats:

- **Cost scales with file count.** With N finding-files in a PR, dedup + proactive gather + follow-up are each up to N calls. There is no single global per-PR token cap — the bounds above are per-call. To cap aggressively, lower `REVIEW_MAX_INFO_TOKENS` (or set `0`), and keep `REVIEW_MAX_REVIEWERS`/`REVIEW_MAX_VALIDATORS` at 2.
- **Review runs scale with roles, not just models.** `REVIEW_MAX_REVIEWERS` bounds the model count, but each sampled model runs once per assigned role — so a model with three roles costs three pi-runs. Keep role counts modest, or lower `REVIEW_MAX_REVIEWERS`, to bound per-PR review cost.
- **Parallel fan-out has no concurrency limit.** Per-file dedup and gather calls all fire at once; a 50-file PR makes 50 concurrent LLM requests. That's a rate-limit risk (429s degrade gracefully to "no result"), not a cost risk.
- **Working-tree assumption.** `git grep` operates on the local clone's working tree, which is reset to the source branch before each review. The pipeline assumes review and fix flows for the same `(project, slug)` are **serialized** (the existing pollers enforce this). Concurrent flows on the same local repo would race on the working tree.
- **`infoRequest` is free text.** Vague requests ("more context please") produce nothing useful. The round-1 prompt nudges validators toward specific paths or symbols, but model behavior here is best-effort, not enforced.
- **One info-gathering follow-up round.** Round 2 does not re-trigger another gather. If the round-2 LLMs need yet more context, they can't ask for it.
- **`Model1` is the info-gatherer and deduplicator.** No dedicated config field — re-order your validators if you want a cheaper model in these roles.

### Endpoint compatibility

`MODELn_API_BASE` is consumed by **two** clients with different needs, so it must point at an **OpenAI-compatible `chat/completions`** endpoint:

- **Validator** (always active): calls `${MODELn_API_BASE}/chat/completions` directly.
- **Review pass** (`MODELn_REVIEW=true`): runs pi in Docker with `--provider MODELn_PROVIDER`. For `anthropic`/`google`/most providers pi uses its **built-in** base URL and **ignores** `MODELn_API_BASE`; only `azure-openai-responses` reads it (as `AZURE_OPENAI_BASE_URL`).

OpenAI-compatible base URLs for common providers (these satisfy the validator, while the review pass routes by `MODELn_PROVIDER`):

| Provider (`MODELn_PROVIDER`) | `MODELn_API_BASE` (validator) | Key env var (review pass) |
|------|------|------|
| `anthropic` | `https://api.anthropic.com/v1/` | `ANTHROPIC_API_KEY` |
| `google` (Gemini) | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `azure-openai-responses` | `https://<resource>.openai.azure.com/openai/v1` | `AZURE_OPENAI_API_KEY` |

The single `MODELn_API_KEY` you set serves both paths (forwarded to pi under the provider's key env var automatically). Azure OpenAI also needs `MODELn_AUTH_HEADER=api-key` + `MODELn_MAX_TOKEN_PARAM=max_tokens`. Models that do not support `json_schema` response format can use `MODELn_SUPPORTS_STRUCTURED_OUTPUT=false` (falls back to prompt-only JSON; the validator's lenient parse handles the missing `infoRequest` field automatically).

### Fix PRs (3-round improvement loop)

1. The review model applies the fix; the remaining models validate the diff.
2. If all validators approve, the PR is created.
3. If any validator flags issues, the feedback is fed back for revision.
4. Up to 3 rounds. If validators cannot agree, the failure is summarized and the fix is abandoned.

### Cost tracking

Every LLM call in both flows is measured and attributed to its model:

- **Review flow** — the summary comment's footer aggregates, per model: review pass, same-run dedup, info-gather (both passes), validation rounds 1+2, suggestion proposals (`proposeFixes` pi-run) and suggestion votes, and fix-prompt drafting.
- **Fix / autofix flow** — the mention reply carries its own footer covering the pi fix run, revision runs, the lint-fix run, and all fix-validation rounds (including failure summaries and rejection prompts).

```
Model1: 1,200 in / 300 out · Model2: 800 in / 150 out · Model3: 900 in / 200 out
Est. cost: ~0.0234 EUR
```

Pi-runner costs are attributed to the review model that ran them, costed with that model's `INPUT_COST`/`OUTPUT_COST` rates.

### Summarizer (Bamboo changelog — not PR review)

The `SUMMARIZER_*` variables configure a separate model used exclusively for generating changelog summaries in audit fix PRs (the Bamboo flow). This model is not involved in PR review or validation.

---

## Loop prevention

The bot must never trigger itself. Six mechanisms ensure that:

1. **Bot branch filtering** — Both pollers skip PRs whose source branch starts with `audit/` or `carrot/`. All bot-created branches use these prefixes.
2. **Author-based comment detection** — The bot has a dedicated Bitbucket user (`carrot`). The mention scanner skips comments authored by the bot and checks for bot-authored child replies before processing.
3. **State-first dedup** — `processedMentionIds` in `data/state.json` is checked before any API call. `getComment()` confirms via bot-authored child reply. `lastActivityId` watermark gates top-level activity.
4. **Build key tracking** — Each build result key is stored in `data/bamboo-state.json` after first check.
5. **One review per PR** — Auto-review only runs on first encounter. Subsequent reviews require explicit `@carrot` mention.
6. **Audit PR idempotency** — One audit PR per (repo, target branch). Tracked in `auditPrs` state map.

---

## State files

### `data/state.json` — PR review state

```javascript
{
  repos: {
    "PROJECT/slug": {
      pullRequests: {
        "123": {
          lastReviewedCommit: "abc123",
          lastCheckedAt: "2026-03-23T...",
          lastActivityId: 47500,
          processedMentionIds: [9405, ...]  // max 200
        }
      }
    }
  }
}
```

On Bitbucket Cloud deployments, the `PROJECT/slug` repo key becomes `workspace/slug` (e.g. `my-workspace/example-repo`). State files are not portable between providers — use a fresh `data/` directory when switching.

### `data/bamboo-state.json` — Build + audit PR state

```javascript
{
  builds: {
    "PROJ-PLAN-7": {
      checkedAt: "2026-03-23T...",
      state: "Failed",
      auditIssue: true,
      status: "fix_applied",
      vulnerabilities: [...]
    }
  },
  auditPrs: {
    "PROJ/example-repo:master": {
      auditBranch: "audit/2026.03.23-14.30",
      prId: 456,
      targetBranch: "master",
      lastUpdated: "2026-03-23T..."
    }
  }
}
```

### Other data directories

- `data/audit-verify-failures/` — npm audit output when fixes still fail (last 20 kept)
- `data/pi-dumps/` — last 10 AI outputs for debugging (timestamped JSONL)
- `data/heartbeat` — written each poll cycle, used by Docker HEALTHCHECK
- `/tmp/carrot/` — temp workspaces, wiped at start of each PR poll cycle

---

## AI review (Docker-isolated)

The `pi` coding agent runs in a disposable Docker container. On each invocation:

1. Write diff patches + script to temp dir
2. `docker run --rm` with workspace mount + LLM credentials
3. Pi executes review, output captured to file
4. Container removed, temp dir cleaned up

The Docker image is configurable per-repo via `dockerImage` in `.carrot.jsonc`.

---

## Security

- All external process calls use `execFileSync` (array-based args, no shell interpreter) to prevent shell injection
- Docker containers run as the host user (`--user uid:gid`), never as root
- Bot has a dedicated Bitbucket user — comments identified by author, not prefix
- API keys are redacted in debug logs
- AI review is excluded from audit fixes to prevent prompt injection from malicious packages

## Debug logs

Debug logging is controlled by `Diagnostics.DebugLogs`:

- **Off** in production (default)
- **On** in development (`NODE_ENV=development`)
- Override: `DIAGNOSTICS_DEBUG_LOGS=true`

## Identity

The bot runs as a dedicated Bitbucket user (`carrot`). Comments are identified by author. Mention the bot with `@carrot`.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 chax.at.
