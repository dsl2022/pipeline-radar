import { context as otelContext, trace as otelTrace, SpanStatusCode, type Attributes, type Span, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, InMemorySpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

// The span tree (MILESTONE-6-PLAN.md 8): OTel GenAI conventions exported to
// Langfuse Cloud over OTLP. Written against the OTel API, not a vendor SDK,
// so the backend stays swappable - drop Langfuse and the instrumentation
// survives pointed at any OTLP endpoint.
//
// The split that matters: CloudWatch gets hashes and counts (metrics.ts and
// the turn log); the spans here carry the actual question and answer, because
// Langfuse is where access is deliberate and injection payloads are not
// sitting in a casually-read log aggregator.
//
// No keys, no tracer: the whole layer degrades to no-ops rather than holding
// a turn hostage to an observability backend.

export interface SpanHandle {
  setAttributes(attrs: Attributes): void;
  recordError(err: unknown): void;
  end(attrs?: Attributes): void;
}

export interface TurnTrace {
  setAttributes(attrs: Attributes): void;
  /** Start a child of the turn's root span. */
  span(name: string, attrs?: Attributes): SpanHandle;
  end(outcome: 'ok' | 'error', attrs?: Attributes): void;
}

export interface Telemetry {
  enabled: boolean;
  turn(attrs?: Attributes): TurnTrace;
  /** Flush pending spans; used on process shutdown and in tests. */
  flush(): Promise<void>;
}

const noopSpan: SpanHandle = { setAttributes() {}, recordError() {}, end() {} };
const noopTurn: TurnTrace = { setAttributes() {}, span: () => noopSpan, end() {} };

export const NOOP_TELEMETRY: Telemetry = {
  enabled: false,
  turn: () => noopTurn,
  flush: async () => {},
};

function wrap(span: Span): SpanHandle {
  return {
    setAttributes: (attrs) => span.setAttributes(attrs),
    recordError: (err) => {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
    },
    end: (attrs) => {
      if (attrs) span.setAttributes(attrs);
      span.end();
    },
  };
}

export interface TelemetryDeps {
  /** Test seam: replaces the OTLP exporter. */
  exporter?: SpanExporter;
  serviceName?: string;
}

export interface LangfuseEnv {
  publicKey?: string;
  secretKey?: string;
  host?: string;
}

/**
 * Langfuse ingests OTLP at /api/public/otel, authenticated with basic auth
 * over the project keys. Absent keys mean a disabled layer, said once at
 * startup - the service must never fail, or slow, because tracing cannot.
 */
export function createTelemetry(env: LangfuseEnv, deps: TelemetryDeps = {}): Telemetry {
  let exporter = deps.exporter;
  if (!exporter) {
    if (!env.publicKey || !env.secretKey) return NOOP_TELEMETRY;
    const host = (env.host ?? 'https://us.cloud.langfuse.com').replace(/\/$/, '');
    exporter = new OTLPTraceExporter({
      url: `${host}/api/public/otel/v1/traces`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.publicKey}:${env.secretKey}`).toString('base64')}`,
      },
    });
  }

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': deps.serviceName ?? 'pipeline-radar-agent' }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  const tracer: Tracer = provider.getTracer('pipeline-radar');

  return {
    enabled: true,
    turn(attrs) {
      const root = tracer.startSpan('chat-turn', { attributes: attrs });
      const rootCtx = otelTrace.setSpan(otelContext.active(), root);
      return {
        setAttributes: (a) => root.setAttributes(a),
        span: (name, a) => wrap(tracer.startSpan(name, { attributes: a }, rootCtx)),
        end: (outcome, a) => {
          if (a) root.setAttributes(a);
          root.setStatus({ code: outcome === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR });
          root.end();
        },
      };
    },
    flush: () => provider.forceFlush(),
  };
}

export { InMemorySpanExporter };
