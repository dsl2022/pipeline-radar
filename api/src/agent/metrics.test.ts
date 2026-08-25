import { METRICS_NAMESPACE, createMetrics, estimateCostUsd } from './metrics';
import type { RunOutcome } from './runner';

const outcome = (over: Partial<RunOutcome['usage']> = {}): RunOutcome => ({
  stopReason: 'end_turn',
  iterations: 2,
  toolCalls: ['search_trials'],
  timedOut: false,
  citations: { cited: 3, unverified: 1 },
  usage: { input: 10_000, output: 2_800, cacheRead: 7_500, cacheCreation: 0, ...over },
});

describe('estimateCostUsd', () => {
  // Anchored to the plan's measured economics: the typical turn lands near
  // $0.13. If pricing constants drift from that reality, this fails first.
  it('prices the plan\'s typical turn in the expected range', () => {
    const usd = estimateCostUsd(outcome().usage);
    expect(usd).toBeGreaterThan(0.08);
    expect(usd).toBeLessThan(0.2);
  });

  it('prices an empty turn at zero', () => {
    expect(estimateCostUsd({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })).toBe(0);
  });
});

describe('createMetrics', () => {
  const harness = () => {
    const lines: string[] = [];
    const metrics = createMetrics({ write: (l) => lines.push(l), now: () => 1_756_000_000_000 });
    return { lines, metrics, last: () => JSON.parse(lines[lines.length - 1]) };
  };

  it('emits a valid EMF envelope for a turn', () => {
    const { metrics, last } = harness();
    metrics.turn('ok', outcome(), 1234);
    const doc = last();
    const emf = doc._aws.CloudWatchMetrics[0];
    expect(emf.Namespace).toBe(METRICS_NAMESPACE);
    expect(emf.Dimensions).toEqual([['Outcome']]);
    expect(doc.Outcome).toBe('ok');
    expect(doc.turns).toBe(1);
    expect(doc.iterations).toBe(2);
    expect(doc.citations_unverified).toBe(1);
    expect(doc.ttft_ms).toBe(1234);
    expect(doc.cost_usd).toBeGreaterThan(0);
  });

  it('omits ttft when no token ever arrived', () => {
    const { metrics, last } = harness();
    metrics.turn('error', outcome(), null);
    expect(last().ttft_ms).toBeUndefined();
    expect(last().Outcome).toBe('error');
  });

  it('emits rate-limit blocks under their scope', () => {
    const { metrics, last } = harness();
    metrics.blocked('session-minute');
    expect(last().Scope).toBe('session-minute');
    expect(last().ratelimit_blocked).toBe(1);
  });

  // The privacy property is structural, but assert it anyway: nothing this
  // module prints may carry text fields at all.
  it('prints numbers and enum dimensions only', () => {
    const { metrics, lines } = harness();
    metrics.turn('ok', outcome(), 50);
    metrics.blocked('global-daily');
    for (const line of lines) {
      const doc = JSON.parse(line) as Record<string, unknown>;
      for (const [key, value] of Object.entries(doc)) {
        if (key === '_aws') continue;
        expect(['number', 'string']).toContain(typeof value);
        if (typeof value === 'string') expect(value.length).toBeLessThan(32);
      }
    }
  });
});
