import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import * as z from 'zod/v4';
import { buildDrugLandscape, type DrugRow } from '@pipeline-radar/shared/drugs/cluster';
import { badgeDrugs } from '@pipeline-radar/shared/drugs/openfda';
import { canon } from '@pipeline-radar/shared/drugs/canon';
import {
  PHASE_LABELS,
  filterTrials,
  highestPhase,
  sortTrials,
  topSponsors,
  trialsByPhase,
} from '@pipeline-radar/shared/summarize';
import type { Trial } from '@pipeline-radar/shared/types';
import type { TrialData } from './data';

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

export function createTools(data: TrialData): BetaRunnableTool[] {
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

  // Stable order: the tool block is part of the cached prompt prefix, and
  // reordering it on every process start would miss the cache every time.
  // Widened to the array's element type before mapping: the four tools have
  // four different input schemas, and harden is indifferent to all of them.
  const tools: BetaRunnableTool[] = [search, summarize, landscape, fda];
  return tools.map(harden);
}
