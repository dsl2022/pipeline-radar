import { SESSION_COOKIE, newSessionId, signSession, verifySession } from './session';

const SECRET = 'test-secret-do-not-use';

describe('session cookie', () => {
  it('round-trips an id it issued', () => {
    const id = newSessionId();
    expect(verifySession(signSession(id, SECRET), SECRET)).toBe(id);
  });

  it('issues distinct ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
    expect(ids.size).toBe(50);
  });

  it('names the cookie predictably', () => {
    expect(SESSION_COOKIE).toBe('pr_sid');
  });

  // Everything below is the negative case - the reason this module exists.
  it('rejects a tampered signature', () => {
    const id = newSessionId();
    const signed = signSession(id, SECRET);
    const tampered = signed.slice(0, -1) + (signed.endsWith('a') ? 'b' : 'a');
    expect(verifySession(tampered, SECRET)).toBeNull();
  });

  it('rejects a tampered id', () => {
    const id = newSessionId();
    const sig = signSession(id, SECRET).split('.')[1];
    const otherId = newSessionId();
    expect(verifySession(`${otherId}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects a cookie signed with a different secret', () => {
    const signed = signSession(newSessionId(), 'someone-elses-secret');
    expect(verifySession(signed, SECRET)).toBeNull();
  });

  it('rejects an unsigned id', () => {
    expect(verifySession(newSessionId(), SECRET)).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['no separator', 'deadbeef'],
    ['separator only', '.'],
    ['empty id', '.abc'],
    ['non-hex id', `${'z'.repeat(32)}.abc`],
    ['short id', 'abc.def'],
  ])('rejects malformed input: %s', (_label, value) => {
    expect(verifySession(value as string | undefined, SECRET)).toBeNull();
  });

  // The id shape is checked before hashing, so a huge value costs nothing.
  it('rejects an oversized value without hashing it', () => {
    expect(verifySession(`${'a'.repeat(1_000_000)}.sig`, SECRET)).toBeNull();
  });
});
