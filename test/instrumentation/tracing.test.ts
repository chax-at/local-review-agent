import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { runInRootSpan } from '../../src/instrumentation/tracing';

describe('runInRootSpan', () => {
  const exporter = new InMemorySpanExporter();

  // The tracer of the app keeps the first registered provider, therefore all tests use the same one
  beforeAll(() => {
    new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterAll(() => {
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('starts a new trace with a link to the span of the caller', async () => {
    await runInRootSpan('poll cycle', {}, () => runInRootSpan('PR review', { 'vcs.change.id': 7 }, async () => {}));

    const [review, pollCycle] = exporter.getFinishedSpans();
    expect(review.name).toBe('PR review');
    expect(review.parentSpanContext).toBeUndefined();
    expect(review.spanContext().traceId).not.toBe(pollCycle.spanContext().traceId);
    expect(review.links.map((link) => link.context.spanId)).toEqual([pollCycle.spanContext().spanId]);
    expect(review.attributes).toEqual({ 'vcs.change.id': 7 });
  });

  it('marks the span as failed and rethrows when the work throws', async () => {
    await expect(
      runInRootSpan('PR review', {}, async () => {
        throw new Error('all review runs failed');
      }),
    ).rejects.toThrow('all review runs failed');

    const [review] = exporter.getFinishedSpans();
    expect(review.status).toEqual({ code: SpanStatusCode.ERROR, message: 'Error: all review runs failed' });
  });
});
