import express from 'express';
import { TtlCache } from './cache';
import { createAgentRouter } from './agent/router';
import { createLimiter, type Limiter } from './agent/limits';
import { createDynamoStore, createMemoryStore } from './agent/store';

// Read-only proxy for the three public APIs the frontend uses. Why it exists
// (CICD-PLAN.md): kills CORS for good, pools openFDA's per-IP daily quota
// behind a shared TTL cache, and gives one place for timeouts.
//
// Mapping (prefix is stripped, the rest passes through verbatim):
//   /api/ctgov/*   -> https://clinicaltrials.gov/api/*
//   /api/openfda/* -> https://api.fda.gov/*
//   /api/rxnorm/*  -> https://rxnav.nlm.nih.gov/REST/*
//
// Cache rules: GET only; 200s are data, and 404s are cached too because for
// openFDA/RxNorm a miss IS the answer ("no approval record" / "not in
// RxNorm"). Errors and 5xx are never cached. TTLs: registry data 10 min,
// FDA/RxNorm reference data 24 h.

export interface Upstream {
  prefix: string;
  target: string;
  ttlMs: number;
}

export const UPSTREAMS: Upstream[] = [
  { prefix: '/api/ctgov', target: 'https://clinicaltrials.gov/api', ttlMs: 10 * 60_000 },
  { prefix: '/api/openfda', target: 'https://api.fda.gov', ttlMs: 24 * 60 * 60_000 },
  { prefix: '/api/rxnorm', target: 'https://rxnav.nlm.nih.gov/REST', ttlMs: 24 * 60 * 60_000 },
];

const UPSTREAM_TIMEOUT_MS = 15_000;
const CACHEABLE_STATUSES = new Set([200, 404]);

export interface AppOptions {
  /** Shared HMAC key for session cookies. Absent = agent routes are not mounted. */
  sessionSecret?: string;
  /** Origins allowed to POST to the agent. */
  allowedOrigins?: string[];
  /** Injected by tests; production builds one from AGENT_TABLE. */
  limiter?: Limiter;
}

export function createApp(
  upstreams: Upstream[] = UPSTREAMS,
  options: AppOptions = {},
): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Two proxies sit in front of this: CloudFront, then the ALB. Without this
  // req.ip is the ALB's address, so every request looks like one client and
  // any per-IP limit would throttle all users as a single bucket.
  app.set('trust proxy', 2);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Mounted only when a signing key is configured. Failing closed matters:
  // without a shared secret across tasks the cookie gate is meaningless, and
  // a meaningless gate in front of a spend endpoint is worse than no endpoint.
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET;
  if (sessionSecret) {
    app.use(
      '/api/agent',
      createAgentRouter({
        sessionSecret,
        allowedOrigins: options.allowedOrigins ?? allowedOriginsFromEnv(),
        limiter: options.limiter ?? defaultLimiter(),
      }),
    );
  } else {
    console.warn('SESSION_SECRET unset - agent routes not mounted');
  }

  for (const { prefix, target, ttlMs } of upstreams) {
    const cache = new TtlCache();

    app.use(prefix, async (req, res) => {
      if (req.method !== 'GET') {
        res.status(405).json({ error: 'proxy is read-only' });
        return;
      }
      // express strips the mount prefix; req.url keeps path + query verbatim.
      const url = target + req.url;

      const hit = cache.get(url);
      if (hit) {
        res.status(hit.status).type(hit.contentType).set('x-cache', 'hit').send(hit.body);
        return;
      }

      try {
        const upstream = await fetch(url, {
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          headers: { accept: 'application/json' },
        });
        const body = await upstream.text();
        const contentType = upstream.headers.get('content-type') ?? 'application/json';
        if (CACHEABLE_STATUSES.has(upstream.status)) {
          cache.set(url, { status: upstream.status, contentType, body }, ttlMs);
        }
        res.status(upstream.status).type(contentType).set('x-cache', 'miss').send(body);
      } catch {
        // Timeout or network failure — never cached, the client may retry.
        res.status(502).json({ error: 'upstream unreachable' });
      }
    });
  }

  return app;
}

function allowedOriginsFromEnv(): string[] {
  return (process.env.APP_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

// DynamoDB in production; in-process for local dev, where there is no table
// and no second task for the counters to be wrong across. The warning matters:
// an in-process limiter behind two tasks would silently double every limit.
function defaultLimiter(): Limiter {
  const table = process.env.AGENT_TABLE;
  if (!table) {
    console.warn('AGENT_TABLE unset - using in-process rate limits (local dev only)');
    return createLimiter({ store: createMemoryStore(), now: Date.now });
  }
  return createLimiter({
    store: createDynamoStore(table, process.env.DDB_ENDPOINT),
    now: Date.now,
  });
}
