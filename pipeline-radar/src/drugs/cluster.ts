import type { Trial } from '../types';
import { PHASE_LABELS, phaseRank } from '../summarize';
import { canon, isCategoryTerm, isCombo, isResearchCode, nameKey, splitCombo } from './canon';

// Milestone 3 core: trial list → one-drug-one-row landscape. Pure, offline, testable.
// Design and every guard here are measured results — research/DATA-RESEARCH.md §2.
// Deliberately NOT transitive union-find: shared-alias unioning fused 174 distinct
// drugs into one cluster on real data (§2.1). Aliases VOTE for a single primary
// instead, and two guards (ambiguity drop, count guard) keep hub records from
// hijacking common drugs.

export interface DrugRow {
  key: string; // cluster key — internal, never display
  displayName: string;
  trialCount: number; // unique NCT ids
  maxPhase: number; // phaseRank scale from summarize.ts (NA/unknown = 0 … PHASE4 = 5)
  phaseLabel: string;
  sponsors: string[]; // by frequency desc
  aliases: string[]; // display-filtered: no category terms, no combos
  nctIds: string[];
}

export interface Landscape {
  drugs: DrugRow[];
  excludedCount: number; // intervention occurrences routed to the non-drug bucket
  excludedNames: string[]; // unique raw names, for the transparency line / debugging
  assignedCount: number; // occurrences that landed in ≥1 drug row
  mentionTotal: number; // all DRUG/BIOLOGICAL occurrences — conservation invariant:
  // assignedCount + excludedCount === mentionTotal, always.
}

const DRUG_TYPES = new Set(['DRUG', 'BIOLOGICAL']); // BIOLOGICAL is 12% of drug-like arms (§1.2)

interface Mention {
  rawName: string;
  otherNames: string[];
  trial: Trial;
}

interface Cluster {
  nctIds: Set<string>;
  sponsorCounts: Map<string, number>;
  maxPhase: number;
  aliasSet: Set<string>;
  // Votes for the human-facing name: canon form -> weight, plus a raw spelling to render.
  displayVotes: Map<string, number>;
  displayRaw: Map<string, string>;
}

function titleCase(canonForm: string): string {
  return canonForm.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function buildDrugLandscape(trials: Trial[]): Landscape {
  const mentions: Mention[] = [];
  for (const trial of trials) {
    for (const iv of trial.interventions) {
      if (!DRUG_TYPES.has(iv.type)) continue;
      mentions.push({ rawName: iv.name, otherNames: iv.otherNames, trial });
    }
  }

  // Pass 1 — alias votes. Only single-agent, non-category primaries may claim aliases;
  // combo/category aliases are skipped (they are the §2.1 over-merge bridges).
  const aliasVotes = new Map<string, Map<string, number>>();
  const primaryFreq = new Map<string, number>();
  for (const m of mentions) {
    const primaryCanon = canon(m.rawName);
    const primaryKey = nameKey(m.rawName);
    if (!primaryKey || isCombo(m.rawName) || isCategoryTerm(primaryCanon)) continue;
    primaryFreq.set(primaryKey, (primaryFreq.get(primaryKey) ?? 0) + 1);
    for (const other of m.otherNames) {
      const otherKey = nameKey(other);
      if (!otherKey || otherKey === primaryKey) continue;
      if (isCombo(other) || isCategoryTerm(canon(other))) continue;
      let votes = aliasVotes.get(otherKey);
      if (!votes) aliasVotes.set(otherKey, (votes = new Map()));
      votes.set(primaryKey, (votes.get(primaryKey) ?? 0) + 1);
    }
  }

  // Resolve alias -> primary with both measured guards (§2.2 step 3 / v3 experiment):
  // tie between claimants ⇒ drop; never remap a key that is itself an equally common primary.
  const aliasMap = new Map<string, string>();
  for (const [alias, votes] of aliasVotes) {
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1 && ranked[1][1] >= ranked[0][1]) continue; // ambiguity drop
    const winner = ranked[0][0];
    if ((primaryFreq.get(alias) ?? 0) >= (primaryFreq.get(winner) ?? 0)) continue; // count guard
    aliasMap.set(alias, winner);
  }

  function resolveKey(key: string): string {
    let cur = key;
    for (let hop = 0; hop < 3 && aliasMap.has(cur); hop++) cur = aliasMap.get(cur)!;
    return cur;
  }

  // Pass 2 — assign every mention to drug row(s) or the excluded bucket. Never nowhere.
  const clusters = new Map<string, Cluster>();
  const excludedNames = new Set<string>();
  let excludedCount = 0;
  let assignedCount = 0;

  function clusterFor(key: string): Cluster {
    let c = clusters.get(key);
    if (!c) {
      clusters.set(
        key,
        (c = {
          nctIds: new Set(),
          sponsorCounts: new Map(),
          maxPhase: 0,
          aliasSet: new Set(),
          displayVotes: new Map(),
          displayRaw: new Map(),
        }),
      );
    }
    return c;
  }

  for (const m of mentions) {
    const primaryCanon = canon(m.rawName);
    const combo = isCombo(m.rawName);
    let parts: string[];
    if (!primaryCanon) {
      parts = [];
    } else if (combo) {
      parts = splitCombo(m.rawName).filter((p) => !isCategoryTerm(p));
    } else if (isCategoryTerm(primaryCanon)) {
      parts = [];
    } else {
      parts = [primaryCanon];
    }

    // All-category combos ("Chemotherapy + radiotherapy") and pure noise land here.
    if (parts.length === 0) {
      excludedCount++;
      excludedNames.add(m.rawName);
      continue;
    }

    assignedCount++;
    for (const part of parts) {
      const key = resolveKey(part.replace(/ /g, ''));
      const c = clusterFor(key);
      c.nctIds.add(m.trial.nctId);
      c.sponsorCounts.set(m.trial.sponsor, (c.sponsorCounts.get(m.trial.sponsor) ?? 0) + 1);
      c.maxPhase = Math.max(c.maxPhase, phaseRank(m.trial.phases));
      // Display votes come from single-agent mentions only.
      if (!combo) {
        c.displayVotes.set(part, (c.displayVotes.get(part) ?? 0) + 1);
        if (!c.displayRaw.has(part)) c.displayRaw.set(part, m.rawName.trim());
      }
      // "Also known as" column: same skip rules as the vote pass — otherNames is
      // poisoned with category terms and combo partners (§1.3).
      for (const other of m.otherNames) {
        const oc = canon(other);
        if (!oc || isCombo(other) || isCategoryTerm(oc)) continue;
        c.aliasSet.add(other.replace(/[®™©]/g, '').trim());
      }
    }
  }

  const rankToLabel = new Map(Object.entries(PHASE_LABELS).map(([k, label]) => [phaseRank([k]), label]));

  const drugs: DrugRow[] = [...clusters.entries()].map(([key, c]) => {
    const topCanon = [...c.displayVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const rawSpelling = topCanon ? c.displayRaw.get(topCanon) : undefined;
    // Research codes keep their raw spelling (MK-3475, not Mk 3475).
    const displayName =
      rawSpelling && isResearchCode(rawSpelling)
        ? rawSpelling
        : titleCase(topCanon ?? key);
    const aliases = [...c.aliasSet].filter((a) => canon(a) !== topCanon);
    return {
      key,
      displayName,
      trialCount: c.nctIds.size,
      maxPhase: c.maxPhase,
      phaseLabel: rankToLabel.get(c.maxPhase) ?? 'N/A',
      sponsors: [...c.sponsorCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name),
      aliases,
      nctIds: [...c.nctIds],
    };
  });

  drugs.sort(
    (a, b) =>
      b.trialCount - a.trialCount || b.maxPhase - a.maxPhase || a.displayName.localeCompare(b.displayName),
  );

  return {
    drugs,
    excludedCount,
    excludedNames: [...excludedNames],
    assignedCount,
    mentionTotal: mentions.length,
  };
}
