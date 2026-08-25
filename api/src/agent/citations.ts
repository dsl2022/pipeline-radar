import type { ChatContext, ChatTurn } from '@pipeline-radar/shared/chat';

// The citation check (MILESTONE-6-PLAN.md 6.4): enforced, not prompted.
//
// A hallucinated NCT ID is the highest-signal failure this product can have -
// a confident, wrong, citable-looking claim in decision-support tooling. The
// system prompt already forbids it; this is the layer that does not depend on
// the model listening. Every ID in the reply must have entered the
// conversation through a tool result, or it is flagged on screen as
// unverified and counted in the logs as an eval signal.
//
// What counts as "known" is deliberately wider than this turn's tool calls:
// prior turns' texts and the watchlist diff are replayed to the model as
// legitimate context, and re-citing an ID the user is already looking at is
// correct behaviour, not fabrication. That widening is client-influenced -
// a caller could seed history with invented IDs - but the blast radius is
// the caller's own screen losing a warning label it asked to lose. The check
// defends the honest user against the model, not the API against its caller.

const NCT_ID = /NCT\d{8}/g;

export function extractNctIds(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NCT_ID)) out.add(m[0]);
  return out;
}

/** IDs already legitimately in the model's context before any tool runs. */
export function seedKnownIds(history: ChatTurn[] | undefined, context: ChatContext | undefined): Set<string> {
  const known = new Set<string>();
  for (const turn of history ?? []) {
    for (const id of extractNctIds(turn.text)) known.add(id);
  }
  if (context?.watchlistDiff !== undefined) {
    for (const id of extractNctIds(JSON.stringify(context.watchlistDiff))) known.add(id);
  }
  return known;
}

export interface CitationCheck {
  /** Distinct NCT IDs the reply cited. */
  cited: number;
  /** The ones nothing in this session vouches for. */
  unverified: string[];
}

export function checkCitations(answer: string, known: ReadonlySet<string>): CitationCheck {
  const cited = extractNctIds(answer);
  const unverified = [...cited].filter((id) => !known.has(id));
  return { cited: cited.size, unverified };
}
