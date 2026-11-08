import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import LogSink, { LogLevel } from '@chax-at/log-sink';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeTracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { metricMeters } from '../../src/instrumentation/metrics';
import { ErrorTelemetryDrain } from '../../src/log/error-telemetry.drain';

describe('ErrorTelemetryDrain', () => {
  let provider: NodeTracerProvider;

  beforeEach(() => {
    provider = new NodeTracerProvider();
    provider.register();
    LogSink.registerDrain(new ErrorTelemetryDrain(), {
      enabled: true,
      minLevel: LogLevel.Error,
      maxLevel: LogLevel.Error,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    LogSink.reset();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  const logInActiveSpan = (log: () => void): ReadableSpan =>
    provider.getTracer('test').startActiveSpan('review', (span) => {
      log();
      span.end();
      return span as unknown as ReadableSpan;
    });

  it('counts a logged error with its tag as a background error', () => {
    const addError = vi.spyOn(metricMeters.errors, 'add');

    LogSink.error('PR #1: review failed', 'reviewer');

    expect(addError).toHaveBeenCalledWith(1, { type: 'reviewer', transport: 'background', log_level: 'error' });
  });

  it('marks the active span as failed, so that the trace of the error is exported', () => {
    const span = logInActiveSpan(() => LogSink.error('PR #1: review failed', 'reviewer'));

    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'PR #1: review failed' });
  });

  it('ignores a warning', () => {
    const addError = vi.spyOn(metricMeters.errors, 'add');

    const span = logInActiveSpan(() => LogSink.warn('PR #1: review model failed', 'reviewer'));

    // Without a meter provider, all counters share one no-op counter, which the span also uses, therefore the
    // assertion checks the labels of the error counter
    expect(addError).not.toHaveBeenCalledWith(1, expect.objectContaining({ log_level: 'error' }));
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });
});
