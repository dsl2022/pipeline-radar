import { HEARTBEAT_MS, openSse } from './sse';

// The heartbeat is why a quiet stream survives: CloudFront's
// origin_read_timeout applies to the gap BETWEEN packets, so a turn that
// thinks for longer than that without emitting anything loses the connection.
// Timers are injected rather than faked globally so the assertion is about
// this module, not about jest's clock.
function fakeRes() {
  const writes: string[] = [];
  const handlers: Record<string, () => void> = {};
  return {
    writes,
    fire: (evt: string) => handlers[evt]?.(),
    res: {
      writeHead: jest.fn(),
      flushHeaders: jest.fn(),
      write: (chunk: string) => writes.push(chunk),
      end: jest.fn(),
      on: (evt: string, fn: () => void) => {
        handlers[evt] = fn;
      },
    },
  };
}

function fakeTimers() {
  let tick: (() => void) | undefined;
  return {
    run: () => tick?.(),
    cleared: () => tick === undefined,
    timers: {
      setInterval: (fn: () => void) => {
        tick = fn;
        return { unref: () => undefined };
      },
      clearInterval: () => {
        tick = undefined;
      },
    },
  };
}

describe('openSse', () => {
  it('emits a comment heartbeat on each interval', () => {
    const { res, writes } = fakeRes();
    const t = fakeTimers();
    openSse(res as never, { timers: t.timers as never });

    t.run();
    t.run();
    expect(writes.filter((w) => w === ': ping\n\n')).toHaveLength(2);
  });

  it('beats more often than the 30s origin read timeout it exists to defeat', () => {
    expect(HEARTBEAT_MS).toBeLessThan(30_000);
  });

  it('writes events in SSE wire format', () => {
    const { res, writes } = fakeRes();
    const stream = openSse(res as never, { timers: fakeTimers().timers as never });
    stream.event('delta', { text: 'hi' });
    expect(writes.join('')).toBe('event: delta\ndata: {"text":"hi"}\n\n');
  });

  it('stops beating once closed', () => {
    const { res, writes } = fakeRes();
    const t = fakeTimers();
    const stream = openSse(res as never, { timers: t.timers as never });
    stream.close();
    t.run();
    expect(writes.filter((w) => w === ': ping\n\n')).toHaveLength(0);
    expect(stream.closed).toBe(true);
  });

  // A user closing the tab mid-answer must not leave a timer per abandoned stream.
  it('stops beating when the client disconnects', () => {
    const { res, writes, fire } = fakeRes();
    const t = fakeTimers();
    const stream = openSse(res as never, { timers: t.timers as never });
    fire('close');
    t.run();
    expect(writes.filter((w) => w === ': ping\n\n')).toHaveLength(0);
    expect(t.cleared()).toBe(true);
    expect(stream.closed).toBe(true);
  });

  it('ignores writes after close', () => {
    const { res, writes } = fakeRes();
    const stream = openSse(res as never, { timers: fakeTimers().timers as never });
    stream.close();
    const before = writes.length;
    stream.event('delta', { text: 'late' });
    stream.comment('late');
    expect(writes).toHaveLength(before);
  });
});
