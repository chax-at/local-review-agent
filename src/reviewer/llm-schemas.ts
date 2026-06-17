import z from 'zod';
import type { IJsonSchema } from './llm-client';

/** Schema for validateFindings response: each finding gets a relevance vote + reasoning */
export const FindingsValidationSchema = z.object({
  results: z.array(
    z.object({
      index: z.number(),
      relevant: z.boolean(),
      thought: z.string(),
    }),
  ),
});

/**
 * Round-1 vote schema with an extra `infoRequest` field. When a validator can
 * not confidently judge a finding without more context, it can ask the
 * info-gatherer for specific files / symbols via this field. Empty string
 * means "no request". Used only in round 1; deliberation and suggestion votes
 * reuse the base FindingsValidationSchema.
 */
export const FindingsValidationWithInfoSchema = z.object({
  results: z.array(
    z.object({
      index: z.number(),
      relevant: z.boolean(),
      thought: z.string(),
      infoRequest: z.string(),
    }),
  ),
});

/**
 * Schema for the FindingDeduplicator response. The model clusters a single
 * file's findings: each cluster lists the member indexes that describe the same
 * issue, plus a `mergedComment` that combines their reasons when 2+ members are
 * merged (empty string for a single-member cluster).
 */
export const DedupClustersSchema = z.object({
  clusters: z.array(
    z.object({
      memberIndexes: z.array(z.number()),
      mergedComment: z.string(),
    }),
  ),
});

/** Schema for validateFix response: whether the fix needs changes + reasoning */
export const FixValidationSchema = z.object({
  needsChange: z.boolean(),
  reason: z.string(),
});

/** Convert a zod schema to a JSON Schema payload for structured output */
function toJsonSchema(schema: z.ZodObject, name: string): IJsonSchema {
  const jsonSchema = schema.toJSONSchema({
    io: 'input',
    override: (ctx) => {
      if (ctx.zodSchema instanceof z.ZodObject) {
        ctx.jsonSchema.additionalProperties = false;
      }
    },
  });
  delete jsonSchema.$schema;
  return { name, schema: jsonSchema as Record<string, unknown> };
}

export const findingsValidationJsonSchema = toJsonSchema(FindingsValidationSchema, 'findings_validation');
export const findingsValidationWithInfoJsonSchema = toJsonSchema(
  FindingsValidationWithInfoSchema,
  'findings_validation_with_info',
);
export const fixValidationJsonSchema = toJsonSchema(FixValidationSchema, 'fix_validation');
export const dedupClustersJsonSchema = toJsonSchema(DedupClustersSchema, 'dedup_clusters');

/**
 * Schema for InfoGatherer response. `type` selects what `target` means:
 *  - 'file'   → target is a repo-relative file path to load whole
 *  - 'search' → target is a symbol / string to grep for
 *
 * Each gather call is scoped to one finding-file, so no per-action routing is
 * needed — every action's output lands in that file's context blob.
 * Flat shape (vs discriminated union) so strict structured-output mode accepts it.
 */
export const InfoActionsSchema = z.object({
  actions: z.array(
    z.object({
      type: z.enum(['file', 'search']),
      target: z.string(),
    }),
  ),
});

export const infoActionsJsonSchema = toJsonSchema(InfoActionsSchema, 'info_actions');

/** Schema for LLM-routed mention intent detection */
export const MentionRouteSchema = z.object({
  tool: z.enum(['fix', 'autofix', 'revert', 'review', 'audit_fix', 'explain', 'reply', 'ignore']),
  message: z.string(),
  reasoning: z.string(),
});

export const mentionRouteJsonSchema = toJsonSchema(MentionRouteSchema, 'mention_route');

/** Extract JSON from raw LLM text — handles ```json fences and bare JSON */
export function extractJson(text: string): string {
  const s = text.trim();
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/m.exec(s);
  return fence ? fence[1].trim() : s;
}

/** Parse raw LLM text as JSON and validate against a zod schema. Returns null on failure. */
export function parseWithSchema<T extends z.ZodType>(text: string, schema: T): z.infer<T> | null {
  try {
    const json = JSON.parse(extractJson(text));
    return schema.parse(json);
  } catch {
    return null;
  }
}
