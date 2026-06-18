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
