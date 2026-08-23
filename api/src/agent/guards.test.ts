import { MAX_MESSAGE_CHARS, checkSameSite, validateMessage } from './guards';

describe('validateMessage', () => {
  it('accepts an ordinary question', () => {
    // The validated string is carried through, so the route hands the runner a
    // string rather than re-casting the unknown body field.
    expect(validateMessage('which phase 3 EGFR drugs are recruiting?')).toEqual({
      ok: true,
      value: 'which phase 3 EGFR drugs are recruiting?',
    });
  });

  it('accepts newlines and tabs, which appear in pasted text', () => {
    expect(validateMessage('line one\nline two\tindented\r\n')).toEqual({
      ok: true,
      value: 'line one\nline two\tindented\r\n',
    });
  });

  it('accepts exactly the cap', () => {
    expect(validateMessage('a'.repeat(MAX_MESSAGE_CHARS))).toEqual({
      ok: true,
      value: 'a'.repeat(MAX_MESSAGE_CHARS),
    });
  });

  it('rejects one character over the cap', () => {
    const res = validateMessage('a'.repeat(MAX_MESSAGE_CHARS + 1));
    expect(res.ok).toBe(false);
  });

  it.each([
    ['null byte', 'hello\u0000world'],
    ['bell', 'hello\u0007world'],
    ['escape', 'hello\u001Bworld'],
    ['unit separator', 'hello\u001Fworld'],
    ['delete', 'hello\u007Fworld'],
    ['C1 range', 'hello\u009Bworld'],
  ])('rejects control characters: %s', (_label, value) => {
    const res = validateMessage(value);
    expect(res).toEqual({ ok: false, reason: 'message contains control characters' });
  });

  it.each([
    ['number', 42],
    ['object', { message: 'hi' }],
    ['array', ['hi']],
    ['null', null],
    ['undefined', undefined],
  ])('rejects non-strings: %s', (_label, value) => {
    expect(validateMessage(value).ok).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['newlines only', '\n\n'],
  ])('rejects blank input: %s', (_label, value) => {
    expect(validateMessage(value)).toEqual({ ok: false, reason: 'message is empty' });
  });
});

describe('checkSameSite', () => {
  const allowed = ['https://app.example.com', 'http://localhost:5173'];

  it('accepts an allowed Origin', () => {
    expect(checkSameSite({ origin: 'https://app.example.com' }, allowed)).toEqual({ ok: true });
  });

  it('accepts an allowed Referer when Origin is absent', () => {
    expect(checkSameSite({ referer: 'http://localhost:5173/some/path' }, allowed)).toEqual({
      ok: true,
    });
  });

  it('prefers Origin over Referer', () => {
    const res = checkSameSite(
      { origin: 'https://evil.example.com', referer: 'https://app.example.com' },
      allowed,
    );
    expect(res.ok).toBe(false);
  });

  it('rejects a cross-site Origin', () => {
    expect(checkSameSite({ origin: 'https://evil.example.com' }, allowed)).toEqual({
      ok: false,
      reason: 'cross-site request',
    });
  });

  it('rejects a look-alike origin rather than substring-matching it', () => {
    expect(checkSameSite({ origin: 'https://app.example.com.evil.net' }, allowed).ok).toBe(false);
  });

  it('rejects an unparseable origin', () => {
    expect(checkSameSite({ origin: 'not a url' }, allowed).ok).toBe(false);
  });

  // Deliberate: curl and the post-deploy smoke suite send neither header, and
  // this gate is not what stands between an attacker and the endpoint.
  it('allows a request with neither header', () => {
    expect(checkSameSite({}, allowed)).toEqual({ ok: true });
  });
});
