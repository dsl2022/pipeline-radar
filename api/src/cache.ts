// In-memory TTL cache with a hard entry cap. One shared cache in front of the
// public APIs is the point of this proxy: openFDA allows 1,000 requests/day
// per IP, and every visitor hitting it directly would burn that budget — the
// proxy spends it once per unique query per TTL instead.

export interface CachedResponse {
  status: number;
  contentType: string;
  body: string;
}

interface Entry {
  value: CachedResponse;
  expiresAt: number;
}

export class TtlCache {
  private entries = new Map<string, Entry>();

  constructor(private maxEntries = 1000) {}

  get(key: string): CachedResponse | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: CachedResponse, ttlMs: number): void {
    // Map preserves insertion order — deleting the oldest key is a cheap
    // good-enough eviction for a cache this small.
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}
