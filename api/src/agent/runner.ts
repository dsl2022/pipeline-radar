import type Anthropic from '@anthropic-ai/sdk';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { ChatTurn } from '@pipeline-radar/shared/chat';
import { systemBlocks } from './prompt';

// The turn. Everything that bounds one question's cost and wall clock is here.
//
// The bounds ship in the same file as the first model call, not in a follow-up
// PR, because an unbounded agentic loop is the failure mode that empties a
// budget overnight. None of them is the guaranteed control - the Anthropic
// workspace spend cap is, because it holds even when this code is wrong.

export const MODEL = 'claude-opus-5';

/** Hard per-response ceiling. Not surfaced to the model. */
export const MAX_TOKENS = 64_000;

/**
 * Advisory cumulative budget for the whole loop, which the model sees as a
 * countdown and paces itself against. Below max_tokens on purpose: it should
 * bind first, and wrapping up early is the behaviour we want. (API minimum is
 * 20k.)
 */
export const TASK_BUDGET_TOKENS = 40_000;

/** Four tools, and no question needing more than two passes over them. */
export const MAX_ITERATIONS = 8;

/**
 * Wall clock for the whole turn. Must stay below the ALB idle timeout (240s)
 * and comfortably above the SSE heartbeat, so a slow turn ends as our error
 * rather than as a connection the proxy drops out from under us.
 */
export const WALL_CLOCK_MS = 120_000;

const TASK_BUDGET_BETA = 'task-budgets-2026-03-13';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type Emit = (event: string, data: unknown) => void;

/**
 * One turn's input: the question, plus the session's prior exchanges. History
 * is validated at the gate (shared/chat.ts) and replayed verbatim — the model
 * sees the conversation the user saw, nothing reconstructed or summarized.
 */
export interface TurnInput {
  message: string;
  history?: ChatTurn[];
}

export interface RunOutcome {
  stopReason: string | null;
  iterations: number;
  toolCalls: string[];
  timedOut: boolean;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
}

export interface RunnerConfig {
  client: Anthropic;
  tools: BetaRunnableTool[];
  model?: string;
  maxTokens?: number;
  taskBudgetTokens?: number;
  maxIterations?: number;
  wallClockMs?: number;
}

/**
 * Why a turn ended, in words a user can act on. `end_turn` is the only clean
 * finish; the rest are reported rather than hidden, because a silently
 * truncated answer is indistinguishable from a complete one on screen.
 */
export function describeStop(stopReason: string | null, timedOut: boolean): string | null {
  if (timedOut) return 'The answer was cut short at the time limit.';
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case null:
      return null;
    case 'max_tokens':
      return 'The answer was cut short at the length limit.';
    case 'refusal':
      return 'The assistant declined to continue with this request.';
    case 'model_context_window_exceeded':
      return 'This conversation grew too long to continue.';
    case 'pause_turn':
      return 'The answer was interrupted before it finished.';
    default:
      return 'The answer ended unexpectedly.';
  }
}

export function createAgentRunner(config: RunnerConfig) {
  const model = config.model ?? MODEL;
  const maxTokens = config.maxTokens ?? MAX_TOKENS;
  const taskBudget = config.taskBudgetTokens ?? TASK_BUDGET_TOKENS;
  const maxIterations = config.maxIterations ?? MAX_ITERATIONS;
  const wallClockMs = config.wallClockMs ?? WALL_CLOCK_MS;

  return {
    async run(input: TurnInput, emit: Emit, clientGone?: AbortSignal): Promise<RunOutcome> {
      const controller = new AbortController();
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('turn wall clock exceeded'));
      }, wallClockMs);
      // A user who closes the tab should stop costing money immediately.
      const onGone = () => controller.abort(new Error('client disconnected'));
      clientGone?.addEventListener('abort', onGone, { once: true });

      const outcome: RunOutcome = {
        stopReason: null,
        iterations: 0,
        toolCalls: [],
        timedOut: false,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      };

      try {
        const runner = config.client.beta.messages.toolRunner(
          {
            model,
            max_tokens: maxTokens,
            // Array form with cache_control: the prompt and the tool block are
            // a frozen prefix, so every turn after the first reads them from
            // cache instead of paying full input price.
            system: systemBlocks(),
            // History precedes the question. It varies per turn, but it sits
            // after the cached prefix (tools -> system), so replaying it does
            // not disturb the cache the frozen prefix depends on.
            messages: [
              ...(input.history ?? []).map((h) => ({ role: h.role, content: h.text })),
              { role: 'user', content: input.message },
            ],
            tools: config.tools,
            max_iterations: maxIterations,
            // The default is "omitted", which streams empty thinking blocks -
            // on screen that is an unexplained pause before any text appears.
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { task_budget: { type: 'tokens', total: taskBudget } },
            // A policy decline retries on a fallback model inside the same
            // call rather than returning nothing.
            fallbacks: 'default',
            betas: [TASK_BUDGET_BETA, FALLBACK_BETA],
            stream: true,
          },
          { signal: controller.signal },
        );

        for await (const stream of runner) {
          outcome.iterations += 1;
          stream.on('text', (delta) => emit('delta', { text: delta }));
          stream.on('thinking', (delta) => emit('thinking', { text: delta }));

          const msg = await stream.finalMessage();

          outcome.usage.input += msg.usage.input_tokens ?? 0;
          outcome.usage.output += msg.usage.output_tokens ?? 0;
          outcome.usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
          outcome.usage.cacheCreation += msg.usage.cache_creation_input_tokens ?? 0;
          outcome.stopReason = msg.stop_reason ?? null;

          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              outcome.toolCalls.push(block.name);
              // The name only. Tool inputs echo the user's question back, and
              // this event is what the UI renders and what gets logged.
              emit('tool', { name: block.name });
            }
          }

          // We ship no server tools, so pause_turn should not occur - but the
          // runner does not auto-resume it, and an unhandled pause ends the
          // loop looking exactly like a finished answer.
          if (msg.stop_reason === 'pause_turn') {
            runner.pushMessages({ role: 'assistant', content: msg.content });
          }
        }

        return outcome;
      } catch (err) {
        if (controller.signal.aborted) {
          outcome.timedOut = timedOut;
          return outcome;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        clientGone?.removeEventListener('abort', onGone);
      }
    },
  };
}

export type AgentRunner = ReturnType<typeof createAgentRunner>;
