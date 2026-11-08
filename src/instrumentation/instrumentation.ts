// This runs before the log sink exists, therefore it uses console.log
/* eslint-disable no-console */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import * as OpenTelemetryAttribute from '@opentelemetry/semantic-conventions';
import config from '../safe-config';
import { TailSamplingSpanProcessor } from './tail-sampling-span-processor';

// Limits the wait for a slow collector. A review continues while the export waits, and a pi run that it starts
// blocks the event loop (spawnSync), so the exit can still wait for that run. The Docker stop grace period limits it.
// The limit is shorter than the export timeout (30 s), so a slow collector can lose the last spans.
const SHUTDOWN_TIME_LIMIT_MS = 3000;

let sdk: NodeSDK | null = null;

export function configureInstrumentation(): void {
  if (!config.get('Diagnostics.OpenTelemetry.Enabled')) {
    console.log('OpenTelemetry is disabled');
    return;
  }

  const endpoint = config.get('Diagnostics.OpenTelemetry.Endpoint');
  if (!endpoint) {
    console.error('DIAGNOSTICS_OPENTELEMETRY_ENDPOINT is not set. Exiting.');
    process.exit(1);
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  const tenantId = config.get('Diagnostics.OpenTelemetry.TenantId');
  // The tenant header selects the tenant in Loki, Tempo and VictoriaMetrics
  const headers = { 'X-Scope-OrgID': tenantId.toString() };
  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers });
  const metricExporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, headers });
  const logExporter = new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers });

  const resource = resourceFromAttributes({
    [OpenTelemetryAttribute.ATTR_SERVICE_NAME]: config.get('App.Name'),
    [OpenTelemetryAttribute.ATTR_SERVICE_VERSION]: config.get('App.Release'),
    [OpenTelemetryAttribute.SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: config.get('App.Environment'),
    vm_account_id: tenantId,
  });

  sdk = new NodeSDK({
    resource,
    // All HTTP calls (Bitbucket, Forgejo, Jira, LLM APIs) use the global fetch, which is undici
    instrumentations: [new UndiciInstrumentation()],
    spanProcessors: [
      new TailSamplingSpanProcessor(
        new BatchSpanProcessor(traceExporter),
        config.get('Diagnostics.OpenTelemetry.TraceSampleRatio'),
      ),
    ],
    // The TailSamplingSpanProcessor selects the traces to export, therefore all spans must be recorded
    sampler: new AlwaysOnSampler(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.get('Diagnostics.OpenTelemetry.MetricsExportIntervalSeconds') * 1000,
      }),
    ],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: logExporter })],
  });
  sdk.start();
  console.log('OpenTelemetry is enabled');
}

/** Exports the buffered telemetry. Call it before process.exit, which drops everything that is not exported. */
export async function shutdownInstrumentation(): Promise<void> {
  if (!sdk) {
    return;
  }
  const timeLimit = new Promise<void>((resolve) => {
    setTimeout(resolve, SHUTDOWN_TIME_LIMIT_MS).unref();
  });
  await Promise.race([sdk.shutdown(), timeLimit]).catch((err) => console.error('OpenTelemetry shutdown failed', err));
}
