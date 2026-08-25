import { MAX_CONTEXT_CHARS, type ChatContext } from '@pipeline-radar/shared/chat';
import type { LandscapeDiff } from '@pipeline-radar/shared/watchlist';

// Building the context object a chat request carries (shared/chat.ts bounds).
//
// The watchlist diff is the one piece that can outgrow the wire budget - a
// churned landscape carries hundreds of DrugSnaps, each with its NCT list.
// The model only narrates the diff, so it gets a compact view: names and
// phases, capped lists, counts for whatever had to be dropped. The full diff
// stays in the UI, where it is already rendered.

const LIST_CAP = 15;

function snapOut(s: { displayName: string; phaseLabel: string }) {
  return { drug: s.displayName, phase: s.phaseLabel };
}

function capped<T, O>(rows: T[], map: (row: T) => O): { rows: O[]; omitted?: number } {
  const out = rows.slice(0, LIST_CAP).map(map);
  return rows.length > LIST_CAP ? { rows: out, omitted: rows.length - LIST_CAP } : { rows: out };
}

export function compactWatchlistDiff(diff: LandscapeDiff): unknown {
  return {
    has_changes: diff.hasChanges,
    added: capped(diff.added, snapOut),
    removed: capped(diff.removed, snapOut),
    renamed: capped(diff.renamed, (r) => ({ from: r.prev.displayName, to: r.cur.displayName })),
    phase_advanced: capped(diff.phaseAdvanced, (p) => ({ drug: p.displayName, from: p.from, to: p.to })),
    phase_regressed: capped(diff.phaseRegressed, (p) => ({ drug: p.displayName, from: p.from, to: p.to })),
    newly_fda_approved: capped(diff.fdaFlipped, (f) => ({ drug: f.displayName })),
    fda_record_lost: capped(diff.fdaReversed, (f) => ({ drug: f.displayName })),
    new_trials: capped(diff.newTrials, (n) => ({ drug: n.displayName, nct_ids: n.nctIds.slice(0, 5) })),
    caveats: diff.caveats.slice(0, 6),
  };
}

export interface AppSnapshot {
  disease?: string;
  view: 'trials' | 'drugs';
  phases: string[];
  statuses: string[];
  watchlistDiff?: LandscapeDiff | null;
}

/** The request-ready context, guaranteed to fit the shared wire budget. */
export function buildChatContext(app: AppSnapshot): ChatContext | undefined {
  const out: ChatContext = {};
  if (app.disease) out.disease = app.disease;
  out.view = app.view;
  if (app.phases.length > 0) out.phases = app.phases;
  if (app.statuses.length > 0) out.statuses = app.statuses;

  if (app.watchlistDiff) {
    const compact = compactWatchlistDiff(app.watchlistDiff);
    // Belt over braces: the compaction should always fit, but a pathological
    // diff must degrade to "no diff attached", never to a rejected request.
    if (JSON.stringify(compact).length <= MAX_CONTEXT_CHARS - 1_000) {
      out.watchlistDiff = compact;
    }
  }
  return out;
}
