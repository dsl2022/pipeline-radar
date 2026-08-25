import type { RunOutcome } from './runner';

// CloudWatch metrics via EMF (MILESTONE-6-PLAN.md 8): a JSON envelope on
// stdout that the CloudWatch agent side of awslogs turns into real metrics.
// Hand-rolled deliberately - the format is a page of spec, and a metrics
// client dependency for one JSON.stringify would be surface without value.
//
// Everything here is numbers and enums. The privacy rule is structural: this
// module's inputs carry no user text, so nothing it prints can leak any.

export const METRICS_NAMESPACE = 'PipelineRadar/Agent';

/**
 * Cost estimate per turn, in USD. Approximate by design - the source of
 * truth is the Anthropic Console - but stable enough for the budget alarms.
 * Derived from MILESTONE-6-PLAN.md 6.3's measured turn economics (a typical
 * ~10k-in / 2.8k-out / 7.5k-cached turn costing ~$0.13); revisit when model
 * pricing changes.
 */
export const USD_PER_MTOK = { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 };

export function estimateCostUsd(usage: RunOutcome['usage']): number {
  const usd =
    (usage.input * USD_PER_MTOK.input +
      usage.output * USD_PER_MTOK.output +
      usage.cacheRead * USD_PER_MTOK.cacheRead +
      usage.cacheCreation * USD_PER_MTOK.cacheCreation) /
    1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

type MetricUnit = 'Count' | 'Milliseconds' | 'None';

export interface MetricsDeps {
  /** Test seam; production prints to stdout for awslogs. */
  write?: (line: string) => void;
  now?: () => number;
}

function emf(
  write: (line: string) => void,
  now: () => number,
  dimensions: Record<string, string>,
  metrics: { name: string; unit: MetricUnit; value: number }[],
) {
  write(
    JSON.stringify({
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [
          {
            Namespace: METRICS_NAMESPACE,
            Dimensions: [Object.keys(dimensions)],
            Metrics: metrics.map((m) => ({ Name: m.name, Unit: m.unit })),
          },
        ],
      },
      ...dimensions,
      ...Object.fromEntries(metrics.map((m) => [m.name, m.value])),
    }),
  );
}

export interface AgentMetrics {
  turn(outcome: 'ok' | 'error', run: RunOutcome, ttftMs: number | null): void;
  blocked(scope: string): void;
}

export function createMetrics(deps: MetricsDeps = {}): AgentMetrics {
  const write = deps.write ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;

  return {
    turn(outcome, run, ttftMs) {
      emf(write, now, { Outcome: outcome }, [
        { name: 'turns', unit: 'Count', value: 1 },
        { name: 'cost_usd', unit: 'None', value: estimateCostUsd(run.usage) },
        { name: 'iterations', unit: 'Count', value: run.iterations },
        { name: 'tool_calls', unit: 'Count', value: run.toolCalls.length },
        { name: 'citations_cited', unit: 'Count', value: run.citations.cited },
        // The eval signal: any sustained non-zero here is a grounding failure.
        { name: 'citations_unverified', unit: 'Count', value: run.citations.unverified },
        { name: 'cache_read_tokens', unit: 'Count', value: run.usage.cacheRead },
        // Cache health: creation with no reads across turns means the frozen
        // prefix is silently varying and every turn pays full input price.
        { name: 'cache_creation_tokens', unit: 'Count', value: run.usage.cacheCreation },
        ...(ttftMs !== null ? [{ name: 'ttft_ms', unit: 'Milliseconds' as const, value: ttftMs }] : []),
      ]);
    },
    blocked(scope) {
      emf(write, now, { Scope: scope }, [{ name: 'ratelimit_blocked', unit: 'Count', value: 1 }]);
    },
  };
}

export const NOOP_METRICS: AgentMetrics = { turn() {}, blocked() {} };
