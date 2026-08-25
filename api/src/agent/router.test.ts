import request from 'supertest';
import { createApp } from '../app';
import { createLimiter, DEFAULT_LIMITS } from './limits';
import { createMemoryStore, type AgentStore } from './store';
import { SESSION_COOKIE, newSessionId, signSession } from './session';
import { BRIEF_TOKEN_TTL_MS, signBriefToken } from './brief';
import type { AgentRunner, RunOutcome } from './runner';

const SECRET = 'test-secret-do-not-use';
const ORIGIN = 'https://app.example.com';

// No upstreams: these tests must never reach the network.
// Pinned to a minute boundary. With the real clock, Retry-After is whatever
// is left of the current minute, so asserting on it would be flaky by the
// second.
const T0 = Date.UTC(2026, 7, 23, 12, 0, 0);

// A runner that spends nothing. The model itself is covered in runner.test.ts;
// what these tests are about is the pipeline around it.
const stubRunner = (over: Partial<RunOutcome> = {}): AgentRunner => ({
  run: async (_message, emit) => {
    emit('delta', { text: 'an answer' });
    return {
      stopReason: 'end_turn',
      iterations: 1,
      toolCalls: [],
      timedOut: false,
      citations: { cited: 0, unverified: 0 },
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      ...over,
    };
  },
});

// `null` means "deliberately no runner" - passing undefined would fall back to
// the default parameter and quietly test the stub instead.
const app = (
  over: Partial<typeof DEFAULT_LIMITS> = {},
  store?: AgentStore,
  runner: AgentRunner | null = stubRunner(),
) => {
  const now = () => T0;
  return createApp([], {
    sessionSecret: SECRET,
    allowedOrigins: [ORIGIN],
    runner: runner ?? undefined,
    limiter: createLimiter({
      store: store ?? createMemoryStore(now),
      now,
      limits: { ...DEFAULT_LIMITS, ...over },
    }),
  });
};

function validCookie(): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(signSession(newSessionId(), SECRET))}`;
}

describe('GET /api/agent/session', () => {
  it('issues an httpOnly, SameSite=Lax cookie scoped to the agent path', async () => {
    const res = await request(app()).get('/api/agent/session');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, issued: true });

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/api\/agent/i);
  });

  it('does not re-issue when a valid cookie is presented', async () => {
    const res = await request(app()).get('/api/agent/session').set('Cookie', validCookie());
    expect(res.body).toEqual({ ok: true, issued: false });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('re-issues when the cookie is forged', async () => {
    const forged = `${SESSION_COOKIE}=${newSessionId()}.deadbeef`;
    const res = await request(app()).get('/api/agent/session').set('Cookie', forged);
    expect(res.body).toEqual({ ok: true, issued: true });
  });
});

describe('POST /api/agent/chat', () => {
  it('streams when every gate passes', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({ message: 'which phase 3 trials are recruiting?' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: open');
    expect(res.text).toContain('event: delta');
    expect(res.text).toContain('event: done');
  });

  // --- the negative cases: each gate must actually block ---

  it('rejects a request with no cookie', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Origin', ORIGIN)
      .send({ message: 'hello' });
    expect(res.status).toBe(403);
  });

  it('rejects a forged cookie', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', `${SESSION_COOKIE}=${newSessionId()}.deadbeef`)
      .set('Origin', ORIGIN)
      .send({ message: 'hello' });
    expect(res.status).toBe(403);
  });

  it('rejects a cookie signed with another secret', async () => {
    const other = `${SESSION_COOKIE}=${encodeURIComponent(signSession(newSessionId(), 'other'))}`;
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', other)
      .set('Origin', ORIGIN)
      .send({ message: 'hello' });
    expect(res.status).toBe(403);
  });

  // There is deliberately no IP-only fallback: a fallback is a documented bypass.
  it('does not fall back to IP-only limiting when the cookie is missing', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('X-Forwarded-For', '203.0.113.9')
      .set('Origin', ORIGIN)
      .send({ message: 'hello' });
    expect(res.status).toBe(403);
  });

  it('rejects a cross-site Origin', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', 'https://evil.example.com')
      .send({ message: 'hello' });
    expect(res.status).toBe(403);
  });

  it('rejects an over-long message', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({ message: 'a'.repeat(4001) });
    expect(res.status).toBe(400);
  });

  it('rejects a message with control characters', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({ message: 'hello\u0000world' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing message field', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({});
    expect(res.status).toBe(400);
  });

  it('accepts a question carrying a well-formed history', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({
        message: 'and in children?',
        history: [
          { role: 'user', text: 'trials for lung cancer?' },
          { role: 'assistant', text: 'there are 2,460.' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('event: done');
  });

  // History is client-supplied text like the message: same gates, same 400.
  it.each([
    ['a non-array', 'not a list'],
    ['an assistant-led shape', [{ role: 'assistant', text: 'hi' }, { role: 'user', text: 'q' }]],
    ['a lone user turn', [{ role: 'user', text: 'q' }]],
    ['control characters', [{ role: 'user', text: 'q\u0000' }, { role: 'assistant', text: 'a' }]],
  ])('rejects a history with %s', async (_name, history) => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({ message: 'hello', history });
    expect(res.status).toBe(400);
  });

  it('accepts a request carrying app context and rejects a malformed one', async () => {
    const ok = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({ message: 'what changed?', context: { disease: 'melanoma', view: 'drugs' } });
    expect(ok.status).toBe(200);

    const bad = await request(app())
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({ message: 'hello', context: { view: 'dashboard' } });
    expect(bad.status).toBe(400);
  });

  it('does not disclose which gate rejected the request', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Origin', ORIGIN)
      .send({ message: 'hello' });
    expect(res.body.error).toBe('session required');
    expect(JSON.stringify(res.body)).not.toContain('gate');
  });
});

describe('the model layer', () => {
  const chat = (a: ReturnType<typeof app>, message = 'which phase 3 trials are recruiting?') =>
    request(a).post('/api/agent/chat').set('Cookie', validCookie()).set('Origin', ORIGIN).send({ message });

  it('streams the model output through to the client', async () => {
    const res = await chat(app());
    expect(res.text).toContain('event: delta');
    expect(res.text).toContain('an answer');
    expect(res.text).toContain('event: done');
  });

  // A stub reply on a production endpoint looks exactly like a working
  // assistant to everyone except the person who needs to know the key is gone.
  it('refuses rather than serving a canned answer when no model is configured', async () => {
    const res = await chat(app({}, undefined, null));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'assistant unavailable' });
  });

  // A service with no key is broken; it should not also exhaust the caller's
  // allowance while telling them so.
  it('does not spend the rate-limit allowance when there is no model', async () => {
    const a = app({ sessionPerMinute: 2 }, undefined, null);
    const cookie = validCookie();
    const post = () =>
      request(a).post('/api/agent/chat').set('Cookie', cookie).set('Origin', ORIGIN).send({ message: 'hi' });

    for (let i = 0; i < 5; i += 1) expect((await post()).status).toBe(503);
    // Still 503 rather than 429: none of those five was counted.
    expect((await post()).status).toBe(503);
  });

  it('tells the client when an answer was cut short instead of passing it off as complete', async () => {
    const res = await chat(app({}, undefined, stubRunner({ stopReason: 'max_tokens' })));
    expect(res.text).toContain('event: notice');
    expect(res.text).toMatch(/length limit/);
    expect(res.text).toContain('"truncated":true');
  });

  it('marks a clean finish as not truncated', async () => {
    const res = await chat(app());
    expect(res.text).toContain('"truncated":false');
    expect(res.text).not.toContain('event: notice');
  });

  // The response has already begun, so a failure cannot be an HTTP status.
  it('reports a mid-stream failure as an error event on the open stream', async () => {
    const failing: AgentRunner = {
      run: async () => {
        throw new Error('anthropic overloaded');
      },
    };
    const res = await chat(app({}, undefined, failing));
    expect(res.status).toBe(200);
    expect(res.text).toContain('event: error');
    // Never the upstream's words: they are ours to log, not to publish.
    expect(res.text).not.toContain('anthropic overloaded');
  });

  it('never writes the user\'s question to the log', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const secret = 'my employer is acquiring a company called Northwind';
    await chat(app(), secret);

    const written = log.mock.calls.flat().join(' ');
    log.mockRestore();
    expect(written).toContain('agent.turn');
    expect(written).not.toContain('Northwind');
    expect(written).not.toContain(secret);
    // The hash still answers "did this same question fail twice?".
    expect(written).toMatch(/"hash":"[0-9a-f]{16}"/);
    expect(written).toContain(`"chars":${secret.length}`);
  });

  // History is the user's words too: the log gets a count, never the text.
  it('never writes the history to the log', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await request(app())
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({
        message: 'and their sponsors?',
        history: [
          { role: 'user', text: 'a question about Northwind' },
          { role: 'assistant', text: 'an answer about Northwind' },
        ],
      });

    const written = log.mock.calls.flat().join(' ');
    log.mockRestore();
    expect(written).toContain('"history":2');
    expect(written).not.toContain('Northwind');
  });

  it('does not log the question when the turn fails either', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failing: AgentRunner = {
      run: async () => {
        throw new Error('boom');
      },
    };
    const secret = 'confidential pipeline question about Northwind';
    await chat(app({}, undefined, failing), secret);

    const written = err.mock.calls.flat().join(' ');
    err.mockRestore();
    expect(written).toContain('agent.turn_error');
    expect(written).not.toContain('Northwind');
  });
});

describe('agent routes are not mounted without a signing key', () => {
  // Failing closed matters: without a shared secret across tasks the cookie
  // gate is meaningless, and a meaningless gate in front of a spend endpoint
  // is worse than no endpoint.
  it('404s when SESSION_SECRET is absent', async () => {
    const bare = createApp([], {});
    expect((await request(bare).get('/api/agent/session')).status).toBe(404);
    expect((await request(bare).post('/api/agent/chat').send({ message: 'hi' })).status).toBe(404);
  });
});

describe('trust proxy', () => {
  // Two proxies sit in front of this (CloudFront, then the ALB). Unset, req.ip
  // is the ALB's address, so every request looks like one client and a per-IP
  // limit would throttle all users as a single bucket.
  it('resolves the client IP through two forwarded hops', async () => {
    const probe = createApp([], { sessionSecret: SECRET, allowedOrigins: [ORIGIN] });
    probe.get('/__ip', (req, res) => res.json({ ip: req.ip }));

    const res = await request(probe)
      .get('/__ip')
      .set('X-Forwarded-For', '203.0.113.9, 70.41.3.18, 150.172.238.178');

    expect(res.body.ip).toBe('70.41.3.18');
  });
});

describe('rate limits and kill switch on the chat route', () => {
  it('429s past the per-session cap, with Retry-After', async () => {
    const a = app({ sessionPerMinute: 2 });
    const cookie = validCookie();
    const post = () =>
      request(a).post('/api/agent/chat').set('Cookie', cookie).set('Origin', ORIGIN).send({ message: 'hi' });

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);

    const limited = await post();
    expect(limited.status).toBe(429);
    // A full minute remains because the clock is pinned to the boundary.
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.body).toEqual({ error: 'too many requests' });
  });

  it('503s when the global daily ceiling is crossed', async () => {
    const a = app({ globalPerDay: 1 });
    const post = () =>
      request(a).post('/api/agent/chat').set('Cookie', validCookie()).set('Origin', ORIGIN).send({ message: 'hi' });

    expect((await post()).status).toBe(200);
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'assistant unavailable' });
    // 12:00 UTC, so half a day until the budget resets.
    expect(res.headers['retry-after']).toBe(String(12 * 3600));
  });

  it('503s when the kill switch is off', async () => {
    const off: AgentStore = { bump: async () => 1, getFlag: async () => false };
    const res = await request(app({}, off))
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({ message: 'hi' });
    expect(res.status).toBe(503);
  });

  // The limiter is what stands between an anonymous endpoint and the bill.
  it('refuses rather than serving unmetered when the store is unreachable', async () => {
    const broken: AgentStore = {
      bump: async () => {
        throw new Error('ddb unreachable');
      },
      getFlag: async () => null,
    };
    const res = await request(app({}, broken))
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({ message: 'hi' });
    expect(res.status).toBe(503);
  });

  // Cheap checks run first so junk never costs a DynamoDB write, and a
  // rejected request does not consume the caller's allowance.
  it('does not count a request that failed an earlier gate', async () => {
    let bumps = 0;
    const counting: AgentStore = {
      bump: async () => ++bumps,
      getFlag: async () => null,
    };
    const a = app({}, counting);
    await request(a).post('/api/agent/chat').set('Origin', ORIGIN).send({ message: 'hi' }); // no cookie
    await request(a).post('/api/agent/chat').set('Cookie', validCookie()).set('Origin', ORIGIN).send({ message: '' });
    expect(bumps).toBe(0);
  });
});

describe('POST /api/agent/brief/commit', () => {
  const T0_NOW = Date.now(); // the endpoint uses the real clock
  const CONTENT = '# Brief\n\nRendered elsewhere, confirmed here.';

  const commit = (body: unknown, cookie = validCookie()) =>
    request(app())
      .post('/api/agent/brief/commit')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send(body as object);

  it('releases the file for a valid token', async () => {
    const token = signBriefToken(CONTENT, SECRET, T0_NOW);
    const res = await commit({ content: CONTENT, token, filename: 'melanoma-brief.md' });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('melanoma-brief.md');
    expect(res.text).toBe(CONTENT);
  });

  // The negatives are the feature: each of these is a way the user's click
  // could be bypassed or forged.
  it('refuses without a session cookie', async () => {
    const token = signBriefToken(CONTENT, SECRET, T0_NOW);
    const res = await request(app())
      .post('/api/agent/brief/commit')
      .set('Origin', ORIGIN)
      .send({ content: CONTENT, token });
    expect(res.status).toBe(403);
  });

  it('refuses content that does not match the token', async () => {
    const token = signBriefToken(CONTENT, SECRET, T0_NOW);
    expect((await commit({ content: CONTENT + ' tampered', token })).status).toBe(403);
  });

  it('refuses an expired token', async () => {
    const token = signBriefToken(CONTENT, SECRET, T0_NOW - BRIEF_TOKEN_TTL_MS - 60_000);
    expect((await commit({ content: CONTENT, token })).status).toBe(403);
  });

  it('refuses a token signed with a different secret', async () => {
    const token = signBriefToken(CONTENT, 'not-the-secret', T0_NOW);
    expect((await commit({ content: CONTENT, token })).status).toBe(403);
  });

  it('rejects malformed bodies', async () => {
    const token = signBriefToken(CONTENT, SECRET, T0_NOW);
    expect((await commit({ token })).status).toBe(400);
    expect((await commit({ content: CONTENT })).status).toBe(400);
    expect((await commit({ content: '', token })).status).toBe(400);
  });

  it('falls back to a safe filename when the requested one is hostile', async () => {
    const token = signBriefToken(CONTENT, SECRET, T0_NOW);
    const res = await commit({ content: CONTENT, token, filename: '../../etc/passwd"' });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('pipeline-radar-brief.md');
  });
});

describe('metrics and tracing hooks', () => {
  const fakeMetrics = () => {
    const calls: { kind: string; args: unknown[] }[] = [];
    return {
      calls,
      metrics: {
        turn: (...args: unknown[]) => calls.push({ kind: 'turn', args }),
        blocked: (...args: unknown[]) => calls.push({ kind: 'blocked', args }),
      },
    };
  };

  const appWith = (metrics: ReturnType<typeof fakeMetrics>['metrics'], over: Partial<typeof DEFAULT_LIMITS> = {}) => {
    const now = () => T0;
    return createApp([], {
      sessionSecret: SECRET,
      allowedOrigins: [ORIGIN],
      runner: stubRunner(),
      metrics,
      limiter: createLimiter({ store: createMemoryStore(now), now, limits: { ...DEFAULT_LIMITS, ...over } }),
    });
  };

  it('emits a turn metric with cost and logs cost_usd for a clean turn', async () => {
    const { calls, metrics } = fakeMetrics();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await request(appWith(metrics))
      .post('/api/agent/chat')
      .set('Cookie', validCookie())
      .set('Origin', ORIGIN)
      .send({ message: 'hello there' });

    const written = log.mock.calls.flat().join(' ');
    log.mockRestore();
    expect(calls.filter((c) => c.kind === 'turn')).toHaveLength(1);
    expect(calls[calls.length - 1].args[0]).toBe('ok');
    expect(written).toContain('"cost_usd"');
  });

  it('emits a blocked metric with the denying scope on a 429', async () => {
    const { calls, metrics } = fakeMetrics();
    const a = appWith(metrics, { sessionPerMinute: 1 });
    const cookie = validCookie();
    const post = () =>
      request(a).post('/api/agent/chat').set('Cookie', cookie).set('Origin', ORIGIN).send({ message: 'hi' });
    await post();
    await post();
    expect(calls.filter((c) => c.kind === 'blocked')).toEqual([
      { kind: 'blocked', args: ['session-minute'] },
    ]);
  });
});
