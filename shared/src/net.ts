// Where the shared data modules send their upstream requests.
//
// These modules were written for the browser, where "/api/openfda/..." is a
// relative URL resolved against the page origin. Node has no page origin:
// fetch() rejects a relative path outright with "Failed to parse URL". The
// agent runs this same code server-side, so the base has to be injectable.
//
// The default is the relative form, so the browser keeps behaving exactly as
// it did - this file adds a seam, it does not change the frontend.
//
// The API service points this at its OWN proxy rather than at openFDA and
// RxNorm directly. That is deliberate: the proxy holds the shared TTL cache
// that pools openFDA's 1,000/day PER-IP quota. Both Fargate tasks leave
// through the same NAT address, so bypassing the proxy would spend one shared
// quota from two uncoordinated callers.

let base = '/api';

/** Absolute base ("http://127.0.0.1:8080/api") for Node, relative for browsers. */
export function setApiBase(next: string): void {
  base = next.replace(/\/+$/, '');
}

export function apiBase(): string {
  return base;
}
