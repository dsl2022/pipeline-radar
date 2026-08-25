import { BRIEF_TOKEN_TTL_MS, signBriefToken, verifyBriefToken } from './brief';

// The token IS the two-phase commit: if any of these fail open, the model (or
// anyone) can release a brief without the user's click.

const SECRET = 'test-brief-secret';
const T0 = 1_756_000_000_000;
const CONTENT = '# Brief\n\nSome rendered markdown.';

describe('brief tokens', () => {
  it('round-trips within the TTL', () => {
    const token = signBriefToken(CONTENT, SECRET, T0);
    expect(verifyBriefToken(CONTENT, token, SECRET, T0)).toBe(true);
    expect(verifyBriefToken(CONTENT, token, SECRET, T0 + BRIEF_TOKEN_TTL_MS - 1)).toBe(true);
  });

  it('expires', () => {
    const token = signBriefToken(CONTENT, SECRET, T0);
    expect(verifyBriefToken(CONTENT, token, SECRET, T0 + BRIEF_TOKEN_TTL_MS + 1)).toBe(false);
  });

  it('rejects content that differs from what was signed, by even one character', () => {
    const token = signBriefToken(CONTENT, SECRET, T0);
    expect(verifyBriefToken(CONTENT + ' ', token, SECRET, T0)).toBe(false);
  });

  it('rejects a token signed with another secret', () => {
    const token = signBriefToken(CONTENT, 'other-secret', T0);
    expect(verifyBriefToken(CONTENT, token, SECRET, T0)).toBe(false);
  });

  it.each([
    ['garbage', 'not-a-token'],
    ['missing mac', '999999999999.'],
    ['non-numeric expiry', 'soon.deadbeef'],
    ['empty', ''],
  ])('rejects a malformed token: %s', (_name, token) => {
    expect(verifyBriefToken(CONTENT, token, SECRET, T0)).toBe(false);
  });

  // An attacker who can pick the expiry must not be able to push it forward:
  // the expiry is inside the MAC, so editing it invalidates the token.
  it('rejects a token whose expiry was extended after signing', () => {
    const token = signBriefToken(CONTENT, SECRET, T0);
    const [, mac] = token.split('.');
    expect(verifyBriefToken(CONTENT, `${T0 + 10 * BRIEF_TOKEN_TTL_MS}.${mac}`, SECRET, T0)).toBe(false);
  });
});
