import type { Landscape, DrugRow } from './drugs/cluster';
import { fdaStatusOf, type FdaBadge, type FdaStatus } from './drugs/openfda';
import type { PhaseBucket } from './summarize';
import type { Trial } from './types';
import { formatPhases, formatStatus } from './mapStudy';

// Milestone 5: the consultant deliverable. Pure landscape → Markdown/HTML; no
// fetch, no Date.now() — generatedAt is injected so the output is
// snapshot-testable. (The PDF renderer lives in pdfReport.ts so this module
// stays dependency-free; all three formats share the helpers below.)
//
// The one rule that matters here is the scope line: the report must never claim
// more coverage than it has. Three distinct numbers exist (registry total,
// trials fetched, trials surviving filters) and conflating any two of them is
// the milestone's named failure mode (MILESTONE-5-PLAN.md step 1).

export interface ReportMeta {
  disease: string;
  generatedAt: Date;
  totalTrials: number; // registry total for the query
  fetchedTrials: number; // true load depth
  filteredTrials: number; // what the exported landscape derives from
  filters: { phases: string[]; statuses: string[] }; // human-readable labels
  phaseBuckets: PhaseBucket[]; // trialsByPhase(filtered), computed at call site
}

// Free text goes into table cells: collapse whitespace so one weird
// intervention name can't break a row across lines. Format-specific escaping
// (Markdown pipes, HTML entities) is each renderer's job.
function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Local calendar date (yyyy-mm-dd). NEVER toISOString here: that stamps the UTC
// day, and a consultant exporting in the evening west of UTC would get a report
// dated tomorrow — a provenance error on the exact line built for honesty.
export function localDateStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Mirrors DrugTable's FdaChip + the RxNorm hint: absent key = pending, never a
// verdict; pending + definitive RxNorm miss keeps the likely-investigational hint.
// Classification goes through fdaStatusOf — the single owner of the three-way rule.
export function fdaCellText(
  key: string,
  fdaMap: ReadonlyMap<string, FdaBadge | null>,
  rxcuiMap: ReadonlyMap<string, string | null>,
): string {
  const status = fdaStatusOf(key, fdaMap);
  if (status === 'unknown') {
    return rxcuiMap.get(key) === null ? '— (not in RxNorm · likely investigational)' : '—';
  }
  if (status === 'investigational') return 'Investigational';
  const badge = fdaMap.get(key)!;
  if (!badge.approvalYear) return 'Approved';
  return badge.approvalApprox
    ? `Approved · records since ${badge.approvalYear}`
    : `Approved ${badge.approvalYear}`;
}

// Headline stats — pending is its own bucket, never folded into investigational.
export function fdaSummary(landscape: Landscape, fdaMap: ReadonlyMap<string, FdaBadge | null>) {
  let approved = 0;
  let investigational = 0;
  let pending = 0;
  for (const d of landscape.drugs) {
    const status = fdaStatusOf(d.key, fdaMap);
    if (status === 'unknown') pending++;
    else if (status === 'approved') approved++;
    else investigational++;
  }
  return { approved, investigational, pending };
}

export interface DrugRowCells {
  name: string;
  phase: string;
  trials: number;
  fda: string;
  fdaStatus: FdaStatus; // structured category — renderers style from THIS, never by sniffing `fda`
  sponsor: string;
  aliases: string;
}

// One drug row as raw display strings, shared by every renderer.
export function drugRowCells(
  d: DrugRow,
  fdaMap: ReadonlyMap<string, FdaBadge | null>,
  rxcuiMap: ReadonlyMap<string, string | null>,
): DrugRowCells {
  const sponsor =
    d.sponsors.length === 0
      ? '—'
      : tidy(d.sponsors[0]) + (d.sponsors.length > 1 ? ` +${d.sponsors.length - 1}` : '');
  const aliases =
    d.aliases.length === 0
      ? '—'
      : d.aliases.slice(0, 3).map(tidy).join(', ') +
        (d.aliases.length > 3 ? ` +${d.aliases.length - 3} more` : '');
  return {
    name: tidy(d.displayName),
    phase: d.phaseLabel,
    trials: d.trialCount,
    fda: fdaCellText(d.key, fdaMap, rxcuiMap),
    fdaStatus: fdaStatusOf(d.key, fdaMap),
    sponsor,
    aliases,
  };
}

export function filterLabels(meta: ReportMeta): string {
  return [
    meta.filters.phases.length > 0 ? `phase: ${meta.filters.phases.join(', ')}` : '',
    meta.filters.statuses.length > 0 ? `status: ${meta.filters.statuses.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function filtersActive(meta: ReportMeta): boolean {
  return meta.filters.phases.length > 0 || meta.filters.statuses.length > 0;
}

// One scope sentence for every renderer and view — the three-number honesty
// rule lives here and nowhere else. `strong` wraps emphasis (Markdown ** /
// HTML <strong>), `escText` escapes free text for the target format.
export function scopeSentence(
  meta: ReportMeta,
  strong: (s: string) => string,
  escText: (s: string) => string = (s) => s,
): string {
  const loaded = `${strong(`${meta.fetchedTrials.toLocaleString()} of ${meta.totalTrials.toLocaleString()}`)} active trials loaded from ClinicalTrials.gov`;
  return filtersActive(meta)
    ? `Scope: based on ${strong(meta.filteredTrials.toLocaleString())} trials matching filters (${escText(filterLabels(meta))}), filtered from ${loaded}.`
    : `Scope: based on ${loaded}.`;
}

// ---- Cross-format sentences ----
// Every line that must read IDENTICALLY in .md, .html and .pdf is built here
// once (same pattern as scopeSentence). Renderers pass their own emphasis
// wrapper / escaper; they never rebuild the wording.

const identity = (s: string) => s;

export function reportTitle(meta: ReportMeta, kind: ReportKind = 'landscape'): string {
  return `Pipeline Radar — ${capitalize(meta.disease)} ${
    kind === 'trials' ? 'active clinical trials' : 'development landscape'
  }`;
}

export function generatedLine(meta: ReportMeta, kind: ReportKind = 'landscape'): string {
  const sources =
    kind === 'trials'
      ? 'ClinicalTrials.gov public data'
      : 'ClinicalTrials.gov, RxNorm and FDA (drugs@fda) public data';
  return `Generated ${localDateStamp(meta.generatedAt)} from ${sources}.`;
}

export function phaseBucketsLine(meta: ReportMeta, escText: (s: string) => string = identity): string | null {
  if (meta.phaseBuckets.length === 0) return null;
  return `Trials by phase: ${meta.phaseBuckets.map((b) => `${escText(b.label)}: ${b.count}`).join(' · ')}.`;
}

export function statsLine(
  landscape: Landscape,
  fdaMap: ReadonlyMap<string, FdaBadge | null>,
  strong: (s: string) => string = identity,
): string {
  const stats = fdaSummary(landscape, fdaMap);
  const counts = [`${strong(String(stats.approved))} FDA-approved`, `${strong(String(stats.investigational))} investigational`];
  if (stats.pending > 0) counts.push(`${strong(String(stats.pending))} pending verification`);
  return `${strong(`${landscape.drugs.length} unique drugs`)} — ${counts.join(', ')}.`;
}

export function excludedLine(landscape: Landscape): string | null {
  if (landscape.excludedCount === 0) return null;
  return `${landscape.excludedCount} non-drug / unspecified intervention mentions excluded from the drug rollup.`;
}

export const TABLE_HEADERS = ['Drug', 'Highest phase', 'Trials', 'FDA status', 'Lead sponsor', 'Also known as'];

export const METHODOLOGY =
  'Drug rows are clustered from free-text trial intervention names by heuristic alias voting (no transitive merging); perfect normalization of registry free text is not possible, so rare split/merge errors are expected. FDA status is a name match against drugs@fda (generic then brand names): "Investigational" means no FDA approval record was found under any known name, and "—" means the check has not completed. "Not in RxNorm" flags names absent from the NLM drug vocabulary — typical for new compounds and research codes.';

export function buildMarkdownReport(
  landscape: Landscape,
  fdaMap: ReadonlyMap<string, FdaBadge | null>,
  rxcuiMap: ReadonlyMap<string, string | null>,
  meta: ReportMeta,
): string {
  const lines: string[] = [];
  const pipe = (s: string) => s.replace(/\|/g, '\\|');
  const bold = (s: string) => `**${s}**`;

  lines.push(`# ${reportTitle(meta)}`);
  lines.push('');
  lines.push(generatedLine(meta));
  lines.push('');

  // Scope line — three numbers when filters are active, never filtered-as-loaded.
  lines.push(scopeSentence(meta, bold));
  const excluded = excludedLine(landscape);
  if (excluded) lines.push(excluded);
  lines.push('');

  lines.push(statsLine(landscape, fdaMap, bold));
  const phases = phaseBucketsLine(meta);
  if (phases) lines.push(phases);
  lines.push('');

  // The landscape table.
  lines.push(`| ${TABLE_HEADERS.join(' | ')} |`);
  lines.push('| --- | --- | ---: | --- | --- | --- |');
  for (const d of landscape.drugs) {
    const c = drugRowCells(d, fdaMap, rxcuiMap);
    lines.push(
      `| ${pipe(c.name)} | ${c.phase} | ${c.trials} | ${c.fda} | ${pipe(c.sponsor)} | ${pipe(c.aliases)} |`,
    );
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(`**Methodology.** ${METHODOLOGY}`);
  lines.push('');
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const HTML_CSS = `
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; background: #fff; max-width: 920px; margin: 2rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.45rem; margin-bottom: 0.25rem; }
  .gen { color: #6b7280; font-size: 0.85rem; margin-top: 0; }
  .scope, .excluded { font-size: 0.92rem; margin: 0.35rem 0; }
  .stats { font-size: 0.95rem; margin: 0.8rem 0 0.2rem; }
  .phases { color: #374151; font-size: 0.88rem; margin-top: 0.1rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; font-size: 0.88rem; }
  th, td { border: 1px solid #e5e7eb; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; }
  td.num, th.num { text-align: right; }
  .chip { display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px; font-size: 0.8rem; white-space: nowrap; }
  .chip.approved { background: #def7ec; color: #046c4e; }
  .chip.inv { background: #f3f4f6; color: #374151; }
  .chip.pending { background: none; color: #9ca3af; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5rem 0 0.8rem; }
  .method { color: #4b5563; font-size: 0.8rem; }
  @media print { body { margin: 0.5rem auto; } }
`;

// One self-contained document (inline CSS, no external assets) a consultant
// can attach to an email or open anywhere.
function htmlShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${HTML_CSS}</style>
</head>
<body>
${body}</body>
</html>
`;
}

// HTML landscape report. Same sections and cell rules as the Markdown report;
// free text is entity-escaped.
export function buildHtmlReport(
  landscape: Landscape,
  fdaMap: ReadonlyMap<string, FdaBadge | null>,
  rxcuiMap: ReadonlyMap<string, string | null>,
  meta: ReportMeta,
): string {
  const esc = escapeHtml;
  const strong = (s: string) => `<strong>${s}</strong>`;

  const title = reportTitle(meta);
  const scope = scopeSentence(meta, strong, esc);
  const excluded = excludedLine(landscape);
  const phases = phaseBucketsLine(meta, esc);

  // Chip class comes from the structured status — NEVER sniffed back out of the
  // display text, which rewording or localization would silently misclassify.
  const CHIP_CLASS: Record<FdaStatus, string> = { approved: 'approved', investigational: 'inv', unknown: 'pending' };
  const fdaChip = (c: DrugRowCells) => `<span class="chip ${CHIP_CLASS[c.fdaStatus]}">${esc(c.fda)}</span>`;

  const rows = landscape.drugs
    .map((d) => {
      const c = drugRowCells(d, fdaMap, rxcuiMap);
      return `      <tr><td>${esc(c.name)}</td><td>${esc(c.phase)}</td><td class="num">${c.trials}</td><td>${fdaChip(c)}</td><td>${esc(c.sponsor)}</td><td>${esc(c.aliases)}</td></tr>`;
    })
    .join('\n');

  return htmlShell(
    title,
    `<h1>${esc(title)}</h1>
<p class="gen">${generatedLine(meta)}</p>
<p class="scope">${scope}</p>
${excluded ? `<p class="excluded">${excluded}</p>\n` : ''}<p class="stats">${statsLine(landscape, fdaMap, strong)}</p>
${phases ? `<p class="phases">${phases}</p>\n` : ''}<table>
  <thead>
    <tr>${TABLE_HEADERS.map((h) => `<th${h === 'Trials' ? ' class="num"' : ''}>${h}</th>`).join('')}</tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
<hr>
<p class="method"><strong>Methodology.</strong> ${esc(METHODOLOGY)}</p>
`,
  );
}

// ---- Trials-view export (mirrors TrialsTable's columns verbatim) ----

export const TRIALS_TABLE_HEADERS = ['NCT ID', 'Title', "What's tested", 'Sponsor', 'Phase', 'Status', 'Enrollment'];

export const TRIALS_SOURCE_NOTE =
  'ClinicalTrials.gov study records, exported exactly as loaded (current filters and sort applied). "What\'s tested" lists each trial\'s registered interventions verbatim — free text, not normalized; the drug landscape export is the deduplicated per-drug view.';

export interface TrialRowCells {
  nctId: string;
  title: string;
  tested: string;
  sponsor: string;
  phase: string;
  status: string;
  enrollment: string;
}

export function trialRowCells(t: Trial): TrialRowCells {
  return {
    nctId: t.nctId,
    title: tidy(t.title),
    tested: t.interventions.map((i) => tidy(i.name)).join(', ') || '—',
    sponsor: tidy(t.sponsor),
    phase: formatPhases(t.phases),
    status: formatStatus(t.status),
    enrollment: t.enrollment === null ? '—' : t.enrollment.toLocaleString(),
  };
}

export function buildTrialsMarkdownReport(trials: Trial[], meta: ReportMeta): string {
  const lines: string[] = [];
  const pipe = (s: string) => s.replace(/\|/g, '\\|');

  lines.push(`# ${reportTitle(meta, 'trials')}`);
  lines.push('');
  lines.push(generatedLine(meta, 'trials'));
  lines.push('');
  lines.push(scopeSentence(meta, (s) => `**${s}**`));
  const phases = phaseBucketsLine(meta);
  if (phases) lines.push(phases);
  lines.push('');

  lines.push(`| ${TRIALS_TABLE_HEADERS.join(' | ')} |`);
  lines.push('| --- | --- | --- | --- | --- | --- | ---: |');
  for (const t of trials) {
    const c = trialRowCells(t);
    lines.push(
      `| [${c.nctId}](https://clinicaltrials.gov/study/${c.nctId}) | ${pipe(c.title)} | ${pipe(c.tested)} | ${pipe(c.sponsor)} | ${c.phase} | ${c.status} | ${c.enrollment} |`,
    );
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**Source.** ${TRIALS_SOURCE_NOTE}`);
  lines.push('');
  return lines.join('\n');
}

export function buildTrialsHtmlReport(trials: Trial[], meta: ReportMeta): string {
  const esc = escapeHtml;
  const title = reportTitle(meta, 'trials');
  const scope = scopeSentence(meta, (s) => `<strong>${s}</strong>`, esc);
  const phases = phaseBucketsLine(meta, esc);

  const rows = trials
    .map((t) => {
      const c = trialRowCells(t);
      return `      <tr><td><a href="https://clinicaltrials.gov/study/${esc(c.nctId)}">${esc(c.nctId)}</a></td><td>${esc(c.title)}</td><td>${esc(c.tested)}</td><td>${esc(c.sponsor)}</td><td>${esc(c.phase)}</td><td>${esc(c.status)}</td><td class="num">${esc(c.enrollment)}</td></tr>`;
    })
    .join('\n');

  return htmlShell(
    title,
    `<h1>${esc(title)}</h1>
<p class="gen">${generatedLine(meta, 'trials')}</p>
<p class="scope">${scope}</p>
${phases ? `<p class="phases">${phases}</p>\n` : ''}<table>
  <thead>
    <tr>${TRIALS_TABLE_HEADERS.map((h) => `<th${h === 'Enrollment' ? ' class="num"' : ''}>${h}</th>`).join('')}</tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
<hr>
<p class="method"><strong>Source.</strong> ${esc(TRIALS_SOURCE_NOTE)}</p>
`,
  );
}

export type ReportExt = 'md' | 'html' | 'pdf';
export type ReportKind = 'landscape' | 'trials';

export function reportFilename(disease: string, date: Date, ext: ReportExt = 'md', kind: ReportKind = 'landscape'): string {
  const slug = disease
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = kind === 'trials' ? '-trials' : '';
  return `pipeline-radar-${slug || 'landscape'}${suffix}-${localDateStamp(date)}.${ext}`;
}

// Filename derived from the SAME meta the report body renders from — one clock
// per export click, so the filename date can never disagree with the
// "Generated" line inside the document.
export function reportFilenameFor(meta: ReportMeta, ext: ReportExt, kind: ReportKind = 'landscape'): string {
  return reportFilename(meta.disease, meta.generatedAt, ext, kind);
}
