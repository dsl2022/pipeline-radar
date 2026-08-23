import type { Response } from 'express';

// Server-sent events, with the heartbeat that keeps a quiet stream alive.
//
// This is not cosmetic. CloudFront's origin_read_timeout applies to the gap
// BETWEEN packets, so a turn that thinks for longer than that without
// emitting anything loses the connection - and the client sees a truncated
// answer rather than an error. The ALB idle timeout behaves the same way.
// A comment line costs a few bytes and is ignored by EventSource.
export const HEARTBEAT_MS = 10_000;

export interface SseStream {
  event(name: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
}

interface Timers {
  setInterval: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval: (handle: never) => void;
}

export function openSse(
  res: Response,
  opts: { heartbeatMs?: number; timers?: Timers } = {},
): SseStream {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const timers = (opts.timers ?? globalThis) as unknown as Timers;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Belt and braces for any proxy that buffers by default; CloudFront does
    // not, but a reverse proxy in front of it in dev might.
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  const beat = timers.setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, heartbeatMs);
  // Never hold the process open for a heartbeat.
  beat.unref?.();

  const stop = () => {
    if (closed) return;
    closed = true;
    timers.clearInterval(beat as never);
  };

  // The client going away is the common case, not an error: a user closing
  // the tab mid-answer must not leave a timer running per abandoned stream.
  res.on('close', stop);

  return {
    event(name, data) {
      if (closed) return;
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (closed) return;
      res.write(`: ${text}\n\n`);
    },
    close() {
      if (closed) return;
      stop();
      res.end();
    },
    get closed() {
      return closed;
    },
  };
}
