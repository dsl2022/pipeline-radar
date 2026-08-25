import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import { setApiBase } from '@pipeline-radar/shared/net';
import { TtlCache } from './cache';
import { createAgentRouter } from './agent/router';
import { createLimiter, type Limiter } from './agent/limits';
import { createDynamoStore, createMemoryStore } from './agent/store';
import { createTrialData } from './agent/data';
import { createPubmed } from './agent/pubmed';
import { createTools } from './agent/tools';
import { createAgentRunner, type AgentRunner } from './agent/runner';

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

/** One definition: server.ts binds it, and the agent's tools dial it back. */
export const DEFAULT_PORT = 3001;

export function servicePort(): number {
  return Number(process.env.PORT ?? DEFAULT_PORT);
}

export interface Upstream {
  prefix: string;
  target: string;
  ttlMs: number;
}

export const UPSTREAMS: Upstream[] = [
  { prefix: '/api/ctgov', target: 'https://clinicaltrials.gov/api', ttlMs: 10 * 60_000 },
  { prefix: '/api/openfda', target: 'https://api.fda.gov', ttlMs: 24 * 60 * 60_000 },
  { prefix: '/api/rxnorm', target: 'https://rxnav.nlm.nih.gov/REST', ttlMs: 24 * 60 * 60_000 },
  // PubMed article counts for the agent's pubmed_count tool (M6). Counts move
  // slowly; a day-long cache keeps the 3 req/s eutils courtesy limit distant.
  { prefix: '/api/pubmed', target: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils', ttlMs: 24 * 60 * 60_000 },
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
  /** Injected by tests; production builds one from ANTHROPIC_API_KEY. */
  runner?: AgentRunner;
  /** Where the agent's tools send upstream requests. Defaults to this app's own proxy. */
  selfBaseUrl?: string;
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
        runner: options.runner ?? defaultRunner(sessionSecret, options.selfBaseUrl),
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

/**
 * The agent, or nothing.
 *
 * No key means no runner, and /chat answers 503. It deliberately does not fall
 * back to a canned reply: a stubbed answer on a production endpoint looks
 * exactly like a working assistant to everyone except the person who needs to
 * know the key is missing.
 */
function defaultRunner(sessionSecret: string, selfBaseUrl?: string): AgentRunner | undefined {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY unset - agent chat will answer 503');
    return undefined;
  }

  // The shared data modules were written against a browser's relative /api.
  // Point them at this service's own proxy: it holds the TTL cache that pools
  // openFDA's per-IP daily quota, which both tasks share behind one NAT.
  setApiBase(selfBaseUrl ?? `http://127.0.0.1:${servicePort()}/api`);

  const client = new Anthropic();
  // The session secret doubles as the brief-token key: same trust domain (one
  // service, one secret store), and the tokens are 10-minute, single-purpose.
  return createAgentRunner({
    client,
    tools: createTools(createTrialData(), { pubmed: createPubmed(), briefSecret: sessionSecret }),
  });
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
