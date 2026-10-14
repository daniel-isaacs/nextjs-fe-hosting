// OpenTelemetry setup for the Node.js runtime, loaded from register() in
// instrumentation.ts. Registering global providers is what switches on the
// spans Next.js emits (routes, rendering, fetch) and the spans and metrics of
// @optimizely/cms-sdk (Graph requests, content fetches, component rendering),
// which are no-ops otherwise.
//
// Exports over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT; the exporters append
// /v1/traces and /v1/metrics themselves. Locally that's the Aspire Dashboard
// (see .env.template).
//
// The CMS SDK's component metrics (optimizely.component.*) are switched off.
// They're recorded while <OptimizelyComponent> renders, and recording a metric
// reads Date.now(), which cacheComponents rejects while prerendering the static
// shell. In production that fails the prerender and every CMS page returns 500;
// in dev it logs "encountered the unstable value `Date.now()`". Spans are not
// affected: Next.js runs span creation outside the prerender scope, but it does
// no such thing for metrics. The component spans still carry the same timing.

import { metrics, createNoopMeter } from '@opentelemetry/api';
import type { Meter, MeterProvider } from '@opentelemetry/api';
import { NodeSDK, resources } from '@opentelemetry/sdk-node';
import { MeterProvider as SdkMeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

const RENDER_METRIC_PREFIX = 'optimizely.component.';
// Matches the SDK's METER_NAME. Not imported: loading the SDK's telemetry
// module creates its instruments, which must wait until the provider is set.
const CMS_SDK_METER = '@optimizely/cms-sdk';

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

export function startTelemetry() {
  const resource = resources
    .defaultResource()
    .merge(resources.resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME ?? 'nextjs-fe-hosting' }));

  const meterProvider = new SdkMeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 10_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(skipRenderMetrics(meterProvider));

  new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter(),
  }).start();
}
