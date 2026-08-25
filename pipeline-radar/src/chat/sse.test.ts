import { createSseParser, type SseEvent } from './sse';

const collect = () => {
  const events: SseEvent[] = [];
  return { events, parser: createSseParser((e) => events.push(e)) };
};

describe('createSseParser', () => {
  it('parses a complete frame', () => {
    const { events, parser } = collect();
    parser.feed('event: delta\ndata: {"text":"hi"}\n\n');
    expect(events).toEqual([{ event: 'delta', data: { text: 'hi' } }]);
  });

  // The network hands fetch() arbitrary chunk boundaries; a frame split
  // mid-JSON must still come out whole.
  it('reassembles a frame split across chunks', () => {
    const { events, parser } = collect();
    parser.feed('event: del');
    parser.feed('ta\ndata: {"te');
    parser.feed('xt":"hi"}\n\n');
    expect(events).toEqual([{ event: 'delta', data: { text: 'hi' } }]);
  });

  it('parses several frames from one chunk, in order', () => {
    const { events, parser } = collect();
    parser.feed('event: delta\ndata: {"text":"a"}\n\nevent: done\ndata: {"stop":"end_turn"}\n\n');
    expect(events.map((e) => e.event)).toEqual(['delta', 'done']);
  });

  // The server sends `: ping` comments to hold CloudFront's read timeout open;
  // they are transport, not content.
  it('swallows heartbeat comment frames', () => {
    const { events, parser } = collect();
    parser.feed(': ping\n\nevent: delta\ndata: {"text":"hi"}\n\n');
    expect(events).toEqual([{ event: 'delta', data: { text: 'hi' } }]);
  });

  it('tolerates CRLF line endings', () => {
    const { events, parser } = collect();
    parser.feed('event: delta\r\ndata: {"text":"hi"}\r\n\r\n');
    expect(events).toEqual([{ event: 'delta', data: { text: 'hi' } }]);
  });

  it('hands through non-JSON data as text', () => {
    const { events, parser } = collect();
    parser.feed('event: notice\ndata: plain words\n\n');
    expect(events).toEqual([{ event: 'notice', data: 'plain words' }]);
  });

  it('holds an incomplete trailing frame until it finishes', () => {
    const { events, parser } = collect();
    parser.feed('event: delta\ndata: {"text":"hi"}');
    expect(events).toEqual([]);
    parser.feed('\n\n');
    expect(events.length).toBe(1);
  });
});
