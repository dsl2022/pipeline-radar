// Gates that run before the model. Each returns a reason on rejection so the
// route can log which gate fired without telling the caller why.

/** MILESTONE-6-PLAN.md 6.1: 4k characters, no control characters. */
export const MAX_MESSAGE_CHARS = 4000;

export type GuardResult = { ok: true } | { ok: false; reason: string };

// Tab, newline and carriage return are legitimate in a pasted question. The
// rest of C0, DEL, and the C1 range are not, and are a cheap way to smuggle
// terminal escapes or confuse whatever parses the transcript later.
// eslint-disable-next-line no-control-regex -- rejecting these is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export function validateMessage(value: unknown): GuardResult {
  if (typeof value !== 'string') return { ok: false, reason: 'message must be a string' };
  if (value.trim().length === 0) return { ok: false, reason: 'message is empty' };
  if (value.length > MAX_MESSAGE_CHARS) {
    return { ok: false, reason: `message exceeds ${MAX_MESSAGE_CHARS} characters` };
  }
  if (CONTROL_CHARS.test(value)) {
    return { ok: false, reason: 'message contains control characters' };
  }
  return { ok: true };
}

/**
 * Cross-site check for the chat POST. The session cookie is SameSite=Lax,
 * which already blocks cross-site POSTs in current browsers; this is cheap,
 * independent of cookie policy, and covers clients that send one anyway.
 *
 * A request with neither header is allowed. Non-browser callers (curl, the
 * post-deploy smoke suite) legitimately omit both, and this gate is not what
 * stands between an attacker and the endpoint - the cookie and the rate
 * limits are.
 */
export function checkSameSite(
  headers: { origin?: string; referer?: string },
  allowedOrigins: string[],
): GuardResult {
  const raw = headers.origin ?? headers.referer;
  if (!raw) return { ok: true };

  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    return { ok: false, reason: 'unparseable origin' };
  }
  return allowedOrigins.includes(origin) ? { ok: true } : { ok: false, reason: 'cross-site request' };
}
