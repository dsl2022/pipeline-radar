import { ACTIVE_STATUSES, CTGOV_FIELDS, CTGOV_PAGE_SIZE, ctgovStudiesUrl } from './ctgov';
import { apiBase, setApiBase } from './net';

// This request shape is shared by the web app and the agent. The tests are
// here rather than in either consumer because the whole point of the module is
// that neither one owns it.

describe('ctgovStudiesUrl', () => {
  afterEach(() => setApiBase('/api'));

  it('builds a browser-relative URL by default', () => {
    expect(ctgovStudiesUrl({ condition: 'lung cancer' })).toMatch(/^\/api\/ctgov\/v2\/studies\?/);
  });

  it('builds an absolute URL once a base is set, for Node', () => {
    setApiBase('http://127.0.0.1:3001/api');
    expect(ctgovStudiesUrl({ condition: 'lung cancer' })).toMatch(
      /^http:\/\/127\.0\.0\.1:3001\/api\/ctgov\/v2\/studies\?/,
    );
  });

  it('strips a trailing slash from the base rather than doubling it', () => {
    setApiBase('http://127.0.0.1:3001/api/');
    expect(apiBase()).toBe('http://127.0.0.1:3001/api');
    expect(ctgovStudiesUrl({ condition: 'x' })).not.toContain('//ctgov');
  });

  it('encodes the condition rather than interpolating it raw', () => {
    const url = ctgovStudiesUrl({ condition: 'small cell & lung' });
    expect(url).toContain('query.cond=small+cell+%26+lung');
    expect(url).not.toContain('& lung');
  });

  it('asks only for the fields the mapper reads', () => {
    const url = ctgovStudiesUrl({ condition: 'x' });
    const fields = new URLSearchParams(url.split('?')[1]).get('fields');
    expect(fields).toBe(CTGOV_FIELDS.join(','));
  });

  it('requests active studies only, and a total', () => {
    const params = new URLSearchParams(ctgovStudiesUrl({ condition: 'x' }).split('?')[1]);
    expect(params.get('filter.overallStatus')).toBe(ACTIVE_STATUSES.join(','));
    expect(params.get('countTotal')).toBe('true');
    expect(params.get('pageSize')).toBe(String(CTGOV_PAGE_SIZE));
  });

  it('omits the page token unless one is given', () => {
    expect(ctgovStudiesUrl({ condition: 'x' })).not.toContain('pageToken');
    expect(ctgovStudiesUrl({ condition: 'x', pageToken: 'abc' })).toContain('pageToken=abc');
  });

  // Completed and terminated trials are excluded by design; if this list grows
  // to include them the app's "active" claim silently stops being true.
  it('does not ask for completed or terminated studies', () => {
    const statuses = ACTIVE_STATUSES.join(',');
    expect(statuses).not.toMatch(/COMPLETED|TERMINATED|WITHDRAWN|SUSPENDED/);
  });
});
