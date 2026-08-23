import request from 'supertest';
import { createApp } from '../app';
import { SESSION_COOKIE, newSessionId, signSession } from './session';

const SECRET = 'test-secret-do-not-use';
const ORIGIN = 'https://app.example.com';

// No upstreams: these tests must never reach the network.
const app = () => createApp([], { sessionSecret: SECRET, allowedOrigins: [ORIGIN] });

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

  it('does not disclose which gate rejected the request', async () => {
    const res = await request(app())
      .post('/api/agent/chat')
      .set('Origin', ORIGIN)
      .send({ message: 'hello' });
    expect(res.body.error).toBe('session required');
    expect(JSON.stringify(res.body)).not.toContain('gate');
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
