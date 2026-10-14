// OpenTelemetry setup for the Node.js runtime, loaded from register() in
// instrumentation.ts. Registering global providers is what switches on the
// spans Next.js emits (routes, rendering, fetch) and the spans and metrics of
// @optimizely/cms-sdk (Graph requests, content fetches, component rendering),
// which are no-ops otherwise. Server-side console output is sent as logs too.
//
// Where it goes:
// - APPLICATIONINSIGHTS_CONNECTION_STRING set (Frontend Hosting provides it):
//   Azure Monitor / Application Insights. Server spans become Requests, client
//   spans (Graph fetches) Dependencies, console output Traces. We use the Azure
//   exporters rather than the useAzureMonitor() distro, which registers its own
//   MeterProvider and would bypass skipRenderMetrics() below.
// - Otherwise OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT; the exporters append
//   /v1/traces, /v1/metrics and /v1/logs themselves. Locally that's the Aspire
//   Dashboard (see .env.template).
//
// Telemetry must not read the clock during a cacheComponents prerender of the
// static shell: Next.js rejects Date.now() there, and in production that fails
// the prerender and every CMS page returns 500 (in dev it logs "encountered
// the unstable value `Date.now()`"). Next.js keeps span creation out of the
// prerender scope itself, but not metrics or logs, both of which read
// Date.now() when recorded:
// - The CMS SDK's component metrics (optimizely.component.*), recorded while
//   <OptimizelyComponent> renders, are switched off. The component spans
//   still carry the same timing.
// - Console output is emitted from the async context captured at startup,
//   which is outside any render. See forwardConsoleToLogs().

import { AsyncResource } from 'node:async_hooks';
import { format } from 'node:util';
import { context, metrics, createNoopMeter } from '@opentelemetry/api';
import type { Meter, MeterProvider } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { NodeSDK, resources } from '@opentelemetry/sdk-node';
import { MeterProvider as SdkMeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import {
  AzureMonitorLogExporter,
  AzureMonitorMetricExporter,
  AzureMonitorTraceExporter,
} from '@azure/monitor-opentelemetry-exporter';

const RENDER_METRIC_PREFIX = 'optimizely.component.';
// Matches the SDK's METER_NAME. Not imported: loading the SDK's telemetry
// module creates its instruments, which must wait until the provider is set.
const CMS_SDK_METER = '@optimizely/cms-sdk';

const CONSOLE_SEVERITY = {
  debug: SeverityNumber.DEBUG,
  log: SeverityNumber.INFO,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

// Passes everything through, except that the CMS SDK's meter returns no-op
// histograms and counters for the render-time metrics.
function skipRenderMetrics(provider: MeterProvider): MeterProvider {
  const noop = createNoopMeter();
  return {
    getMeter(name, version, options) {
      const meter = provider.getMeter(name, version, options);
      if (name !== CMS_SDK_METER) return meter;
      return new Proxy(meter, {
        get(target, prop, receiver) {
          if (prop === 'createHistogram' || prop === 'createCounter') {
            return (instrument: string, opts?: object) =>
              instrument.startsWith(RENDER_METRIC_PREFIX) ? noop[prop](instrument, opts) : target[prop](instrument, opts);
          }
          return Reflect.get(target, prop, receiver);
        },
      }) satisfies Meter;
    },
  };
}

// Keeps console output going to stdout as before and also emits it as a log
// record. Must be called outside any request: the emit runs in the async
// context captured here, where Next.js has no render in progress, so reading
// the clock is allowed. The active span is passed along explicitly so each log
// is still correlated with the request that wrote it.
function forwardConsoleToLogs() {
  const logger = logs.getLogger('console');
  const runOutsideRender = AsyncResource.bind((emit: () => void) => emit());
  let emitting = false; // an exporter that logs to the console must not loop

  for (const [method, severityNumber] of Object.entries(CONSOLE_SEVERITY)) {
    const name = method as keyof typeof CONSOLE_SEVERITY;
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args);
      if (emitting) return;
      const activeContext = context.active();
      emitting = true;
      try {
        runOutsideRender(() =>
          logger.emit({
            severityNumber,
            severityText: SeverityNumber[severityNumber],
            body: format(...args),
            context: activeContext,
          }),
        );
      } finally {
        emitting = false;
      }
    };
  }
}

function createExporters() {
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (connectionString) {
    return {
      traceExporter: new AzureMonitorTraceExporter({ connectionString }),
      metricExporter: new AzureMonitorMetricExporter({ connectionString }),
      // Built against an older @opentelemetry/sdk-logs whose exporter interface
      // has no forceFlush(); it sends each batch as it gets it, so a no-op fits.
      logExporter: Object.assign(new AzureMonitorLogExporter({ connectionString }), {
        forceFlush: () => Promise.resolve(),
      }),
      metricIntervalMillis: 60_000,
    };
  }
  return {
    traceExporter: new OTLPTraceExporter(),
    metricExporter: new OTLPMetricExporter(),
    logExporter: new OTLPLogExporter(),
    metricIntervalMillis: 10_000,
  };
}

export function startTelemetry() {
  // service.name is App Insights' cloud role name, service.instance.id its role
  // instance (which replica served the request).
  const resource = resources.defaultResource().merge(
    resources.resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'nextjs-fe-hosting',
      'service.instance.id': process.env.WEBSITE_INSTANCE_ID,
      'deployment.environment.name': process.env.OPTIMIZELY_ENVIRONMENT,
    }),
  );
  const { traceExporter, metricExporter, logExporter, metricIntervalMillis } = createExporters();

  const meterProvider = new SdkMeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: metricIntervalMillis })],
  });
  metrics.setGlobalMeterProvider(skipRenderMetrics(meterProvider));

  // Empty metricReaders, or NodeSDK adds its own default OTLP metric exporter
  // (to localhost:4318) on top of ours.
  new NodeSDK({
    resource,
    traceExporter,
    metricReaders: [],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: logExporter })],
  }).start();

  forwardConsoleToLogs();
}
