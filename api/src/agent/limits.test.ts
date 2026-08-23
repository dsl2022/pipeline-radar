import { DEFAULT_LIMITS, KILL_SWITCH_KEY, createLimiter, windowKeys } from './limits';
import { createMemoryStore, type AgentStore } from './store';

// Time is injected everywhere: no sleeps, no jest fake timers, no flakiness.
function at(ms: number) {
  let t = ms;
  return { now: () => t, advance: (by: number) => (t += by) };
}

function limiterAt(clock: { now: () => number }, over: Partial<typeof DEFAULT_LIMITS> = {}) {
  const store = createMemoryStore(clock.now);
  return {
    store,
    limiter: createLimiter({ store, now: clock.now, limits: { ...DEFAULT_LIMITS, ...over } }),
  };
}

const T0 = Date.UTC(2026, 7, 23, 12, 0, 0);

describe('windowKeys', () => {
  it('buckets by UTC minute, hour and day', () => {
    const w = windowKeys(T0);
    expect(w).toEqual({
      minute: Math.floor(T0 / 60_000),
      hour: Math.floor(T0 / 3_600_000),
      day: '2026-08-23',
    });
  });

  it('rolls the minute bucket exactly at the boundary', () => {
    expect(windowKeys(T0 + 59_999).minute).toBe(windowKeys(T0).minute);
    expect(windowKeys(T0 + 60_000).minute).toBe(windowKeys(T0).minute + 1);
  });
});

describe('rate limits', () => {
  it('allows up to the per-minute cap', async () => {
    const c = at(T0);
    const { limiter } = limiterAt(c, { sessionPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      expect(await limiter.check('s1', '1.1.1.1')).toEqual({ allowed: true });
    }
  });

  it('denies the request past the cap, with Retry-After', async () => {
    const c = at(T0);
    const { limiter } = limiterAt(c, { sessionPerMinute: 3 });
    for (let i = 0; i < 3; i++) await limiter.check('s1', '1.1.1.1');

    const res = await limiter.check('s1', '1.1.1.1');
    expect(res).toEqual({ allowed: false, status: 429, scope: 'session-minute', retryAfter: 60 });
  });

  it('lets the caller back in once the window rolls', async () => {
    const c = at(T0);
    const { limiter } = limiterAt(c, { sessionPerMinute: 2 });
    await limiter.check('s1', '1.1.1.1');
    await limiter.check('s1', '1.1.1.1');
    expect((await limiter.check('s1', '1.1.1.1')).allowed).toBe(false);

    c.advance(60_000);
    expect(await limiter.check('s1', '1.1.1.1')).toEqual({ allowed: true });
  });

  it('counts sessions independently', async () => {
    const c = at(T0);
    const { limiter } = limiterAt(c, { sessionPerMinute: 1 });
    expect((await limiter.check('s1', '1.1.1.1')).allowed).toBe(true);
    expect((await limiter.check('s1', '1.1.1.1')).allowed).toBe(false);
    // A different session on the same IP is unaffected until the IP cap bites.
    expect((await limiter.check('s2', '1.1.1.1')).allowed).toBe(true);
  });

  it('catches one caller rotating sessions, via the IP cap', async () => {
    const c = at(T0);
    const { limiter } = limiterAt(c, { sessionPerMinute: 100, ipPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await limiter.check(`s${i}`, '9.9.9.9')).allowed).toBe(true);
    }
    const res = await limiter.check('s-fresh', '9.9.9.9');
    expect(res).toMatchObject({ allowed: false, status: 429, scope: 'ip-minute' });
  });

  it('applies the hourly cap even when each minute stays under', async () => {
    const c = at(T0);
    const { limiter } = limiterAt(c, { sessionPerMinute: 10, sessionPerHour: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await limiter.check('s1', '1.1.1.1')).allowed).toBe(true);
      c.advance(60_000);
    }
    expect(await limiter.check('s1', '1.1.1.1')).toMatchObject({ scope: 'session-hour' });
  });

  // 503, not 429: this is not about the caller.
  it('returns 503 when the global daily ceiling is crossed', async () => {
    const c = at(T0);
    const { limiter } = limiterAt(c, { globalPerDay: 2 });
    await limiter.check('a', '1.1.1.1');
    await limiter.check('b', '2.2.2.2');
    expect(await limiter.check('c', '3.3.3.3')).toEqual({
      allowed: false,
      status: 503,
      scope: 'global-daily',
    });
  });

  it('reports the global ceiling ahead of a per-caller limit', async () => {
    const c = at(T0);
    const { limiter } = limiterAt(c, { globalPerDay: 1, sessionPerMinute: 1 });
    await limiter.check('a', '1.1.1.1');
    // Both are exceeded; the global one is the useful thing to say.
    const res = await limiter.check('a', '1.1.1.1');
    expect(res.allowed).toBe(false);
    // Narrow before reading scope - it only exists on the denied branch.
    if (!res.allowed) expect(res.scope).toBe('global-daily');
  });
});

describe('kill switch', () => {
  const flagStore = (value: boolean | null, onGet?: () => void): AgentStore => ({
    bump: async () => 1,
    getFlag: async () => {
      onGet?.();
      return value;
    },
  });

  it('serves when the flag row is absent', async () => {
    const limiter = createLimiter({ store: flagStore(null), now: () => T0 });
    expect(await limiter.enabled()).toBe(true);
  });

  it('refuses with 503 when disabled', async () => {
    const limiter = createLimiter({ store: flagStore(false), now: () => T0 });
    expect(await limiter.check('s1', '1.1.1.1')).toEqual({
      allowed: false,
      status: 503,
      scope: 'kill-switch',
    });
  });

  it('does not spend a read per request', async () => {
    let reads = 0;
    const c = at(T0);
    const limiter = createLimiter({ store: flagStore(true, () => reads++), now: c.now });
    await limiter.enabled();
    await limiter.enabled();
    expect(reads).toBe(1);
  });

  it('picks up a flip within the cache window', async () => {
    let reads = 0;
    const c = at(T0);
    const limiter = createLimiter({ store: flagStore(true, () => reads++), now: c.now });
    await limiter.enabled();
    c.advance(10_001);
    await limiter.enabled();
    expect(reads).toBe(2);
  });

  // A store outage must not disable the agent, nor silently disable the switch.
  it('serves the last known value when the store errors', async () => {
    let fail = false;
    const c = at(T0);
    const limiter = createLimiter({
      store: {
        bump: async () => 1,
        getFlag: async () => {
          if (fail) throw new Error('ddb down');
          return false;
        },
      },
      now: c.now,
    });
    expect(await limiter.enabled()).toBe(false);
    fail = true;
    c.advance(10_001);
    expect(await limiter.enabled()).toBe(false);
  });
});
