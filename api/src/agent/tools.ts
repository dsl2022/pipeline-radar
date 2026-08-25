import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import * as z from 'zod/v4';
import { buildDrugLandscape, type DrugRow } from '@pipeline-radar/shared/drugs/cluster';
import { badgeDrugs, fetchTopReactions, type FdaBadge } from '@pipeline-radar/shared/drugs/openfda';
import { canon } from '@pipeline-radar/shared/drugs/canon';
import {
  PHASE_LABELS,
  filterTrials,
  highestPhase,
  sortTrials,
  topSponsors,
  trialsByPhase,
} from '@pipeline-radar/shared/summarize';
import { buildMarkdownReport, reportFilenameFor, type ReportMeta } from '@pipeline-radar/shared/report';
import type { Trial } from '@pipeline-radar/shared/types';
import type { TrialData } from './data';
import type { Pubmed } from './pubmed';
import { signBriefToken } from './brief';
import { extractNctIds } from './citations';
import { currentTurn } from './turn-scope';

// The agent's entire reach. Four tools, all read-only, all wrapping logic that
// already has tests behind it (MILESTONE-6-PLAN.md 6.2).
//
// Nothing here writes, and nothing here takes a URL, a path, a query fragment
// or anything else the model could aim somewhere unintended. The only free
// text that crosses into a request is a disease or drug name, and it goes
// through URLSearchParams. That is what keeps most of the OWASP agentic top 10
// inapplicable by construction rather than by mitigation.

/**
 * Ceiling on one tool result, in characters.
 *
 * A 500-trial page serialises to roughly 200kB. Handing that back would blow
 * the turn's token budget in a single call and push the actual question out of
 * the model's attention. Tools return a shaped, capped view and say so when
 * they cut - a silent truncation would read as "there are only 20 trials".
 */
export const RESULT_BUDGET_CHARS = 24_000;

const STATUSES = [
  'RECRUITING',
  'ACTIVE_NOT_RECRUITING',
  'NOT_YET_RECRUITING',
  'ENROLLING_BY_INVITATION',
] as const;

const PHASES = ['PHASE4', 'PHASE3', 'PHASE2', 'PHASE1', 'EARLY_PHASE1', 'NA'] as const;

/** Serialise, then shrink by dropping rows until it fits. Never a mid-JSON cut. */
export function fitToBudget<T>(
  payload: { rows: T[] } & Record<string, unknown>,
  budget = RESULT_BUDGET_CHARS,
): string {
  const rows = [...payload.rows];
  let dropped = 0;
  for (;;) {
    const candidate = { ...payload, rows, ...(dropped > 0 ? { omitted_rows: dropped } : {}) };
    const text = JSON.stringify(candidate);
    if (text.length <= budget || rows.length === 0) return text;
    // Halve aggressively at first so a huge payload converges in a few passes.
    const cut = Math.max(1, Math.ceil(rows.length / 8));
    rows.splice(-cut, cut);
    dropped += cut;
  }
}

function trialRow(t: Trial) {
  return {
    nct_id: t.nctId,
    title: t.title,
    status: t.status,
    phase: PHASE_LABELS[highestPhase(t.phases)],
    enrollment: t.enrollment,
    sponsor: t.sponsor,
    interventions: t.interventions.filter((i) => i.type === 'DRUG' || i.type === 'BIOLOGICAL').map((i) => i.name),
  };
}

function drugRowOut(r: DrugRow) {
  return {
    drug: r.displayName,
    trial_count: r.trialCount,
    highest_phase: r.phaseLabel,
    lead_sponsor: r.sponsors[0] ?? null,
    also_known_as: r.aliases.slice(0, 4),
    example_nct_ids: r.nctIds.slice(0, 3),
  };
}

/** Every result carries the provenance of its numbers, so the model can cite it. */
function scope(set: { total: number; sampled: boolean; trials: Trial[] }) {
  return {
    source: 'ClinicalTrials.gov v2, active studies only',
    matched_in_registry: set.total,
    analysed: set.trials.length,
    ...(set.sampled
      ? { sampling_note: `Figures are computed over the ${set.trials.length} trials fetched, not all ${set.total}.` }
      : {}),
  };
}

/**
 * Keywords a strict tool schema may not carry.
 *
 * The constraints stay on the Zod schema and are still enforced - betaZodTool
 * validates every call through it before run() sees the input. They just
 * cannot travel to the API: a strict schema containing them is rejected
 * outright with "For 'integer' type, properties maximum, minimum are not
 * supported". The SDK strips these for structured OUTPUT schemas
 * (transformJSONSchema) but betaZodTool does not run that pass over tool
 * inputs, so it happens here.
 *
 * The list covers every unsupported constraint rather than the one the API
 * happened to name first - the error reports a single offending property, not
 * all of them, so fixing only what it mentions just moves the failure.
 */
const UNSUPPORTED_IN_STRICT = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const;

export function stripUnsupported(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) stripUnsupported(child);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;
  for (const key of UNSUPPORTED_IN_STRICT) delete obj[key];
  for (const value of Object.values(obj)) stripUnsupported(value);
}

/**
 * Server-side schema enforcement on top of Zod's client-side validation.
 *
 * `strict` stops a malformed call from being generated at all, rather than
 * catching it after the fact; `additionalProperties: false` is required for
 * every object in a strict schema, and zod's default object schema does not
 * emit it. BetaRunnableTool is a union spanning the built-in bash/computer
 * tools, which carry no input_schema - betaZodTool only ever produces the
 * custom variant, so narrowing to it here is safe.
 */
function harden(tool: BetaRunnableTool): BetaRunnableTool {
  const custom = tool as unknown as BetaTool;
  custom.strict = true;
  stripUnsupported(custom.input_schema);
  (custom.input_schema as { additionalProperties?: boolean }).additionalProperties = false;
  return tool;
}

/**
 * Every NCT ID a tool result carries is recorded against the turn, and that
 * record is what the citation checker holds the final reply to. Capturing at
 * the tool boundary rather than per-tool means a future tool cannot forget to
 * participate - if its result mentions a trial, the trial is vouched for.
 */
function captureCitations(tool: BetaRunnableTool): BetaRunnableTool {
  const run = tool.run.bind(tool) as (input: never) => Promise<unknown>;
  (tool as { run: (input: never) => Promise<unknown> }).run = async (input: never) => {
    const out = await run(input);
    const known = currentTurn()?.knownNctIds;
    if (known && typeof out === 'string') {
      for (const id of extractNctIds(out)) known.add(id);
    }
    return out;
  };
  return tool;
}

/** Optional copilot-layer dependencies; absent in older call sites and some tests. */
export interface ToolExtras {
  pubmed?: Pubmed;
  /** Signs brief commit tokens. Without it prepare_brief reports itself unavailable. */
  briefSecret?: string;
  now?: () => number;
}

export function createTools(data: TrialData, extras: ToolExtras = {}): BetaRunnableTool[] {
  const now = extras.now ?? Date.now;
  const search = betaZodTool({
    name: 'search_trials',
    description:
      'List active clinical trials for a disease or condition, optionally narrowed by phase, status or sponsor. ' +
      'Returns NCT IDs, titles, phases, enrolment and sponsors. Use this when the question is about specific ' +
      'trials. Every NCT ID you cite must come from a result of this tool.',
    inputSchema: z.object({
      condition: z.string().min(2).max(120).describe('Disease or condition, e.g. "non-small cell lung cancer"'),
      phases: z.array(z.enum(PHASES)).optional().describe('Highest-phase buckets to keep. Omit for all phases.'),
      statuses: z.array(z.enum(STATUSES)).optional().describe('Recruitment statuses to keep. Omit for all.'),
      sponsor_contains: z.string().max(80).optional().describe('Case-insensitive substring match on lead sponsor.'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum trials to return. Default 20.'),
    }),
    run: async (input) => {
      const set = await data.search(input.condition);
      let rows = filterTrials(set.trials, { phases: input.phases, statuses: input.statuses });
      if (input.sponsor_contains) {
        const needle = input.sponsor_contains.toLowerCase();
        rows = rows.filter((t) => t.sponsor.toLowerCase().includes(needle));
      }
      // Deterministic order regardless of what the registry returned, so the
      // same question twice does not produce two differently-ordered answers.
      const sorted = sortTrials(rows, 'phase', 'desc');
      const limit = input.limit ?? 20;
      return fitToBudget({
        ...scope(set),
        matched_after_filters: rows.length,
        rows: sorted.slice(0, limit).map(trialRow),
      });
    },
  });

  const summarize = betaZodTool({
    name: 'summarize_trials',
    description:
      'Aggregate counts for a disease: how many active trials sit in each phase, and which sponsors run the most. ' +
      'Use this for "how many" and "who is most active" questions instead of counting trials yourself.',
    inputSchema: z.object({
      condition: z.string().min(2).max(120).describe('Disease or condition'),
      top_sponsors: z.number().int().min(1).max(20).optional().describe('How many sponsors to return. Default 8.'),
    }),
    run: async (input) => {
      const set = await data.search(input.condition);
      return fitToBudget({
        ...scope(set),
        by_phase: trialsByPhase(set.trials),
        rows: topSponsors(set.trials, input.top_sponsors ?? 8).map((s) => ({
          sponsor: s.name,
          trial_count: s.count,
        })),
      });
    },
  });

  const landscape = betaZodTool({
    name: 'build_drug_landscape',
    description:
      'Roll active trials for a disease up into one row per drug, with trial counts, highest phase reached and ' +
      'lead sponsor. Use this for "which drugs" and competitive-landscape questions. Drug names are clustered ' +
      'from intervention names and aliases; the clustering is approximate and the excluded count reports what ' +
      'did not look like a drug.',
    inputSchema: z.object({
      condition: z.string().min(2).max(120).describe('Disease or condition'),
      limit: z.number().int().min(1).max(40).optional().describe('Maximum drug rows. Default 15.'),
    }),
    run: async (input) => {
      const set = await data.search(input.condition);
      const built = buildDrugLandscape(set.trials);
      return fitToBudget({
        ...scope(set),
        distinct_drugs: built.drugs.length,
        non_drug_interventions_excluded: built.excludedCount,
        rows: built.drugs.slice(0, input.limit ?? 15).map(drugRowOut),
      });
    },
  });

  const fda = betaZodTool({
    name: 'check_fda_approval',
    description:
      'Look one drug up in the openFDA drugs@FDA register. Returns approved (with the earliest approval year, ' +
      'sponsor and application number) or investigational (no approval record found). Use this before ever ' +
      'describing a drug as approved. An error or an unknown result is not the same as investigational.',
    inputSchema: z.object({
      drug: z.string().min(2).max(80).describe('Generic or brand drug name, e.g. "pembrolizumab" or "Keytruda"'),
    }),
    run: async (input) => {
      const name = canon(input.drug);
      if (!name) return JSON.stringify({ drug: input.drug, status: 'unknown', reason: 'unrecognised drug name' });

      // badgeDrugs is the measured implementation (truncation guard, exact
      // name equality, the ANDA caveat). A single-row lookup reuses it rather
      // than re-deriving rules that took a research pass to get right.
      const row: DrugRow = {
        key: 'lookup',
        displayName: input.drug,
        trialCount: 0,
        maxPhase: 0,
        phaseLabel: '',
        sponsors: [],
        aliases: [input.drug],
        nctIds: [],
      };

      let verdict: { status: string; [k: string]: unknown } | undefined;
      await badgeDrugs([row], (_key, badge) => {
        verdict = badge
          ? {
              status: 'approved',
              approval_year: badge.approvalYear ?? null,
              // The ANDA caveat: any generic in the matched set means the
              // year is the earliest RECORD, not the originator's approval.
              approval_year_is_approximate: badge.approvalApprox ?? false,
              sponsor: badge.sponsor ?? null,
              application_number: badge.appNumber ?? null,
              application_count: badge.appCount ?? null,
              pharm_class: badge.pharmClass ?? null,
              brands: badge.brands ?? [],
              matched_via: badge.via,
            }
          : { status: 'investigational', meaning: 'no drugs@FDA approval record matched this name' };
      });

      // No callback at all means a transport error, and unknown must never be
      // reported as investigational - that would turn a network blip into a
      // false claim about a drug's regulatory status.
      return JSON.stringify({
        drug: input.drug,
        source: 'openFDA drugs@FDA',
        ...(verdict ?? { status: 'unknown', reason: 'openFDA lookup did not complete' }),
      });
    },
  });

  const detail = betaZodTool({
    name: 'get_trial_detail',
    description:
      'Fetch one trial\'s full protocol record by NCT ID: summary, design, arms and interventions, dates and ' +
      'sponsor. Only call this for an NCT ID that appeared in an earlier tool result this conversation - list ' +
      'tools return the IDs, this returns the depth.',
    inputSchema: z.object({
      nct_id: z.string().regex(/^NCT\d{8}$/).describe('The trial\'s registry ID, e.g. "NCT01234567"'),
    }),
    run: async (input) => {
      const raw = (await data.detail(input.nct_id)) as {
        protocolSection?: {
          identificationModule?: { briefTitle?: string; officialTitle?: string };
          statusModule?: { overallStatus?: string; startDateStruct?: { date?: string }; primaryCompletionDateStruct?: { date?: string } };
          descriptionModule?: { briefSummary?: string };
          designModule?: { phases?: string[]; enrollmentInfo?: { count?: number }; studyType?: string; designInfo?: { allocation?: string; maskingInfo?: { masking?: string } } };
          armsInterventionsModule?: { interventions?: { type?: string; name?: string; description?: string }[] };
          sponsorCollaboratorsModule?: { leadSponsor?: { name?: string }; collaborators?: { name?: string }[] };
          conditionsModule?: { conditions?: string[] };
          contactsLocationsModule?: { locations?: unknown[] };
        };
      };
      const p = raw.protocolSection ?? {};
      return fitToBudget({
        source: `ClinicalTrials.gov v2, study record ${input.nct_id}`,
        nct_id: input.nct_id,
        title: p.identificationModule?.briefTitle ?? p.identificationModule?.officialTitle ?? null,
        status: p.statusModule?.overallStatus ?? null,
        phases: p.designModule?.phases ?? [],
        study_type: p.designModule?.studyType ?? null,
        allocation: p.designModule?.designInfo?.allocation ?? null,
        masking: p.designModule?.designInfo?.maskingInfo?.masking ?? null,
        enrollment: p.designModule?.enrollmentInfo?.count ?? null,
        sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name ?? null,
        collaborators: (p.sponsorCollaboratorsModule?.collaborators ?? []).map((c) => c.name).slice(0, 8),
        conditions: (p.conditionsModule?.conditions ?? []).slice(0, 10),
        start_date: p.statusModule?.startDateStruct?.date ?? null,
        primary_completion_date: p.statusModule?.primaryCompletionDateStruct?.date ?? null,
        site_count: p.contactsLocationsModule?.locations?.length ?? null,
        brief_summary: (p.descriptionModule?.briefSummary ?? '').slice(0, 1500),
        rows: (p.armsInterventionsModule?.interventions ?? []).map((i) => ({
          type: i.type,
          name: i.name,
          description: (i.description ?? '').slice(0, 300),
        })),
      });
    },
  });

  const adverse = betaZodTool({
    name: 'get_adverse_events',
    description:
      'Top adverse-event reactions reported to FAERS for one drug, with report counts. These are spontaneous ' +
      'reports, not incidence rates - never present them as how often a side effect happens, only as what is ' +
      'most reported.',
    inputSchema: z.object({
      drug: z.string().min(2).max(80).describe('Generic drug name, e.g. "pembrolizumab"'),
    }),
    run: async (input) => {
      const name = canon(input.drug);
      if (!name) return JSON.stringify({ drug: input.drug, status: 'unknown', reason: 'unrecognised drug name' });
      const reactions = await fetchTopReactions(name);
      return JSON.stringify({
        drug: input.drug,
        source: 'openFDA FAERS spontaneous reports',
        caveat: 'Report counts, not incidence. Reporting is voluntary and skewed by drug age and publicity.',
        rows: reactions.slice(0, 10).map((r) => ({ reaction: r.term, reports: r.count })),
      });
    },
  });

  const pubmed = betaZodTool({
    name: 'pubmed_count',
    description:
      'How many PubMed articles match a query. Use it as a research-activity signal for a drug, target or ' +
      'combination - a count, not a literature review.',
    inputSchema: z.object({
      term: z.string().min(2).max(200).describe('PubMed query, e.g. "pembrolizumab AND melanoma"'),
    }),
    run: async (input) => {
      if (!extras.pubmed) return JSON.stringify({ status: 'unavailable', reason: 'PubMed lookups are not configured' });
      const count = await extras.pubmed.count(input.term);
      return JSON.stringify({ term: input.term, source: 'PubMed esearch', article_count: count });
    },
  });

  const diffWatch = betaZodTool({
    name: 'diff_watchlist',
    description:
      'The change report between the user\'s saved watchlist snapshot and the current landscape for the disease ' +
      'they are viewing: drugs added or removed, phase changes, FDA status flips, new trials. The diff is ' +
      'computed by the app, deterministically - your job is to narrate what matters, not to recompute it. ' +
      'Call it when the user asks what changed or what is new.',
    inputSchema: z.object({}),
    run: async () => {
      const diff = currentTurn()?.context?.watchlistDiff;
      if (diff === undefined) {
        return JSON.stringify({
          status: 'no_watchlist',
          note: 'The user has no saved watchlist for the disease currently open, or none is open. They can save one from the Drugs view.',
        });
      }
      return JSON.stringify({
        status: 'ok',
        source: 'app watchlist diff, computed from the user\'s saved snapshot',
        diff,
      });
    },
  });

  const setView = betaZodTool({
    name: 'set_view',
    description:
      'Steer the app the user is looking at: set the disease being searched, switch between the Trials and ' +
      'Drugs views, or apply phase and status filters. The change is applied in the user\'s browser. Use it ' +
      'when the user asks to see, show, filter or switch something, then confirm briefly what you changed. ' +
      'Omitted fields are left as they are; pass an empty array to clear a filter.',
    inputSchema: z.object({
      condition: z.string().min(2).max(120).optional().describe('Disease to search, replacing the current one'),
      view: z.enum(['trials', 'drugs']).optional().describe('Which table to show'),
      phases: z.array(z.enum(PHASES)).optional().describe('Phase filter to apply. Empty array clears it.'),
      statuses: z.array(z.enum(STATUSES)).optional().describe('Status filter to apply. Empty array clears it.'),
    }),
    run: async (input) => {
      const command = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      if (Object.keys(command).length === 0) {
        return JSON.stringify({ status: 'noop', reason: 'no fields given - nothing to change' });
      }
      const turn = currentTurn();
      if (!turn) return JSON.stringify({ status: 'error', reason: 'no browser is attached to this turn' });
      // Straight to the browser; the model gets back what was applied so it
      // can describe the change without guessing.
      turn.emit('view', command);
      return JSON.stringify({ status: 'applied', applied: command });
    },
  });

  const brief = betaZodTool({
    name: 'prepare_brief',
    description:
      'Render the consultant brief for a disease - the same deterministic drug-landscape report the Export ' +
      'button produces - and show the user a preview card with a download button. Nothing is delivered until ' +
      'the USER clicks: you can prepare, only they can commit. After calling it, summarise the highlights in a ' +
      'sentence or two; never paste the brief\'s content into the chat.',
    inputSchema: z.object({
      condition: z.string().min(2).max(120).describe('Disease or condition the brief covers'),
      limit: z.number().int().min(5).max(40).optional().describe('Maximum drug rows in the brief. Default 20.'),
    }),
    run: async (input) => {
      if (!extras.briefSecret) {
        return JSON.stringify({ status: 'unavailable', reason: 'brief generation is not configured' });
      }
      const turn = currentTurn();
      if (!turn) return JSON.stringify({ status: 'error', reason: 'no browser is attached to this turn' });

      const set = await data.search(input.condition);
      const built = buildDrugLandscape(set.trials);
      const top = built.drugs.slice(0, input.limit ?? 20);

      // FDA badges for the rows the brief will show. badgeDrugs batches, so
      // this is a couple of openFDA calls, all behind the shared 24h cache.
      const fdaMap = new Map<string, FdaBadge | null>();
      await badgeDrugs(top, (key, badge) => fdaMap.set(key, badge));

      const meta: ReportMeta = {
        disease: input.condition,
        generatedAt: new Date(now()),
        totalTrials: set.total,
        fetchedTrials: set.trials.length,
        filteredTrials: set.trials.length,
        filters: { phases: [], statuses: [] },
        phaseBuckets: trialsByPhase(set.trials),
      };
      const markdown = buildMarkdownReport({ ...built, drugs: top }, fdaMap, new Map(), meta);
      const filename = reportFilenameFor(meta, 'md');

      // The token goes to the BROWSER only. It must never appear in what this
      // function returns: a token in model context is a confirmation the model
      // could replay, which would collapse the two-phase commit into one.
      turn.emit('brief', { filename, markdown, token: signBriefToken(markdown, extras.briefSecret, now()) });

      return JSON.stringify({
        status: 'preview_shown',
        disease: input.condition,
        distinct_drugs: built.drugs.length,
        rows_in_brief: top.length,
        ...(set.sampled ? { sampling_note: `Built from the ${set.trials.length} trials fetched of ${set.total}.` } : {}),
        note: 'The user sees a preview card with a download button. Delivery is their click, not yours.',
      });
    },
  });

  // Stable order: the tool block is part of the cached prompt prefix, and
  // reordering it on every process start would miss the cache every time.
  // Widened to the array's element type before mapping: the tools have
  // different input schemas, and harden is indifferent to all of them.
  const tools: BetaRunnableTool[] = [
    search,
    summarize,
    landscape,
    fda,
    detail,
    adverse,
    pubmed,
    diffWatch,
    setView,
    brief,
  ];
  return tools.map(harden).map(captureCitations);
}
