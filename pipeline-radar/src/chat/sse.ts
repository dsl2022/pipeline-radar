// Incremental SSE parser for the chat stream.
//
// fetch() is the transport because EventSource cannot POST. The body arrives
// as arbitrary chunks, so frames can split anywhere — mid-line, mid-JSON —
// and the parser buffers until it holds a complete `\n\n`-terminated frame.

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseParser {
  feed(chunk: string): void;
}

export function createSseParser(onEvent: (e: SseEvent) => void): SseParser {
  let buf = '';

  return {
    feed(chunk: string) {
      buf += chunk;
      for (;;) {
        // Frames end at a blank line; tolerate CRLF from any middlebox.
        const lf = buf.indexOf('\n\n');
        const crlf = buf.indexOf('\r\n\r\n');
        const at = lf >= 0 && (crlf < 0 || lf < crlf) ? lf : crlf;
        if (at < 0) return;
        const sep = at === lf ? 2 : 4;

        const frame = buf.slice(0, at);
        buf = buf.slice(at + sep);

        let event = 'message';
        const dataLines: string[] = [];
        for (const raw of frame.split('\n')) {
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
          if (line.startsWith(':')) continue; // heartbeat comment
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // A frame of only comments (the `: ping` heartbeat) carries nothing.
        if (dataLines.length === 0) continue;

        const raw = dataLines.join('\n');
        let data: unknown = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          // Not JSON - hand the text through rather than dropping the event.
        }
        onEvent({ event, data });
      }
    },
  };
}
