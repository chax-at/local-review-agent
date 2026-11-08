import { describe, it, expect, beforeEach } from 'vitest';
import {
  type Context,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Tracer,
} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { TailSamplingSpanProcessor } from '../../src/instrumentation/tail-sampling-span-processor';

const withParent = (span: Span): Context => trace.setSpan(ROOT_CONTEXT, span);

const endWithError = (span: Span): void => {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
};

describe('TailSamplingSpanProcessor', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let tracer: Tracer;

  const useProcessor = (exportProcessor: SpanProcessor, sampleRatio: number): void => {
    provider = new BasicTracerProvider({
      spanProcessors: [new TailSamplingSpanProcessor(exportProcessor, sampleRatio)],
    });
    tracer = provider.getTracer('test');
  };

  const exportedNames = (): string[] =>
    exporter
      .getFinishedSpans()
      .map((span) => span.name)
      .sort();

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    // Ratio 0: only traces with an error are exported
    useProcessor(new SimpleSpanProcessor(exporter), 0);
  });

  it('drops a trace without an error', () => {
    const root = tracer.startSpan('root');
    tracer.startSpan('child', {}, withParent(root)).end();
    root.end();

    expect(exportedNames()).toEqual([]);
  });

  it('exports the whole trace when a child has an error', () => {
    const root = tracer.startSpan('root');
    tracer.startSpan('child', {}, withParent(root)).end();
    endWithError(tracer.startSpan('failingChild', {}, withParent(root)));
    root.end();

    expect(exportedNames()).toEqual(['child', 'failingChild', 'root']);
  });

  it('ignores the error status of an HTTP client call with a 4xx answer', () => {
    // The undici instrumentation also marks expected answers (e.g. 404 for a missing .carrot.jsonc) as errors
    const undiciTracer = provider.getTracer('@opentelemetry/instrumentation-undici');
    const root = tracer.startSpan('root');
    endWithError(undiciTracer.startSpan('GET', { attributes: { 'http.response.status_code': 404 } }, withParent(root)));
    root.end();

    expect(exportedNames()).toEqual([]);
  });

  it('exports the trace of an HTTP client call with a 5xx answer or a network error', () => {
    const undiciTracer = provider.getTracer('@opentelemetry/instrumentation-undici');
    const serverErrorRoot = tracer.startSpan('serverErrorRoot');
    endWithError(
      undiciTracer.startSpan('GET', { attributes: { 'http.response.status_code': 503 } }, withParent(serverErrorRoot)),
    );
    serverErrorRoot.end();
    const networkErrorRoot = tracer.startSpan('networkErrorRoot');
    endWithError(undiciTracer.startSpan('POST', {}, withParent(networkErrorRoot)));
    networkErrorRoot.end();

    expect(exportedNames()).toEqual(['GET', 'POST', 'networkErrorRoot', 'serverErrorRoot']);
  });

  it('exports a trace without an error when the ratio is 1', () => {
    useProcessor(new SimpleSpanProcessor(exporter), 1);
    const root = tracer.startSpan('root');
    tracer.startSpan('child', {}, withParent(root)).end();
    root.end();

    expect(exportedNames()).toEqual(['child', 'root']);
  });

  it('buffers at most 1000 spans of a trace but keeps the error span and the root above the limit', () => {
    const root = tracer.startSpan('root');
    for (let i = 0; i < 1500; i++) {
      tracer.startSpan('child', {}, withParent(root)).end();
    }
    endWithError(tracer.startSpan('failingChild', {}, withParent(root)));
    root.end();

    const names = exportedNames();
    expect(names).toHaveLength(1002);
    expect(names).toContain('failingChild');
    expect(names).toContain('root');
  });

  it('keeps at most 9 error spans above the limit, so that the root still fits', () => {
    const root = tracer.startSpan('root');
    for (let i = 0; i < 1500; i++) {
      tracer.startSpan('child', {}, withParent(root)).end();
    }
    for (let i = 0; i < 20; i++) {
      endWithError(tracer.startSpan('failingChild', {}, withParent(root)));
    }
    root.end();

    // The limit of 1000 is full after the 1500 children. Of the reserve of 10 places, the 20 failing children get 9,
    // because the last place stays free for the root: 1000 + 9 + 1 = 1010
    const names = exportedNames();
    expect(names).toHaveLength(1010);
    expect(names.filter((name) => name === 'failingChild')).toHaveLength(9);
    expect(names).toContain('root');
  });

  it('exports the buffered spans of a failed trace with an open root on force flush', async () => {
    const reviewRoot = tracer.startSpan('reviewRoot');
    tracer.startSpan('child', {}, withParent(reviewRoot)).end();
    endWithError(tracer.startSpan('failingChild', {}, withParent(reviewRoot)));
    const otherRoot = tracer.startSpan('otherRoot');
    tracer.startSpan('otherChild', {}, withParent(otherRoot)).end();

    await provider.forceFlush();
    expect(exportedNames()).toEqual(['child', 'failingChild']);

    tracer.startSpan('lateChild', {}, withParent(reviewRoot)).end();
    reviewRoot.end();
    otherRoot.end();
    expect(exportedNames()).toEqual(['child', 'failingChild', 'lateChild', 'reviewRoot']);
  });

  it('exports the buffered spans of a failed trace with an open root on shutdown and clears the buffer', async () => {
    const endedNames: string[] = [];
    useProcessor(
      {
        onStart: () => {},
        onEnd: (span) => endedNames.push(span.name),
        forceFlush: async () => {},
        shutdown: async () => {},
      },
      0,
    );
    const reviewRoot = tracer.startSpan('reviewRoot');
    endWithError(tracer.startSpan('failingChild', {}, withParent(reviewRoot)));
    const otherRoot = tracer.startSpan('otherRoot');
    tracer.startSpan('otherChild', {}, withParent(otherRoot)).end();

    await provider.shutdown();
    expect(endedNames).toEqual(['failingChild']);

    // The buffer is cleared, therefore a span that ends after the shutdown is not exported
    reviewRoot.end();
    expect(endedNames).toEqual(['failingChild']);
  });

  it('waits for all local roots of a remote trace', () => {
    const remoteParent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    const firstRoot = tracer.startSpan('firstRoot', {}, remoteParent);
    const secondRoot = tracer.startSpan('secondRoot', {}, remoteParent);
    tracer.startSpan('firstChild', {}, withParent(firstRoot)).end();
    firstRoot.end();
    endWithError(secondRoot);

    expect(exportedNames()).toEqual(['firstChild', 'firstRoot', 'secondRoot']);
  });

  it('still counts the dropped local roots and error spans of a full trace', () => {
    const remoteParent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    const roots = Array.from({ length: 11 }, () => tracer.startSpan('root', {}, remoteParent));
    for (let i = 0; i < 1000; i++) {
      tracer.startSpan('child', {}, withParent(roots[0])).end();
    }
    // The first 10 roots fill the reserve: 1000 + 10 = 1010
    roots.slice(0, 10).forEach((root) => root.end());
    // Above the reserve: dropped, but the error still marks the trace as failed
    endWithError(tracer.startSpan('failingChild', {}, withParent(roots[10])));
    // Dropped, but it still closes the trace
    roots[10].end();

    expect(exportedNames()).toHaveLength(1010);

    // The trace is closed: a later span is not buffered, and only an error span is exported
    tracer.startSpan('lateChild', {}, withParent(roots[0])).end();
    endWithError(tracer.startSpan('lateError', {}, withParent(roots[0])));

    const names = exportedNames();
    expect(names).toHaveLength(1011);
    expect(names).toContain('lateError');
    expect(names).not.toContain('lateChild');
  });
});
