# Reviewer Personas (model × persona matrix) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each review model declare one or more *roles* (personas) in env, run it once per role with a role-focused prompt, and validate the role config at startup so a misconfigured council can't start.

**Architecture:** A new pure `personas` module owns the role allowlist, per-role prompt directives, env parsing, prompt assembly, and the startup "correctness floor" check. `bootstrap` parses each review model's `Roles` into `IReviewModel.roles` and fails fast on bad config. The review loop expands the active reviewers into a model×role run list and tags every finding with its `persona`. The existing dedup/validation pipeline is unchanged — it already spreads findings, so the extra field passes through.

**Tech Stack:** TypeScript, Node, the `config` npm package (typed via `src/safe-config.ts` off `config/default.json`), Vitest, Docker-run `pi` prompt runner.

## Global Constraints

- **Interface naming:** `I` prefix for interfaces (e.g. `IReviewerRun`). (project CLAUDE.md)
- **Arrow functions** for closures inside methods, not `function` declarations. (project CLAUDE.md)
- **No nested ternaries.** (project CLAUDE.md)
- **No puns/jokes/humor** in any output text, including error messages and log lines.
- **Role allowlist (exact tokens, lowercase):** `correctness`, `security`, `readability`, `generic`.
- **`generic` = today's behavior:** its directive is the current prompt line `Focus on: security issues, bugs, code standard violations.` copied verbatim.
- **`Review` is the only on/off switch.** A review-enabled model always has ≥1 role; a blank `Roles` while `Review:true` is a startup error (not a way to opt out).
- **Config is typed off `default.json`.** Any new key (`Roles`) MUST be added to `config/default.json` or `config.get('ModelN.Roles')` will not type-check.
- **Env var format:** node-config maps env via `config/custom-environment-variables.json`. `Roles` is a plain comma-separated string env var (e.g. `MODEL2_ROLES="security,correctness"`).

---

### Task 1: Personas module (allowlist, directives, parsing, prompt, floor check)

**Files:**
- Create: `src/reviewer/personas.ts`
- Test: `test/reviewer/personas.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const REVIEW_PERSONAS = ['correctness','security','readability','generic'] as const`
  - `type ReviewPersona = (typeof REVIEW_PERSONAS)[number]`
  - `const PERSONA_DIRECTIVES: Record<ReviewPersona, string>`
  - `function parseRoles(raw: string, modelName: string): ReviewPersona[]`
  - `function assertCorrectnessCovered(roleLists: ReviewPersona[][]): void`
  - `function buildReviewPrompt(directive: string, hasExistingComments: boolean): string`

- [ ] **Step 1: Write the failing test**

```typescript
// test/reviewer/personas.test.ts
import { describe, it, expect } from 'vitest';
import {
  REVIEW_PERSONAS,
  PERSONA_DIRECTIVES,
  parseRoles,
  assertCorrectnessCovered,
  buildReviewPrompt,
} from '../../src/reviewer/personas';

describe('parseRoles', () => {
  it('parses a single role', () => {
    expect(parseRoles('security', 'Model2')).toEqual(['security']);
  });

  it('parses multiple roles and is case/space insensitive', () => {
    expect(parseRoles(' Security , Correctness ', 'Model2')).toEqual(['security', 'correctness']);
  });

  it('defaults are NOT applied here — "generic" is just a normal role', () => {
    expect(parseRoles('generic', 'Model1')).toEqual(['generic']);
  });

  it('throws on a blank string (use Review:false to opt out)', () => {
    expect(() => parseRoles('   ', 'Model3')).toThrow(/Model3\.Roles is blank/);
  });

  it('throws on an empty entry from a stray comma', () => {
    expect(() => parseRoles('security,', 'Model3')).toThrow(/empty entry/);
  });

  it('throws on an unknown role, naming the model and token', () => {
    expect(() => parseRoles('securty', 'Model4')).toThrow(/Model4\.Roles has unknown role "securty"/);
  });

  it('throws on a duplicate role', () => {
    expect(() => parseRoles('security,security', 'Model2')).toThrow(/duplicate role "security"/);
  });
});

describe('assertCorrectnessCovered', () => {
  it('passes when a model has the correctness role', () => {
    expect(() => assertCorrectnessCovered([['security'], ['correctness']])).not.toThrow();
  });

  it('passes when a model is generic (generic covers correctness)', () => {
    expect(() => assertCorrectnessCovered([['security'], ['generic']])).not.toThrow();
  });

  it('throws when no model covers correctness or generic', () => {
    expect(() => assertCorrectnessCovered([['security'], ['readability']])).toThrow(/No review model covers correctness/);
  });
});

describe('buildReviewPrompt', () => {
  it('embeds the directive and omits the comments line when there are none', () => {
    const prompt = buildReviewPrompt(PERSONA_DIRECTIVES.security, false);
    expect(prompt).toContain(PERSONA_DIRECTIVES.security);
    expect(prompt).toContain('Ignore lock files');
    expect(prompt).not.toContain('existing-comments.md');
  });

  it('appends the comments line when existing comments are present', () => {
    const prompt = buildReviewPrompt(PERSONA_DIRECTIVES.generic, true);
    expect(prompt).toContain('existing-comments.md');
  });

  it('generic directive equals the current hardcoded focus line', () => {
    expect(PERSONA_DIRECTIVES.generic).toBe('Focus on: security issues, bugs, code standard violations.');
  });

  it('every allowlisted persona has a directive', () => {
    for (const p of REVIEW_PERSONAS) {
      expect(typeof PERSONA_DIRECTIVES[p]).toBe('string');
      expect(PERSONA_DIRECTIVES[p].length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reviewer/personas.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/reviewer/personas"`.

- [ ] **Step 3: Write the module**

```typescript
// src/reviewer/personas.ts

/** Review roles a model can be assigned. `generic` reproduces the original
 *  all-purpose review prompt; the others narrow the model's attention to one
 *  lens so the council covers each lens explicitly. */
export const REVIEW_PERSONAS = ['correctness', 'security', 'readability', 'generic'] as const;

export type ReviewPersona = (typeof REVIEW_PERSONAS)[number];

/** The focus line injected into the review prompt for each role. `generic` is
 *  copied verbatim from the original single prompt. */
export const PERSONA_DIRECTIVES: Record<ReviewPersona, string> = {
  generic: 'Focus on: security issues, bugs, code standard violations.',
  correctness:
    'Focus ONLY on correctness: logic errors, off-by-one and boundary mistakes, null/undefined handling, ' +
    'incorrect control flow, race conditions, broken or missing error handling, and mismatches between the code ' +
    'and its apparent intent. Do not report style-only or security-only issues.',
  security:
    'Focus ONLY on security: injection (SQL/command/path), unsafe input handling, authentication and ' +
    'authorization gaps, secret or credential exposure, unsafe deserialization, and insecure use of crypto or ' +
    'randomness. Do not report style-only or general-correctness issues.',
  readability:
    'Focus ONLY on readability and maintainability: unclear naming, dead code, overly complex or duplicated ' +
    'logic, missing or misleading comments where intent is non-obvious, and violations of the provided code ' +
    'standards. Do not report security or runtime-correctness issues.',
};

/**
 * Parse a model's comma-separated `Roles` env string into validated personas.
 * Throws (fail-fast at startup) on a blank string, an empty entry, an unknown
 * role, or a duplicate. `modelName` is used only for error messages.
 */
export const parseRoles = (raw: string, modelName: string): ReviewPersona[] => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(
      `${modelName}.Roles is blank — set at least one role (${REVIEW_PERSONAS.join(', ')}) ` +
        `or disable the model with Review:false`,
    );
  }
  const tokens = trimmed.split(',').map((t) => t.trim().toLowerCase());
  const seen = new Set<string>();
  const roles: ReviewPersona[] = [];
  for (const tok of tokens) {
    if (!tok) {
      throw new Error(`${modelName}.Roles has an empty entry (check for stray commas): "${raw}"`);
    }
    if (!REVIEW_PERSONAS.includes(tok as ReviewPersona)) {
      throw new Error(`${modelName}.Roles has unknown role "${tok}". Allowed: ${REVIEW_PERSONAS.join(', ')}`);
    }
    if (seen.has(tok)) {
      throw new Error(`${modelName}.Roles has duplicate role "${tok}"`);
    }
    seen.add(tok);
    roles.push(tok as ReviewPersona);
  }
  return roles;
};

/**
 * Startup floor check: at least one review model must cover correctness, either
 * via an explicit `correctness` role or a `generic` model (which reviews
 * everything). Throws if the council can't catch bugs.
 */
export const assertCorrectnessCovered = (roleLists: ReviewPersona[][]): void => {
  const covered = roleLists.some((roles) => roles.includes('correctness') || roles.includes('generic'));
  if (!covered) {
    throw new Error(
      'No review model covers correctness. Add the "correctness" role (or "generic") to at least one ' +
        'review-enabled model.',
    );
  }
};

/**
 * Assemble the review prompt. Shared across all roles; only `directive` (the
 * focus line) changes per role. Mirrors the original prompt structure.
 */
export const buildReviewPrompt = (directive: string, hasExistingComments: boolean): string => {
  const promptLines = [
    'Review this PR diff. Return a JSON object with a "findings" array.',
    'Each finding must have: filePath (string), line (number), severity (concern|suggestion|note), comment (string).',
    directive,
    'Only review the diff, not surrounding code.',
    'Ignore lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, etc.) entirely.',
    'If no issues found, return {"findings": []}.',
  ];
  if (hasExistingComments) {
    promptLines.push(
      "existing-comments.md lists comments already posted on these files. If a comment's issue is now addressed " +
        'in the diff, do NOT re-raise it; only report what is still a real problem.',
    );
  }
  return promptLines.join(' ');
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/reviewer/personas.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/reviewer/personas.ts test/reviewer/personas.test.ts
git commit -m "feat(reviewer): add personas module (roles, directives, parsing, floor check)"
```

---

### Task 2: Add `Roles` to config schema and env mapping

**Files:**
- Modify: `config/default.json` (each of `Model1`–`Model4`)
- Modify: `config/custom-environment-variables.json` (each of `Model1`–`Model4`)
- Test: `test/config/model-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.get('Model1.Roles')` … `config.get('Model4.Roles')` typed as `string`, default `"generic"`, env-overridable via `MODEL1_ROLES`…`MODEL4_ROLES`.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('model config', ...)` block in `test/config/model-config.test.ts`:

```typescript
  it('defaults every model Roles to "generic"', () => {
    expect(config.get('Model1.Roles')).toBe('generic');
    expect(config.get('Model2.Roles')).toBe('generic');
    expect(config.get('Model3.Roles')).toBe('generic');
    expect(config.get('Model4.Roles')).toBe('generic');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/model-config.test.ts`
Expected: FAIL — TypeScript error / `config.get('Model1.Roles')` key does not exist (and/or value `undefined`).

- [ ] **Step 3: Add the key to `config/default.json`**

In EACH of `Model1`, `Model2`, `Model3`, `Model4`, add a `"Roles"` field. Insert it immediately after the `"Validate"` line. Example for `Model1` (apply the identical addition to all four):

```json
    "Review": false,
    "Validate": true,
    "Roles": "generic",
    "Provider": "azure-openai-responses",
```

- [ ] **Step 4: Add the env mapping to `config/custom-environment-variables.json`**

In EACH of `Model1`–`Model4`, add a `"Roles"` mapping. Insert it after the `"Validate"` mapping. Example for `Model1` (use `MODEL2_ROLES`, `MODEL3_ROLES`, `MODEL4_ROLES` for the others):

```json
    "Review": { "__name": "MODEL1_REVIEW", "__format": "boolean" },
    "Validate": { "__name": "MODEL1_VALIDATE", "__format": "boolean" },
    "Roles": "MODEL1_ROLES",
    "Provider": "MODEL1_PROVIDER",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/config/model-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/default.json config/custom-environment-variables.json test/config/model-config.test.ts
git commit -m "feat(config): add per-model Roles (default generic, env MODELn_ROLES)"
```

---

### Task 3: Inject the persona directive into the review prompt (`pi.service`)

**Files:**
- Modify: `src/reviewer/pi.service.ts` (`reviewBatch`, lines ~310–347)
- Test: `test/reviewer/pi.service.test.ts` (existing suite, regression only)

**Interfaces:**
- Consumes: `buildReviewPrompt`, `PERSONA_DIRECTIVES` from Task 1.
- Produces: `reviewBatch(diffs, codeStandards, existingComments, dockerImageOverride?, personaDirective?: string)` — `personaDirective` defaults to `PERSONA_DIRECTIVES.generic`, preserving current behavior for callers that omit it.

- [ ] **Step 1: Add the import**

At the top of `src/reviewer/pi.service.ts`, alongside the other imports, add:

```typescript
import { buildReviewPrompt, PERSONA_DIRECTIVES } from './personas';
```

- [ ] **Step 2: Add the `personaDirective` parameter to `reviewBatch`**

Change the signature (lines ~310–315) from:

```typescript
  public reviewBatch(
    diffs: string[],
    codeStandards: string | null,
    existingComments: string | null,
    dockerImageOverride?: string,
  ): IPiReviewResult {
```

to:

```typescript
  public reviewBatch(
    diffs: string[],
    codeStandards: string | null,
    existingComments: string | null,
    dockerImageOverride?: string,
    personaDirective: string = PERSONA_DIRECTIVES.generic,
  ): IPiReviewResult {
```

- [ ] **Step 3: Replace the inline prompt construction with `buildReviewPrompt`**

Replace the block at lines ~334–347 (from `const promptLines = [` through `const prompt = promptLines.join(' ');`) with:

```typescript
      const prompt = buildReviewPrompt(personaDirective, Boolean(commentsArg));
```

(`commentsArg` is still computed above this point — keep it; it also drives the `@/workspace/existing-comments.md` mount argument.)

- [ ] **Step 4: Run the existing pi.service suite and typecheck to verify no regression**

Run: `npx vitest run test/reviewer/pi.service.test.ts && npx tsc --noEmit`
Expected: PASS — existing tests green, no type errors. (Behavioral coverage of prompt assembly lives in Task 1's `buildReviewPrompt` tests; this task is wiring, so it has no new failing test.)

- [ ] **Step 5: Commit**

```bash
git add src/reviewer/pi.service.ts
git commit -m "feat(reviewer): drive review prompt from a per-run persona directive"
```

---

### Task 4: Expand reviewers into a model×role matrix and tag findings

**Files:**
- Modify: `src/types/index.ts` (`IAuthoredFinding`)
- Modify: `src/reviewer/reviewer.service.ts` (`IReviewModel`, new `expandReviewerRuns`, the review loop ~437–456)
- Test: `test/reviewer/expand-reviewer-runs.test.ts`

**Interfaces:**
- Consumes: `ReviewPersona`, `PERSONA_DIRECTIVES` from Task 1; `reviewBatch(..., personaDirective)` from Task 3.
- Produces:
  - `IReviewModel.roles: ReviewPersona[]` (new required field)
  - `IAuthoredFinding.persona?: string` (new optional field)
  - `interface IReviewerRun { model: IReviewModel; role: ReviewPersona; }`
  - `function expandReviewerRuns(reviewers: IReviewModel[]): IReviewerRun[]`

- [ ] **Step 1: Write the failing test**

```typescript
// test/reviewer/expand-reviewer-runs.test.ts
import { describe, it, expect } from 'vitest';
import { expandReviewerRuns, type IReviewModel } from '../../src/reviewer/reviewer.service';

const model = (name: string, roles: IReviewModel['roles']): IReviewModel =>
  ({ name, roles, pi: {} as IReviewModel['pi'], inputCostPer1M: 0, outputCostPer1M: 0 });

describe('expandReviewerRuns', () => {
  it('produces one run per (model, role) pair', () => {
    const runs = expandReviewerRuns([model('A', ['correctness', 'security']), model('B', ['generic'])]);
    expect(runs.map((r) => `${r.model.name}:${r.role}`)).toEqual(['A:correctness', 'A:security', 'B:generic']);
  });

  it('returns an empty list when there are no reviewers', () => {
    expect(expandReviewerRuns([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reviewer/expand-reviewer-runs.test.ts`
Expected: FAIL — `expandReviewerRuns` is not exported / `roles` missing on `IReviewModel`.

- [ ] **Step 3: Add the `persona` field to `IAuthoredFinding`**

In `src/types/index.ts`, change the `IAuthoredFinding` interface (lines 9–18) to add `persona`:

```typescript
export interface IAuthoredFinding extends IReviewFinding {
  author: string;
  /** The review role (persona) that produced this finding, e.g. "security". */
  persona?: string;
  contributingAuthors?: string[];
}
```

- [ ] **Step 4: Add `roles` to `IReviewModel` and the `expandReviewerRuns` helper**

In `src/reviewer/reviewer.service.ts`, add the import near the other `./` imports:

```typescript
import type { ReviewPersona } from './personas';
import { PERSONA_DIRECTIVES } from './personas';
```

Change `IReviewModel` (lines 34–39) to add `roles`:

```typescript
export interface IReviewModel {
  name: string;
  pi: PiService;
  roles: ReviewPersona[];
  inputCostPer1M: number;
  outputCostPer1M: number;
}
```

Add the run type and helper next to `groupFindingsByFile` (after line 50):

```typescript
/** A single review pass: one model running one of its roles. */
export interface IReviewerRun {
  model: IReviewModel;
  role: ReviewPersona;
}

/** Flatten active reviewers into one run per (model, role) pair, in order. */
export function expandReviewerRuns(reviewers: IReviewModel[]): IReviewerRun[] {
  const runs: IReviewerRun[] = [];
  for (const model of reviewers) {
    for (const role of model.roles) {
      runs.push({ model, role });
    }
  }
  return runs;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/reviewer/expand-reviewer-runs.test.ts`
Expected: PASS.

- [ ] **Step 6: Rewrite the review loop to iterate over runs**

In `src/reviewer/reviewer.service.ts`, locate the log line and loop at lines ~438–456. Replace the existing `LogSink.info(...active reviewers...)` call and the `for (const rm of activeReviewers) { ... }` loop with:

```typescript
    const runs = expandReviewerRuns(activeReviewers);
    LogSink.info(
      `PR #${prId}: ${runs.length} review run(s) across ${activeReviewers.length}/${this.reviewModels.length} ` +
        `model(s): ${runs.map((r) => `${r.model.name}/${r.role}`).join(', ')}`,
      TraceTags.REVIEWER,
    );

    const allFindings: IAuthoredFinding[] = [];
    const reviewUsage: IModelUsage[] = [];
    for (const { model: rm, role } of runs) {
      try {
        const batch = rm.pi.reviewBatch(reviewable, standards, reviewCommentContext, dockerImage, PERSONA_DIRECTIVES[role]);
        for (const f of batch.findings) {
          allFindings.push({ ...f, author: rm.name, persona: role });
        }
        reviewUsage.push(this.toModelUsage(rm, batch.usage));
      } catch (err) {
        LogSink.warn(`PR #${prId}: review model ${rm.name} (role ${role}) failed: ${err}`, TraceTags.REVIEWER);
      }
    }
```

Note: the existing failure guard immediately below (`if (reviewUsage.length === 0) throw ...`) and the `allFindings.length === 0` branch stay as-is — leave them unchanged.

- [ ] **Step 7: Verify the full reviewer suite and typecheck**

Run: `npx vitest run test/reviewer && npx tsc --noEmit`
Expected: PASS. (If `tsc` flags other `IReviewModel` literals missing `roles`, the only production constructor is in `bootstrap.ts`, fixed in Task 5; test fixtures must set `roles`. Existing test fixtures that build an `IReviewModel` need `roles: ['generic']` added — update them if `tsc` flags them.)

- [ ] **Step 8: Commit**

```bash
git add src/types/index.ts src/reviewer/reviewer.service.ts test/reviewer/expand-reviewer-runs.test.ts
git commit -m "feat(reviewer): run each model once per role and tag findings with persona"
```

---

### Task 5: Parse roles and enforce the correctness floor at startup (`bootstrap`)

**Files:**
- Modify: `src/bootstrap.ts` (`buildReviewModel` ~90–110; after `reviewModels` is built ~113–119)
- Test: `test/bootstrap.test.ts` (existing suite, regression) + typecheck

**Interfaces:**
- Consumes: `parseRoles`, `assertCorrectnessCovered` from Task 1; `IReviewModel.roles` from Task 4.
- Produces: review models built with `roles`; process throws on bad role config before polling starts.

- [ ] **Step 1: Add the import**

In `src/bootstrap.ts`, add near the other `./reviewer/...` imports:

```typescript
import { parseRoles, assertCorrectnessCovered } from './reviewer/personas';
```

- [ ] **Step 2: Populate `roles` in `buildReviewModel`**

In `buildReviewModel` (lines ~104–109), add `roles` to the returned object. The model name is needed for error messages, so compute it first:

```typescript
    const name = config.get(`${key}.Name`) || key;
    return {
      name,
      pi,
      roles: parseRoles(config.get(`${key}.Roles`), name),
      inputCostPer1M: config.get(`${key}.InputTokenCostPer1M`),
      outputCostPer1M: config.get(`${key}.OutputTokenCostPer1M`),
    };
```

(`parseRoles` throws here for review-enabled models with bad `Roles`, aborting startup. Non-review models return `null` earlier at line 91 and are never parsed.)

- [ ] **Step 3: Enforce the correctness floor after the council is built**

Immediately after `const reviewModels = modelKeys.map(buildReviewModel).filter(Boolean) as IReviewModel[];` (line ~113), add:

```typescript
  if (reviewModels.length > 0) {
    assertCorrectnessCovered(reviewModels.map((m) => m.roles));
  }
```

(Guarded on `length > 0`: a zero-reviewer setup is already handled by the existing warn at line ~117–119; the floor only applies when reviewers exist.)

- [ ] **Step 4: Run the bootstrap suite and typecheck**

Run: `npx vitest run test/bootstrap.test.ts && npx tsc --noEmit`
Expected: PASS — no type errors, bootstrap tests green.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS — entire suite green.

- [ ] **Step 6: Commit**

```bash
git add src/bootstrap.ts
git commit -m "feat(bootstrap): parse per-model roles and enforce the correctness floor at startup"
```

---

## Out of scope (explicit)

- **Persona aggregation through dedup.** The deduplicator spreads findings, so `persona` passes through and the merged finding carries the representative finding's `persona`; tracking the full set of contributing personas through a merge is a separate change and not done here.
- **Per-role model selection** (e.g. routing `security` to a stronger model). The matrix is `sampled models × their own roles`; narrowing models per role is a future refinement.
- **Surfacing `persona` in posted PR comments / validation prompts.** Attribution display is unchanged.
