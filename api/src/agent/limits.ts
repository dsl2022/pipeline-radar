import type { AgentStore } from './store';

// Rate limits and the kill switch. MILESTONE-6-PLAN.md 6.3.
//
// None of this is the guaranteed control - the Anthropic workspace spend cap
// is, because it does not depend on our code being correct. These are the
// best-effort layers under it, and the global ceiling in particular can
// overshoot: a turn's cost is only known once it finishes, so turns already
// in flight when the threshold is crossed still land against it.

export const KILL_SWITCH_KEY = 'flag#agent_enabled';

/** Read per request, so the switch is flippable mid-incident. */
export const FLAG_CACHE_MS = 10_000;

export interface Limits {
  sessionPerMinute: number;
  sessionPerHour: number;
  ipPerMinute: number;
  ipPerHour: number;
  globalPerDay: number;
}

export const DEFAULT_LIMITS: Limits = {
  sessionPerMinute: 5,
  sessionPerHour: 30,
  ipPerMinute: 20,
  ipPerHour: 200,
  // Turns, not dollars. Spend is only knowable once a turn completes, so the
  // dollar ceiling arrives with the model in PR 7; until then a turn count
  // bounds the same thing, because per-turn cost is itself bounded.
  globalPerDay: 200,
};

export type Decision =
  | { allowed: true }
  | { allowed: false; status: 429 | 503; scope: string; retryAfter?: number };

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Seconds until the counter that just denied this request resets.
 *
 * Windows are fixed UTC buckets, not sliding, so the wait is the remainder of
 * the current bucket - not its full width. A caller who exhausts the hourly
 * cap five minutes past the hour waits 55 minutes; telling them 600 seconds
 * would send them back into the same exhausted counter ten times over.
 */
export function retryAfterSeconds(nowMs: number, windowMs: number): number {
  return Math.max(1, Math.ceil((windowMs - (nowMs % windowMs)) / 1000));
}

/** UTC window keys. The window is in the key, so a stale counter cannot be mistaken for a live one. */
export function windowKeys(nowMs: number) {
  return {
    minute: Math.floor(nowMs / 60_000),
    hour: Math.floor(nowMs / 3_600_000),
    day: new Date(nowMs).toISOString().slice(0, 10),
  };
}

export interface LimiterDeps {
  store: AgentStore;
  now: () => number;
  limits?: Limits;
  /** Default when the flag row is absent. Enabled, so a missing row is not an outage. */
  defaultEnabled?: boolean;
}

export function createLimiter(deps: LimiterDeps) {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const defaultEnabled = deps.defaultEnabled ?? true;
  let cached: { value: boolean; at: number } | undefined;

  async function enabled(): Promise<boolean> {
    const t = deps.now();
    if (cached && t - cached.at < FLAG_CACHE_MS) return cached.value;
    try {
      const v = await deps.store.getFlag(KILL_SWITCH_KEY);
      cached = { value: v ?? defaultEnabled, at: t };
    } catch {
      // A store outage must not become an outage of the whole app, and must
      // not silently disable the switch either. Serve on the last known value
      // if we have one; otherwise fall back to the default.
      cached = { value: cached?.value ?? defaultEnabled, at: t };
    }
    return cached.value;
  }

  return {
    enabled,

    /**
     * Counts the turn and decides. Every counter is incremented even when an
     * earlier one already failed: over-counting on a denied request makes the
     * limits marginally stricter, which is the safe direction, and it avoids a
     * second round trip per check.
     */
    async check(sessionId: string, ip: string): Promise<Decision> {
      if (!(await enabled())) {
        return { allowed: false, status: 503, scope: 'kill-switch' };
      }

      const t = deps.now();
      const w = windowKeys(t);

      const [sMin, sHour, iMin, iHour, gDay] = await Promise.all([
        deps.store.bump(`session#${sessionId}#turns#${w.minute}`, 1, 120),
        deps.store.bump(`session#${sessionId}#turns#h${w.hour}`, 1, 7_200),
        deps.store.bump(`ip#${ip}#turns#${w.minute}`, 1, 120),
        deps.store.bump(`ip#${ip}#turns#h${w.hour}`, 1, 7_200),
        deps.store.bump(`global#turns#${w.day}`, 1, 172_800),
      ]);

      // Global first: it is the one that protects the budget rather than a
      // single caller, and 503 tells the client this is not about them.
      if (gDay > limits.globalPerDay) {
        // Honest even though it is a long wait: the budget resets at UTC
        // midnight and nothing the caller does brings that forward.
        return {
          allowed: false,
          status: 503,
          scope: 'global-daily',
          retryAfter: retryAfterSeconds(t, DAY_MS),
        };
      }
      if (sMin > limits.sessionPerMinute) {
        return {
          allowed: false,
          status: 429,
          scope: 'session-minute',
          retryAfter: retryAfterSeconds(t, MINUTE_MS),
        };
      }
      if (sHour > limits.sessionPerHour) {
        return {
          allowed: false,
          status: 429,
          scope: 'session-hour',
          retryAfter: retryAfterSeconds(t, HOUR_MS),
        };
      }
      if (iMin > limits.ipPerMinute) {
        return {
          allowed: false,
          status: 429,
          scope: 'ip-minute',
          retryAfter: retryAfterSeconds(t, MINUTE_MS),
        };
      }
      if (iHour > limits.ipPerHour) {
        return {
          allowed: false,
          status: 429,
          scope: 'ip-hour',
          retryAfter: retryAfterSeconds(t, HOUR_MS),
        };
      }
      return { allowed: true };
    },
  };
}

export type Limiter = ReturnType<typeof createLimiter>;
