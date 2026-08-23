import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Anonymous session identity. This is NOT authentication - there are no user
// accounts - it is a stable key to rate-limit against that a casual script
// will not carry. Signed rather than opaque so verifying costs no round trip;
// the id itself is meaningless until a counter is written against it.
//
// The signing key has to be shared infrastructure: desired_count is 2, so a
// per-process secret would mean a cookie minted by one task is rejected by
// the other.

const SEP = '.';

export const SESSION_COOKIE = 'pr_sid';

export function newSessionId(): string {
  return randomBytes(16).toString('hex');
}

export function signSession(id: string, secret: string): string {
  return id + SEP + hmac(id, secret);
}

/** Returns the session id, or null if absent, malformed, or not ours. */
export function verifySession(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const cut = value.lastIndexOf(SEP);
  if (cut <= 0) return null;

  const id = value.slice(0, cut);
  const sig = value.slice(cut + 1);
  // Ids are hex from newSessionId, so anything else cannot have been issued
  // here. Checking shape first also keeps unbounded input out of the HMAC.
  if (!/^[0-9a-f]{32}$/.test(id)) return null;

  return safeEqual(sig, hmac(id, secret)) ? id : null;
}

function hmac(id: string, secret: string): string {
  return createHmac('sha256', secret).update(id).digest('hex');
}

// Constant time: a length-dependent early return would leak how much of a
// forged signature is correct.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
