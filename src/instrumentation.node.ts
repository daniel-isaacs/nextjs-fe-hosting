// OpenTelemetry setup for the Node.js runtime, loaded from register() in
// instrumentation.ts. Registering global providers is what switches on the
// spans Next.js emits (routes, rendering, fetch) and the spans and metrics of
// @optimizely/cms-sdk (Graph requests, content fetches), which are no-ops
// otherwise.
//
// Exports over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT; the exporters append
// /v1/traces and /v1/metrics themselves. Locally that's the Aspire Dashboard
// (see .env.template).
//
// Render-time telemetry is switched off. The CMS SDK records a span and two
// metrics each time <OptimizelyComponent> resolves a component, i.e. while
// React renders, outside any 'use cache' scope. Starting a recording span and
// recording a metric both read Date.now(), which cacheComponents rejects during
// prerendering ("encountered the unstable value `Date.now()`"): an error on
// every page in dev, and a failed prerender at build time. So the sampler drops
// those spans (a dropped span never reads the clock) and the SDK's meter hands
// out no-op instruments for them. Graph and content-fetch telemetry runs inside
// the cached getPageContent() and is kept.

import { metrics, createNoopMeter } from '@opentelemetry/api';
import type { Attributes, Context, Link, Meter, MeterProvider, SpanKind } from '@opentelemetry/api';
import { NodeSDK, resources, tracing } from '@opentelemetry/sdk-node';
import { MeterProvider as SdkMeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

const RENDER_SPANS = new Set(['optimizely.react.render_component', 'optimizely.component.resolve']);
const RENDER_METRIC_PREFIX = 'optimizely.component.';
// Matches the SDK's METER_NAME. Not imported: loading the SDK's telemetry
// module creates its instruments, which must wait until the provider is set.
const CMS_SDK_METER = '@optimizely/cms-sdk';

class SkipRenderSpansSampler implements tracing.Sampler {
  private readonly inner = new tracing.ParentBasedSampler({ root: new tracing.AlwaysOnSampler() });

  shouldSample(context: Context, traceId: string, name: string, kind: SpanKind, attributes: Attributes, links: Link[]) {
    if (RENDER_SPANS.has(name)) return { decision: tracing.SamplingDecision.NOT_RECORD };
    return this.inner.shouldSample(context, traceId, name, kind, attributes, links);
  }

  toString() {
    return 'SkipRenderSpansSampler';
  }
}

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
    sampler: new SkipRenderSpansSampler(),
    traceExporter: new OTLPTraceExporter(),
  }).start();
}
