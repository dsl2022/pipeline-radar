// Applying a set_view command from the agent to the app's view state.
//
// Pure and strict on purpose: the command arrives over SSE from the server,
// but what lands in React state is decided here, and the eval criterion for
// the copilot (MILESTONE-6-PR-PLAN.md PR 9) is the RESULTING STATE OBJECT -
// an agent that says it filtered but did not must fail, and so must a
// malformed command that would wedge the UI.

export interface ViewState {
  disease: string;
  view: 'trials' | 'drugs';
  phases: string[];
  statuses: string[];
}

export interface AppliedView {
  state: ViewState;
  /** True when the disease changed: the caller must run a fresh search. */
  searchNeeded: boolean;
  /** True when anything at all changed. */
  changed: boolean;
}

const PHASES = new Set(['PHASE4', 'PHASE3', 'PHASE2', 'PHASE1', 'EARLY_PHASE1', 'NA']);
const STATUSES = new Set([
  'RECRUITING',
  'ACTIVE_NOT_RECRUITING',
  'NOT_YET_RECRUITING',
  'ENROLLING_BY_INVITATION',
]);

function keyList(value: unknown, allowed: Set<string>): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = value.filter((v): v is string => typeof v === 'string' && allowed.has(v));
  // A list of nothing but junk is a malformed command, not "clear the filter".
  return kept.length === value.length ? kept : undefined;
}

export function applyViewCommand(state: ViewState, command: unknown): AppliedView {
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    return { state, searchNeeded: false, changed: false };
  }
  const c = command as Record<string, unknown>;
  let next = state;
  let searchNeeded = false;

  if (typeof c.condition === 'string') {
    const condition = c.condition.trim();
    if (condition.length >= 2 && condition.length <= 120 && condition !== state.disease) {
      next = { ...next, disease: condition };
      searchNeeded = true;
    }
  }
  if (c.view === 'trials' || c.view === 'drugs') {
    if (c.view !== next.view) next = { ...next, view: c.view };
  }
  const phases = keyList(c.phases, PHASES);
  if (phases !== undefined) next = { ...next, phases };
  const statuses = keyList(c.statuses, STATUSES);
  if (statuses !== undefined) next = { ...next, statuses };

  return { state: next, searchNeeded, changed: next !== state };
}
