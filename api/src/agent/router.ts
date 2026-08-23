import { createHash } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { checkSameSite, validateMessage } from './guards';
import { SESSION_COOKIE, newSessionId, signSession, verifySession } from './session';
import type { Limiter } from './limits';
import { openSse } from './sse';
import { describeStop, type AgentRunner } from './runner';

// The request pipeline in front of the model, and the model call itself.
// Every gate that guards spend runs before a single token is bought.

export interface AgentConfig {
  sessionSecret: string;
  allowedOrigins: string[];
  limiter: Limiter;
  /** Absent when no API key is configured; /chat then refuses rather than pretending. */
  runner?: AgentRunner;
}

/**
 * What a turn is allowed to leave in CloudWatch.
 *
 * Never the question itself. The prompt is a user's own words and it goes to
 * Langfuse, where access is deliberate; CloudWatch is read casually by anyone
 * debugging a deploy. A hash still tells us "the same question failed twice",
 * which is the only thing the log needed it for.
 */
function fingerprint(message: string) {
  return {
    hash: createHash('sha256').update(message).digest('hex').slice(0, 16),
    chars: message.length,
  };
}

/** Minimal cookie parse - avoids a dependency for one header. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

function deny(res: Response, status: number, message: string, gate: string) {
  // The caller gets a category; the gate that fired is ours to know. Telling
  // a prober which check rejected them is free reconnaissance.
  console.log(JSON.stringify({ evt: 'agent.deny', gate, status }));
  res.status(status).json({ error: message });
}

export function createAgentRouter(config: AgentConfig): Router {
  const router = express.Router();

  // A small body cap in front of the character cap: without it Express would
  // buffer a multi-megabyte payload before any gate could reject it.
  router.use(express.json({ limit: '64kb' }));

  // Issued on app load. Not authentication - a stable rate-limiting key that
  // a casual script will not carry, and the thing per-session counters hang
  // off once PR 5 lands.
  router.get('/session', (req: Request, res: Response) => {
    const existing = verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), config.sessionSecret);
    const id = existing ?? newSessionId();

    if (!existing) {
      res.cookie(SESSION_COOKIE, signSession(id, config.sessionSecret), {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
        path: '/api/agent',
        maxAge: 24 * 60 * 60 * 1000,
      });
    }
    res.json({ ok: true, issued: !existing });
  });

  router.post('/chat', (req: Request, res: Response) => {
    // Gate 1 - identity. Rejected outright rather than falling back to
    // IP-only limiting: a fallback path is just a documented bypass.
    const sessionId = verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), config.sessionSecret);
    if (!sessionId) {
      return deny(res, 403, 'session required', 'session');
    }

    // Gate 2 - cross-site.
    const sameSite = checkSameSite(
      { origin: req.headers.origin, referer: req.headers.referer },
      config.allowedOrigins,
    );
    if (!sameSite.ok) {
      return deny(res, 403, 'forbidden', 'same-site');
    }

    // Gate 3 - input shape.
    const message = (req.body as { message?: unknown } | undefined)?.message;
    const valid = validateMessage(message);
    if (!valid.ok) {
      return deny(res, 400, valid.reason, 'input');
    }

    // Gate 4 - is there a model at all. Before the limiter on purpose: a
    // service running without a key is broken, and it should not also spend
    // every caller's allowance telling them so.
    if (!config.runner) {
      return deny(res, 503, 'assistant unavailable', 'not-configured');
    }
    const runner = config.runner;

    // Gate 5 - kill switch and rate limits. Last, and deliberately: the
    // cheaper checks above reject junk without spending a DynamoDB write, and
    // a request that fails them should not consume the caller's allowance.
    void (async () => {
      let decision;
      try {
        decision = await config.limiter.check(sessionId, req.ip ?? 'unknown');
      } catch (err) {
        // The limiter is what stands between an anonymous endpoint and the
        // bill. If it cannot answer, refuse rather than serve unmetered.
        console.error(JSON.stringify({ evt: 'agent.limiter_error', err: String(err) }));
        return deny(res, 503, 'temporarily unavailable', 'limiter-error');
      }

      if (!decision.allowed) {
        if (decision.retryAfter) res.setHeader('retry-after', String(decision.retryAfter));
        return deny(
          res,
          decision.status,
          decision.status === 503 ? 'assistant unavailable' : 'too many requests',
          decision.scope,
        );
      }

      // Past this point the response has begun, so failures can no longer be
      // an HTTP status - they are an SSE error event on an open 200 stream.
      const stream = openSse(res);
      stream.event('open', { sessionId: sessionId.slice(0, 8) });

      const startedAt = Date.now();
      const fp = fingerprint(valid.value);
      // The client going away aborts the turn: an abandoned tab must stop
      // costing money the moment nobody is reading the answer.
      const gone = new AbortController();
      res.on('close', () => gone.abort());

      try {
        const outcome = await runner.run(
          valid.value,
          (event, data) => stream.event(event, data),
          gone.signal,
        );

        const note = describeStop(outcome.stopReason, outcome.timedOut);
        if (note) stream.event('notice', { text: note });
        stream.event('done', { stop: outcome.stopReason, truncated: note !== null });

        console.log(
          JSON.stringify({
            evt: 'agent.turn',
            session: sessionId.slice(0, 8),
            ...fp,
            stop: outcome.stopReason,
            timed_out: outcome.timedOut,
            iterations: outcome.iterations,
            tools: outcome.toolCalls,
            usage: outcome.usage,
            ms: Date.now() - startedAt,
          }),
        );
      } catch (err) {
        console.error(
          JSON.stringify({
            evt: 'agent.turn_error',
            session: sessionId.slice(0, 8),
            ...fp,
            err: String(err),
            ms: Date.now() - startedAt,
          }),
        );
        stream.event('error', { message: 'the assistant could not finish this turn' });
      } finally {
        stream.close();
      }
    })();
  });

  return router;
}
