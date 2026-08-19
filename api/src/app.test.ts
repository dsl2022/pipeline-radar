import request from 'supertest';
import { createApp } from './app';

// The proxy's whole contract: prefix mapping, query passthrough, TTL caching
// of 200s AND 404s (a miss is data for openFDA/RxNorm), no caching of errors,
// read-only. global.fetch is mocked — no network in tests.

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function upstreamResponse(status: number, body: unknown) {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('proxy', () => {
  it('answers /healthz without touching upstreams', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps each prefix to its upstream, preserving path and query verbatim', async () => {
    fetchMock.mockResolvedValue(upstreamResponse(200, { ok: 1 }));
    const app = createApp();

    await request(app).get('/api/ctgov/v2/studies?query.cond=lung+cancer&pageSize=500');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://clinicaltrials.gov/api/v2/studies?query.cond=lung+cancer&pageSize=500',
      expect.anything(),
    );

    await request(app).get('/api/openfda/drug/drugsfda.json?search=x&limit=100');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.fda.gov/drug/drugsfda.json?search=x&limit=100',
      expect.anything(),
    );

    await request(app).get('/api/rxnorm/rxcui.json?name=pembrolizumab&allsrc=1');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=pembrolizumab&allsrc=1',
      expect.anything(),
    );
  });

  it('serves the second identical request from cache', async () => {
    fetchMock.mockResolvedValue(upstreamResponse(200, { total: 42 }));
    const app = createApp();

    const first = await request(app).get('/api/ctgov/v2/studies?pageSize=1');
    expect(first.headers['x-cache']).toBe('miss');
    const second = await request(app).get('/api/ctgov/v2/studies?pageSize=1');
    expect(second.headers['x-cache']).toBe('hit');
    expect(second.body).toEqual({ total: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes 404 through and caches it — a miss is data for openFDA', async () => {
    fetchMock.mockResolvedValue(upstreamResponse(404, { error: { code: 'NOT_FOUND' } }));
    const app = createApp();

    const first = await request(app).get('/api/openfda/drug/drugsfda.json?search=nope');
    expect(first.status).toBe(404);
    const second = await request(app).get('/api/openfda/drug/drugsfda.json?search=nope');
    expect(second.status).toBe(404);
    expect(second.headers['x-cache']).toBe('hit');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never caches upstream 5xx', async () => {
    fetchMock.mockResolvedValue(upstreamResponse(503, { down: true }));
    const app = createApp();

    await request(app).get('/api/ctgov/v2/studies');
    await request(app).get('/api/ctgov/v2/studies');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns 502 on network failure without caching', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const app = createApp();

    const res = await request(app).get('/api/rxnorm/rxcui.json?name=x');
    expect(res.status).toBe(502);
    fetchMock.mockResolvedValue(upstreamResponse(200, { ok: 1 }));
    const retry = await request(app).get('/api/rxnorm/rxcui.json?name=x');
    expect(retry.status).toBe(200);
  });

  it('rejects non-GET methods', async () => {
    const res = await request(createApp()).post('/api/ctgov/v2/studies');
    expect(res.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unknown paths outside the prefixes 404 locally', async () => {
    const res = await request(createApp()).get('/api/evil/../../etc/passwd');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
