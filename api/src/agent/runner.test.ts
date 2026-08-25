import type Anthropic from '@anthropic-ai/sdk';
import {
  MAX_ITERATIONS,
  MAX_TOKENS,
  TASK_BUDGET_TOKENS,
  WALL_CLOCK_MS,
  createAgentRunner,
  describeStop,
} from './runner';

// The bounds in this file are the ones that decide what a runaway turn costs,
// so they are asserted as values rather than trusted to a code review. A test
// that only checked "the runner returns text" would pass just as happily with
// max_iterations removed entirely.

interface FakeTurn {
  text?: string;
  thinking?: string;
  toolUses?: { name: string; input: unknown }[];
  stop_reason?: string;
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }>;
}

function fakeClient(turns: FakeTurn[], onParams?: (p: Record<string, unknown>) => void) {
  const captured: {
    params?: Record<string, unknown>;
    options?: { signal?: AbortSignal };
    pushed?: unknown[];
  } = {};

  const client = {
    beta: {
      messages: {
        toolRunner(params: Record<string, unknown>, options?: { signal?: AbortSignal }) {
          captured.params = params;
          captured.options = options;
          onParams?.(params);

          const pushed: unknown[] = [];
          captured.pushed = pushed;
          return {
            pushMessages: (...m: unknown[]) => pushed.push(...m),
            async *[Symbol.asyncIterator]() {
              for (const turn of turns) {
                if (options?.signal?.aborted) throw new Error('aborted');
                const handlers: Record<string, ((d: string) => void)[]> = {};
                yield {
                  on(event: string, cb: (d: string) => void) {
                    (handlers[event] ??= []).push(cb);
                  },
                  async finalMessage() {
                    if (turn.text) for (const cb of handlers.text ?? []) cb(turn.text);
                    if (turn.thinking) for (const cb of handlers.thinking ?? []) cb(turn.thinking);
                    return {
                      content: [
                        ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
                        ...(turn.toolUses ?? []).map((t) => ({
                          type: 'tool_use',
                          id: 'tu_1',
                          name: t.name,
                          input: t.input,
                        })),
                      ],
                      stop_reason: turn.stop_reason ?? 'end_turn',
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                        ...turn.usage,
                      },
                    };
                  },
                };
              }
            },
          };
        },
      },
    },
  } as unknown as Anthropic;

  return { client, captured };
}

const collect = () => {
  const events: { event: string; data: unknown }[] = [];
  return { events, emit: (event: string, data: unknown) => events.push({ event, data }) };
};

describe('per-turn bounds', () => {
  it('sends every documented bound to the API', async () => {
    const { client, captured } = fakeClient([{ text: 'hello' }]);
    const { emit } = collect();
    await createAgentRunner({ client, tools: [] }).run({ message: 'hi' }, emit);

    const p = captured.params!;
    expect(p.model).toBe('claude-opus-5');
    expect(p.max_tokens).toBe(MAX_TOKENS);
    expect(p.max_iterations).toBe(MAX_ITERATIONS);
    expect(p.output_config).toEqual({ task_budget: { type: 'tokens', total: TASK_BUDGET_TOKENS } });
    expect(p.stream).toBe(true);
  });

  // The API rejects a budget under 20k, and a budget above max_tokens would
  // never bind - the value has to sit between the two to do anything.
  it('keeps the task budget inside the range where it has an effect', () => {
    expect(TASK_BUDGET_TOKENS).toBeGreaterThanOrEqual(20_000);
    expect(TASK_BUDGET_TOKENS).toBeLessThanOrEqual(MAX_TOKENS);
  });

  // Above this and the ALB drops the connection mid-answer, which surfaces as
  // a truncated reply rather than an error we can report.
  it('keeps the wall clock below the ALB idle timeout', () => {
    expect(WALL_CLOCK_MS).toBeLessThan(240_000);
  });

  it('asks for summarized adaptive thinking rather than the silent default', async () => {
    const { client, captured } = fakeClient([{ text: 'hi' }]);
    await createAgentRunner({ client, tools: [] }).run({ message: 'hi' }, collect().emit);
    expect(captured.params!.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('enables the betas the bounds and fallbacks depend on', async () => {
    const { client, captured } = fakeClient([{ text: 'hi' }]);
    await createAgentRunner({ client, tools: [] }).run({ message: 'hi' }, collect().emit);
    expect(captured.params!.betas).toContain('task-budgets-2026-03-13');
    expect(captured.params!.betas).toContain('server-side-fallback-2026-07-01');
    expect(captured.params!.fallbacks).toBe('default');
  });

  // Without the breakpoint every turn re-pays full input price for a prompt
  // that never changes.
  it('marks the system prompt as cacheable', async () => {
    const { client, captured } = fakeClient([{ text: 'hi' }]);
    await createAgentRunner({ client, tools: [] }).run({ message: 'hi' }, collect().emit);
    const system = captured.params!.system as { cache_control?: unknown }[];
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('conversation history', () => {
  it('replays the history before the question, in order', async () => {
    const { client, captured } = fakeClient([{ text: 'hi' }]);
    await createAgentRunner({ client, tools: [] }).run(
      {
        message: 'and in children?',
        history: [
          { role: 'user', text: 'trials for lung cancer?' },
          { role: 'assistant', text: 'there are 2,460.' },
        ],
      },
      collect().emit,
    );
    expect(captured.params!.messages).toEqual([
      { role: 'user', content: 'trials for lung cancer?' },
      { role: 'assistant', content: 'there are 2,460.' },
      { role: 'user', content: 'and in children?' },
    ]);
  });

  it('sends just the question when there is no history', async () => {
    const { client, captured } = fakeClient([{ text: 'hi' }]);
    await createAgentRunner({ client, tools: [] }).run({ message: 'q' }, collect().emit);
    expect(captured.params!.messages).toEqual([{ role: 'user', content: 'q' }]);
  });
});

describe('streaming a turn', () => {
  it('emits text deltas as they arrive', async () => {
    const { client } = fakeClient([{ text: 'the answer' }]);
    const { events, emit } = collect();
    await createAgentRunner({ client, tools: [] }).run({ message: 'q' }, emit);
    expect(events).toContainEqual({ event: 'delta', data: { text: 'the answer' } });
  });

  it('emits thinking separately from the answer', async () => {
    const { client } = fakeClient([{ thinking: 'weighing it up', text: 'done' }]);
    const { events, emit } = collect();
    await createAgentRunner({ client, tools: [] }).run({ message: 'q' }, emit);
    expect(events).toContainEqual({ event: 'thinking', data: { text: 'weighing it up' } });
  });

  // The tool input echoes the user's question back. This event is rendered in
  // the UI and logged, so it carries the name and nothing else.
  it('emits the tool name without its input', async () => {
    const { client } = fakeClient([
      { toolUses: [{ name: 'search_trials', input: { condition: 'a private question' } }], stop_reason: 'tool_use' },
      { text: 'done' },
    ]);
    const { events, emit } = collect();
    await createAgentRunner({ client, tools: [] }).run({ message: 'q' }, emit);

    const toolEvents = events.filter((e) => e.event === 'tool');
    expect(toolEvents).toEqual([{ event: 'tool', data: { name: 'search_trials' } }]);
    expect(JSON.stringify(events)).not.toContain('a private question');
  });

  it('accumulates usage across every iteration', async () => {
    const { client } = fakeClient([
      { toolUses: [{ name: 'search_trials', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
      { text: 'done', usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 900 } },
    ]);
    const out = await createAgentRunner({ client, tools: [] }).run({ message: 'q' }, collect().emit);
    expect(out.iterations).toBe(2);
    expect(out.usage).toEqual({ input: 30, output: 12, cacheRead: 900, cacheCreation: 0 });
    expect(out.toolCalls).toEqual(['search_trials']);
  });

  it('reports the stop reason it finished on', async () => {
    const { client } = fakeClient([{ text: 'cut off', stop_reason: 'max_tokens' }]);
    const out = await createAgentRunner({ client, tools: [] }).run({ message: 'q' }, collect().emit);
    expect(out.stopReason).toBe('max_tokens');
  });

  // We ship no server tools so this should not happen, but the runner does not
  // auto-resume a pause and an unhandled one ends the loop looking finished.
  it('resumes a paused turn instead of accepting it as the answer', async () => {
    const { client, captured } = fakeClient([
      { text: 'partial', stop_reason: 'pause_turn' },
      { text: 'rest' },
    ]);
    await createAgentRunner({ client, tools: [] }).run({ message: 'q' }, collect().emit);
    // The paused assistant turn is pushed back so the loop continues, rather
    // than the partial answer being returned as if it were finished.
    expect(captured.pushed).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    ]);
  });
});

describe('the turn cannot run forever', () => {
  it('stops at the wall clock and says it was cut short', async () => {
    const client = {
      beta: {
        messages: {
          toolRunner(_p: unknown, options?: { signal?: AbortSignal }) {
            return {
              pushMessages() {},
              async *[Symbol.asyncIterator]() {
                await new Promise((resolve, reject) => {
                  const t = setTimeout(resolve, 5_000);
                  options?.signal?.addEventListener('abort', () => {
                    clearTimeout(t);
                    reject(new Error('aborted'));
                  });
                });
                yield undefined as never;
              },
            };
          },
        },
      },
    } as unknown as Anthropic;

    const out = await createAgentRunner({ client, tools: [], wallClockMs: 20 }).run({ message: 'q' }, collect().emit);
    expect(out.timedOut).toBe(true);
    expect(describeStop(out.stopReason, out.timedOut)).toMatch(/time limit/);
  });

  // An abandoned tab must stop costing money immediately, not at the wall clock.
  it('stops when the client disconnects, and does not call it a timeout', async () => {
    const gone = new AbortController();
    const client = {
      beta: {
        messages: {
          toolRunner(_p: unknown, options?: { signal?: AbortSignal }) {
            return {
              pushMessages() {},
              async *[Symbol.asyncIterator]() {
                await new Promise((_resolve, reject) => {
                  const t = setTimeout(() => gone.abort(), 10);
                  options?.signal?.addEventListener('abort', () => {
                    clearTimeout(t);
                    reject(new Error('aborted'));
                  });
                });
                yield undefined as never;
              },
            };
          },
        },
      },
    } as unknown as Anthropic;

    const out = await createAgentRunner({ client, tools: [], wallClockMs: 60_000 }).run(
      { message: 'q' },
      collect().emit,
      gone.signal,
    );
    expect(out.timedOut).toBe(false);
  });

  it('lets a real API failure surface rather than reporting an empty answer', async () => {
    const client = {
      beta: {
        messages: {
          toolRunner() {
            return {
              pushMessages() {},
              // eslint-disable-next-line require-yield
              async *[Symbol.asyncIterator]() {
                throw new Error('overloaded_error');
              },
            };
          },
        },
      },
    } as unknown as Anthropic;

    await expect(createAgentRunner({ client, tools: [] }).run({ message: 'q' }, collect().emit)).rejects.toThrow(
      'overloaded_error',
    );
  });
});

describe('describeStop', () => {
  it.each([
    ['end_turn', null],
    ['stop_sequence', null],
    [null, null],
  ])('treats %s as a clean finish', (reason, expected) => {
    expect(describeStop(reason as string | null, false)).toBe(expected);
  });

  it.each(['max_tokens', 'refusal', 'model_context_window_exceeded', 'pause_turn', 'something_new'])(
    'explains %s to the user rather than passing it off as complete',
    (reason) => {
      expect(describeStop(reason, false)).toEqual(expect.any(String));
    },
  );

  it('reports a timeout as a timeout whatever the stop reason says', () => {
    expect(describeStop('end_turn', true)).toMatch(/time limit/);
  });
});
