import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// The two-phase brief commit (MILESTONE-6-PLAN.md 6.2): prepare_brief renders
// a preview and mints a token over its content; the commit endpoint releases
// the file only for a valid token. The token travels to the BROWSER on an SSE
// event and never enters model context — a token the model could see is a
// confirmation the model could supply, which would collapse the two phases
// back into one.
//
// Stateless on purpose: the token binds an expiry to a hash of the exact
// content, so the server stores nothing between prepare and commit, and a
// tampered brief fails verification rather than shipping under a real token.

/** Long enough to read a preview, short enough that a leaked token goes stale. */
export const BRIEF_TOKEN_TTL_MS = 10 * 60_000;

/** Commit payloads above this are refused before hashing anything. */
export const MAX_BRIEF_CHARS = 200_000;

function mac(contentHash: string, expiresAt: number, secret: string): string {
  return createHmac('sha256', secret).update(`brief:${contentHash}:${expiresAt}`).digest('hex');
}

export function hashBrief(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function signBriefToken(content: string, secret: string, now: number): string {
  const expiresAt = now + BRIEF_TOKEN_TTL_MS;
  return `${expiresAt}.${mac(hashBrief(content), expiresAt, secret)}`;
}

export function verifyBriefToken(content: string, token: string, secret: string, now: number): boolean {
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;

  const given = token.slice(dot + 1);
  const expected = mac(hashBrief(content), expiresAt, secret);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
}
