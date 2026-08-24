// Coalescing for read-through caches.
//
// Every cache in this codebase is written AFTER its fetch resolves, which
// means it only helps callers that arrive once a request has already
// finished. That is not how any of the callers actually behave:
//
//   - the agent's tool runner executes every tool_use block in one assistant
//     message concurrently (Promise.all)
//   - enrichTopRows runs four workers in parallel, and two drug rows can
//     resolve to the same alias
//   - App.tsx issues two badgeDrugs passes that can overlap
//
// In all three the concurrent callers miss an empty cache in the same tick and
// each opens its own request. The cache looks like it is working, because a
// sequential repeat is served from memory - and a sequential repeat is the one
// access pattern that never happens.
//
// Joining the in-flight promise collapses them into one request. A rejection
// is never remembered: the entry is dropped when the promise settles either
// way, so a failure stays uncached and the next caller retries.

export interface InFlight<V> {
  join(key: string, start: () => Promise<V>): Promise<V>;
  /** Test/dev hook, paired with the caches' own clear functions. */
  clear(): void;
  readonly size: number;
}

export function createInFlight<V>(): InFlight<V> {
  const pending = new Map<string, Promise<V>>();

  return {
    join(key, start) {
      const existing = pending.get(key);
      if (existing) return existing;

      // The stored promise is exactly the one every caller receives, so a
      // rejection is delivered to all of them and none of them sees an
      // unhandled one.
      const request = (async () => {
        try {
          return await start();
        } finally {
          // start() has already written its own cache by now, so a caller
          // arriving after this hits the cache rather than re-requesting.
          pending.delete(key);
        }
      })();

      pending.set(key, request);
      return request;
    },
    clear() {
      pending.clear();
    },
    get size() {
      return pending.size;
    },
  };
}
