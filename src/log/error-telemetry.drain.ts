import { type ILogDrain, type LogOptions } from '@chax-at/log-sink';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { metricMeters } from '../instrumentation/metrics';

/**
 * Counts every logged error and marks the active span as failed, so that the TailSamplingSpanProcessor exports the
 * trace of a failed review or poll cycle. LogSink calls the drain synchronously in the context of the caller.
 */
export class ErrorTelemetryDrain implements ILogDrain {
  public async log(entry: LogOptions): Promise<void> {
    metricMeters.errors.add(1, {
      type: entry.tag ?? 'untagged',
      transport: 'background',
      log_level: 'error',
    });

    const activeSpan = trace.getActiveSpan();
    if (activeSpan?.isRecording()) {
      activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: entry.message });
    }
  }
}
