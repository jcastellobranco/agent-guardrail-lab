import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

/**
 * Registers a global tracer provider that exports spans over OTLP/HTTP (e.g. to Jaeger).
 * Spans are batched and exported off the request path, so a slow collector cannot
 * consume the decision latency budget; when its buffer is full, spans are dropped.
 */
export function startTracing(options: { endpoint: string; serviceName: string }) {
  const exporter = new OTLPTraceExporter({ url: new URL('/v1/traces', options.endpoint).href });
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': options.serviceName }),
    spanProcessors: [new BatchSpanProcessor({ exporter, maxQueueSize: 2048 })],
  });
  trace.setGlobalTracerProvider(provider);
  return { shutdown: () => provider.shutdown() };
}
