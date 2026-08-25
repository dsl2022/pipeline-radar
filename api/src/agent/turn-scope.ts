import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatContext } from '@pipeline-radar/shared/chat';
import type { Emit } from './runner';

// Per-turn state the copilot tools need: the app context the client sent, and
// the SSE emitter for events that must reach the BROWSER without transiting
// the model (set_view commands, and the brief token — see tools.ts on why the
// token must never enter model context).
//
// AsyncLocalStorage rather than a module-level holder because two turns can be
// in flight on one process (desired_count = 2 is about tasks, but a single
// task serves concurrent requests), and a shared mutable slot would hand one
// user's watchlist to another user's turn.

export interface TurnScope {
  context?: ChatContext;
  emit: Emit;
  /**
   * Every NCT ID a tool result has surfaced this turn (plus what the history
   * and context already contained). The citation checker holds the reply to
   * this set - an ID outside it is flagged as unverified.
   */
  knownNctIds?: Set<string>;
}

const storage = new AsyncLocalStorage<TurnScope>();

export function runInTurnScope<T>(scope: TurnScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

export function currentTurn(): TurnScope | undefined {
  return storage.getStore();
}
