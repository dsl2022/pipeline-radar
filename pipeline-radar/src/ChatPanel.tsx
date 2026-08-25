import { useEffect, useRef, useState } from 'react';
import { MAX_MESSAGE_CHARS } from '@pipeline-radar/shared/chat';
import { createSseParser } from './chat/sse';
import { nctUrl, parseMarkdown, type Block, type Inline } from './chat/markdown';
import { buildChatContext, type AppSnapshot } from './chat/context';
import { applyEvent, emptyAssistant, historyFrom, type AssistantMsg, type BriefCard, type Msg } from './chat/turns';

// The chat surface for the agent (MILESTONE-6-PR-PLAN.md PR 8). Hand-rolled
// rather than a component library: zero new dependencies, and the panel owns
// nothing but presentation — the loop, the tools and every gate live in the
// api workspace.
//
// Transport is fetch + SSE parsing because EventSource cannot POST. The
// history sent with each question comes from historyFrom(), so a turn the
// server refused or that errored is never replayed.

export interface ChatPanelProps {
  /** What the user currently sees; sent as request context for the copilot. */
  app?: AppSnapshot;
  /** Applies a set_view command the agent sent. Absent = commands are dropped. */
  onViewCommand?: (command: unknown) => void;
}

/** Follow-up questions ride on prior turns; see shared/chat.ts for bounds. */
export function ChatPanel({ app, onViewCommand }: ChatPanelProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const sessionReady = useRef<Promise<void> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Cookie issuance is idempotent server-side; one request per page load.
  function ensureSession(): Promise<void> {
    sessionReady.current ??= fetch('/api/agent/session').then(
      () => undefined,
      () => {
        sessionReady.current = null; // let a later send retry
      },
    );
    return sessionReady.current;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function patchLive(fn: (m: AssistantMsg) => AssistantMsg) {
    setMessages((msgs) => {
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') return msgs;
      return [...msgs.slice(0, -1), fn(last)];
    });
  }

  async function send() {
    const question = draft.trim();
    if (!question || busy || question.length > MAX_MESSAGE_CHARS) return;

    const history = historyFrom(messages);
    setDraft('');
    setMessages((m) => [...m, { role: 'user', text: question }, emptyAssistant()]);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await ensureSession();
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: question,
          history,
          ...(app ? { context: buildChatContext(app) } : {}),
        }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        patchLive((m) => ({ ...m, streaming: false, error: refusalText(res) }));
        return;
      }

      const parser = createSseParser((ev) => {
        // view commands steer the app, not the transcript; everything else
        // folds into the streaming message.
        if (ev.event === 'view') {
          onViewCommand?.(ev.data);
          return;
        }
        patchLive((m) => applyEvent(m, ev));
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      patchLive((m) => ({ ...m, streaming: false }));
    } catch {
      // Abort (Stop button, unmount) or a network failure mid-stream.
      patchLive((m) =>
        ctrl.signal.aborted
          ? { ...m, streaming: false, notice: m.notice ?? 'Stopped.' }
          : { ...m, streaming: false, error: 'The connection was lost mid-answer.' },
      );
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  if (!open) {
    return (
      <button type="button" className="chat-open" onClick={() => setOpen(true)}>
        Ask the assistant
      </button>
    );
  }

  return (
    <section className="chat-panel" aria-label="Pipeline Radar assistant">
      <header className="chat-header">
        <div>
          <strong>Assistant</strong>
          <span className="chat-disclaimer">AI-generated — verify against source records</span>
        </div>
        <button type="button" className="chat-close" onClick={() => setOpen(false)} aria-label="Close chat">
          ×
        </button>
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="chat-empty">
            Ask about trials or drugs — e.g. “which phase 3 lung cancer trials are recruiting?”
          </p>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="chat-msg chat-user">
              {m.text}
            </div>
          ) : (
            <AssistantBubble key={i} msg={m} />
          ),
        )}
      </div>

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={draft}
          rows={2}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder="Ask about the trial landscape…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={draft.trim().length === 0}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}

function refusalText(res: Response): string {
  if (res.status === 429) {
    const retry = res.headers.get('retry-after');
    return retry
      ? `Rate limit reached — try again in ${retry}s.`
      : 'Rate limit reached — try again shortly.';
  }
  if (res.status === 503) return 'The assistant is unavailable right now.';
  return 'The assistant could not take that question.';
}

const TOOL_LABELS: Record<string, string> = {
  search_trials: 'Searching trials',
  summarize_trials: 'Summarizing',
  build_drug_landscape: 'Building drug landscape',
  check_fda_approval: 'Checking FDA status',
  get_trial_detail: 'Reading trial record',
  get_adverse_events: 'Checking adverse events',
  pubmed_count: 'Counting publications',
  diff_watchlist: 'Reading watchlist changes',
  set_view: 'Updating the view',
  prepare_brief: 'Preparing brief',
};

/**
 * The second phase of the two-phase brief: the download happens only on this
 * click, sending back the exact content and the token the server minted over
 * it. A modified preview or a stale token gets a 403, not a file.
 */
function BriefCardView({ brief }: { brief: BriefCard }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  async function download() {
    setState('busy');
    try {
      const res = await fetch('/api/agent/brief/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: brief.markdown, token: brief.token, filename: brief.filename }),
      });
      if (!res.ok) {
        setState('error');
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = brief.filename;
      a.click();
      URL.revokeObjectURL(url);
      setState('done');
    } catch {
      setState('error');
    }
  }

  return (
    <div className="chat-brief">
      <div className="chat-brief-head">
        <span className="chat-brief-name">{brief.filename}</span>
        <button type="button" onClick={download} disabled={state === 'busy'}>
          {state === 'busy' ? 'Preparing…' : state === 'done' ? 'Download again' : 'Download'}
        </button>
      </div>
      {state === 'error' && (
        <p className="chat-error">The download was refused — ask for the brief again to get a fresh preview.</p>
      )}
      <details>
        <summary>Preview</summary>
        <div className="chat-brief-preview">
          <Markdown text={brief.markdown} />
        </div>
      </details>
    </div>
  );
}

function AssistantBubble({ msg }: { msg: AssistantMsg }) {
  return (
    <div className="chat-msg chat-assistant">
      {msg.tools.length > 0 && (
        <div className="chat-tools">
          {msg.tools.map((name, i) => (
            <span key={i} className="chat-tool-chip">
              {TOOL_LABELS[name] ?? name}
            </span>
          ))}
        </div>
      )}
      {msg.text.length > 0 ? (
        <Markdown text={msg.text} unverified={msg.unverified} />
      ) : msg.streaming ? (
        <p className="chat-waiting">{msg.thinking ? 'Thinking…' : 'Working…'}</p>
      ) : null}
      {msg.brief && <BriefCardView brief={msg.brief} />}
      {msg.notice && <p className="chat-notice">{msg.notice}</p>}
      {msg.error && <p className="chat-error">{msg.error}</p>}
    </div>
  );
}

function Markdown({ text, unverified = [] }: { text: string; unverified?: string[] }) {
  const blocks = parseMarkdown(text);
  return (
    <>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} unverified={unverified} />
      ))}
    </>
  );
}

function BlockView({ block, unverified }: { block: Block; unverified: string[] }) {
  switch (block.kind) {
    case 'heading':
      // Answers render inside a panel; every heading level maps to the same
      // small bold line rather than page-level h-tags.
      return (
        <p className="chat-heading">
          <Inlines inlines={block.inlines} unverified={unverified} />
        </p>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <Inlines inlines={item} unverified={unverified} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table':
      return (
        <div className="chat-table-wrap">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i}>
                    <Inlines inlines={cell} unverified={unverified} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>
                      <Inlines inlines={cell} unverified={unverified} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return (
        <p>
          <Inlines inlines={block.inlines} unverified={unverified} />
        </p>
      );
  }
}

function Inlines({ inlines, unverified = [] }: { inlines: Inline[]; unverified?: string[] }) {
  return (
    <>
      {inlines.map((t, i) => {
        switch (t.kind) {
          case 'bold':
            return <strong key={i}>{t.text}</strong>;
          case 'code':
            return <code key={i}>{t.text}</code>;
          case 'nct':
            // An ID the server's citation checker could not resolve to a tool
            // result is flagged, not linked: linking a fabricated ID would
            // dress the hallucination up as a source.
            if (unverified.includes(t.id)) {
              return (
                <span
                  key={i}
                  className="chat-nct chat-nct-unverified"
                  title="This trial ID did not come from any data source this session - treat it as unverified."
                >
                  {t.id} (unverified)
                </span>
              );
            }
            // The only anchors the panel ever renders: built from the matched
            // ID, pointing at the canonical registry record. Model-composed
            // URLs stay plain text (see chat/markdown.ts).
            return (
              <a key={i} className="chat-nct" href={nctUrl(t.id)} target="_blank" rel="noreferrer noopener">
                {t.id}
              </a>
            );
          default:
            return <span key={i}>{t.text}</span>;
        }
      })}
    </>
  );
}
