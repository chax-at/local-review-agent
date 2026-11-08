import { Context, ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';
import {
  ReadableSpan,
  SamplingDecision,
  Span,
  SpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_HTTP_RESPONSE_STATUS_CODE } from '@opentelemetry/semantic-conventions';

// Limits the memory of a long trace (e.g. a poll cycle over many repos). A dropped span still counts for the error
// status and for the open local roots of its trace.
const MAX_BUFFERED_SPANS_PER_TRACE = 1000;
// Above the limit, a small reserve keeps the error spans and the local roots of a full trace.
// The error spans leave the last reserved place free, because the local root usually ends last.
const RESERVED_SPANS_PER_TRACE = 10;

// The undici instrumentation marks every HTTP call with a 4xx answer as error, also the expected ones (e.g. the 404
// for a repo without a .carrot.jsonc). Server errors (5xx) and network errors still count, and a failed run logs an
// error, which marks its root span.
const UNDICI_SCOPE = '@opentelemetry/instrumentation-undici';

interface IPendingTrace {
  spans: ReadableSpan[];
  hasError: boolean;
  // A trace can have more than one local root (e.g. several spans with the same remote parent)
  openLocalRoots: number;
}

/**
 * Exports a trace if its trace id is in the sample ratio or if one of its spans has the error status.
 * The error status is only known at the end, therefore the spans of the other traces are buffered until the
 * local root span ends.
 */
export class TailSamplingSpanProcessor implements SpanProcessor {
  private readonly ratioSampler: TraceIdRatioBasedSampler;

  private readonly pendingTraces = new Map<string, IPendingTrace>();

  constructor(
    private readonly exportProcessor: SpanProcessor,
    sampleRatio: number,
  ) {
    this.ratioSampler = new TraceIdRatioBasedSampler(sampleRatio);
  }

  public onStart(span: Span, parentContext: Context): void {
    const { traceId } = span.spanContext();
    if (TailSamplingSpanProcessor.isLocalRoot(span) && !this.isInSampleRatio(traceId)) {
      const pendingTrace = this.pendingTraces.get(traceId) ?? { spans: [], hasError: false, openLocalRoots: 0 };
      pendingTrace.openLocalRoots++;
      this.pendingTraces.set(traceId, pendingTrace);
    }
    this.exportProcessor.onStart(span, parentContext);
  }

  public onEnd(span: ReadableSpan): void {
    const { traceId } = span.spanContext();
    const isError = TailSamplingSpanProcessor.isError(span);
    const pendingTrace = this.pendingTraces.get(traceId);
    if (!pendingTrace) {
      // The trace is in the sample ratio, or the span ended after its local root span
      if (isError || this.isInSampleRatio(traceId)) {
        this.exportProcessor.onEnd(span);
      }
      return;
    }

    const isLocalRoot = TailSamplingSpanProcessor.isLocalRoot(span);
    pendingTrace.hasError = pendingTrace.hasError || isError;
    if (TailSamplingSpanProcessor.canBuffer(pendingTrace.spans.length, isError, isLocalRoot)) {
      pendingTrace.spans.push(span);
    }
    if (isLocalRoot) {
      pendingTrace.openLocalRoots--;
    }
    if (pendingTrace.openLocalRoots > 0) {
      return;
    }

    this.pendingTraces.delete(traceId);
    if (pendingTrace.hasError) {
      pendingTrace.spans.forEach((pendingSpan) => this.exportProcessor.onEnd(pendingSpan));
    }
  }

  public async forceFlush(): Promise<void> {
    this.exportBufferedErrorSpans();
    return this.exportProcessor.forceFlush();
  }

  public async shutdown(): Promise<void> {
    this.exportBufferedErrorSpans();
    this.pendingTraces.clear();
    return this.exportProcessor.shutdown();
  }

  /**
   * A pending trace is never in the sample ratio, therefore only the traces with an error are exported.
   * The local root can still be open (e.g. a review run), therefore the trace stays pending and the spans that end
   * later are exported when the local root ends.
   */
  private exportBufferedErrorSpans(): void {
    for (const pendingTrace of this.pendingTraces.values()) {
      if (!pendingTrace.hasError) {
        continue;
      }
      pendingTrace.spans.forEach((pendingSpan) => this.exportProcessor.onEnd(pendingSpan));
      pendingTrace.spans = [];
    }
  }

  private isInSampleRatio(traceId: string): boolean {
    return this.ratioSampler.shouldSample(ROOT_CONTEXT, traceId).decision === SamplingDecision.RECORD_AND_SAMPLED;
  }

  private static isError(span: ReadableSpan): boolean {
    if (span.status.code !== SpanStatusCode.ERROR) {
      return false;
    }
    if (span.instrumentationScope.name !== UNDICI_SCOPE) {
      return true;
    }
    const statusCode = span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE];
    return typeof statusCode !== 'number' || statusCode >= 500;
  }

  private static canBuffer(bufferedCount: number, isError: boolean, isLocalRoot: boolean): boolean {
    if (bufferedCount < MAX_BUFFERED_SPANS_PER_TRACE) {
      return true;
    }
    if (isLocalRoot) {
      return bufferedCount < MAX_BUFFERED_SPANS_PER_TRACE + RESERVED_SPANS_PER_TRACE;
    }
    if (isError) {
      return bufferedCount < MAX_BUFFERED_SPANS_PER_TRACE + RESERVED_SPANS_PER_TRACE - 1;
    }
    return false;
  }

  private static isLocalRoot(span: ReadableSpan): boolean {
    return !span.parentSpanContext || span.parentSpanContext.isRemote === true;
  }
}
