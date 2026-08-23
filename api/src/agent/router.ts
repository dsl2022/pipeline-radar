import express, { type Request, type Response, type Router } from 'express';
import { checkSameSite, validateMessage } from './guards';
import { SESSION_COOKIE, newSessionId, signSession, verifySession } from './session';
import { openSse } from './sse';

// The request pipeline that runs before the model. There is no model yet:
// /chat streams a canned reply. Every gate that guards spend is real, and is
// here first on purpose - the failure mode being avoided is a working agent
// on screen with no controls in front of it.

export interface AgentConfig {
  sessionSecret: string;
  allowedOrigins: string[];
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

    // Gates 4-6 (budget, kill switch, per-turn bounds) land in PR 5 and PR 7.
    const stream = openSse(res);
    stream.event('open', { sessionId: sessionId.slice(0, 8) });
    stream.event('delta', {
      text: 'The request pipeline is live. No model is wired up yet - this reply is canned.',
    });
    stream.event('done', { reason: 'stub' });
    stream.close();
  });

  return router;
}
