import { type Attributes, SpanStatusCode, trace } from '@opentelemetry/api';

export const INSTRUMENTATION_SCOPE = 'local-git-reviewer';

// Semantic convention keys from the incubating set, which OpenTelemetry advises to copy instead of import
export const ATTR_VCS_REPOSITORY_NAME = 'vcs.repository.name';
export const ATTR_VCS_CHANGE_ID = 'vcs.change.id';

export const tracer = trace.getTracer(INSTRUMENTATION_SCOPE);

/**
 * Runs the work as a trace of its own (a poll cycle, a review run, a mention, a ticket). The span of the caller (e.g.
 * the poll cycle that starts a review) becomes a link, not the parent: one trace for a whole poll cycle with all its
 * reviews would be too long to read.
 */
export function runInRootSpan<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  const callerSpan = trace.getActiveSpan();
  const links = callerSpan ? [{ context: callerSpan.spanContext() }] : [];
  return tracer.startActiveSpan(name, { root: true, attributes, links }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
