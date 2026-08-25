import { MAX_MESSAGE_CHARS, hasControlChars, validateHistory } from '@pipeline-radar/shared/chat';

// Gates that run before the model. Each returns a reason on rejection so the
// route can log which gate fired without telling the caller why.
//
// The message cap, the control-character rule and the history shape live in
// shared/chat.ts so the web panel trims against the exact bounds this file
// rejects on. Re-exported here so the route and the tests keep one import.
export { MAX_MESSAGE_CHARS, validateHistory };

export type GuardResult = { ok: true } | { ok: false; reason: string };

/** Carries the value through, so the caller gets a string rather than re-casting unknown. */
export type MessageResult = { ok: true; value: string } | { ok: false; reason: string };

export function validateMessage(value: unknown): MessageResult {
  if (typeof value !== 'string') return { ok: false, reason: 'message must be a string' };
  if (value.trim().length === 0) return { ok: false, reason: 'message is empty' };
  if (value.length > MAX_MESSAGE_CHARS) {
    return { ok: false, reason: `message exceeds ${MAX_MESSAGE_CHARS} characters` };
  }
  if (hasControlChars(value)) {
    return { ok: false, reason: 'message contains control characters' };
  }
  return { ok: true, value };
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
