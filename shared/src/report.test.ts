import {
  buildHtmlReport,
  buildMarkdownReport,
  buildTrialsHtmlReport,
  buildTrialsMarkdownReport,
  localDateStamp,
  reportFilename,
  reportFilenameFor,
  type ReportMeta,
} from './report';
import type { Landscape, DrugRow } from './drugs/cluster';
import type { FdaBadge } from './drugs/openfda';
import type { Trial } from './types';

function row(over: Partial<DrugRow> & { key: string; displayName: string }): DrugRow {
  return {
    trialCount: 1,
    maxPhase: 3,
    phaseLabel: 'Phase 2',
    sponsors: ['Merck Sharp & Dohme'],
    aliases: [],
    nctIds: ['NCT00000001'],
    ...over,
  };
}

const approvedBadge: FdaBadge = { status: 'approved', approvalYear: '2014', via: 'generic' };
const approxBadge: FdaBadge = { status: 'approved', approvalYear: '2004', approvalApprox: true, via: 'generic' };

const landscape: Landscape = {
  drugs: [
    row({ key: 'pembrolizumab', displayName: 'Pembrolizumab', aliases: ['Keytruda', 'MK-3475'] }),
    row({ key: 'carboplatin', displayName: 'Carboplatin' }),
    row({ key: 'ab106', displayName: 'AB-106' }),
    row({ key: 'xy123', displayName: 'XY|123 weird', sponsors: [] }),
  ],
  excludedCount: 7,
  excludedNames: ['Chemotherapy'],
  assignedCount: 10,
  mentionTotal: 17,
};

const fdaMap = new Map<string, FdaBadge | null>([
  ['pembrolizumab', approvedBadge],
  ['carboplatin', approxBadge],
  ['ab106', null],
  // xy123 absent = pending
]);

const rxcuiMap = new Map<string, string | null>([
  ['pembrolizumab', '1547545'],
  ['xy123', null], // definitive RxNorm miss while FDA still pending
]);

// LOCAL noon, not a Z-suffixed string: dates are stamped in the user's local
// calendar, so a UTC-midday fixture would shift by a day in far-east/west TZs.
const FIXED_DATE = new Date(2026, 7, 14, 12, 0, 0);

function meta(over: Partial<ReportMeta> = {}): ReportMeta {
  return {
    disease: 'lung cancer',
    generatedAt: FIXED_DATE,
    totalTrials: 6000,
    fetchedTrials: 1000,
    filteredTrials: 1000,
    filters: { phases: [], statuses: [] },
    phaseBuckets: [
      { key: 'PHASE3', label: 'Phase 3', count: 120 },
      { key: 'PHASE2', label: 'Phase 2', count: 300 },
    ],
    ...over,
  };
}

describe('buildMarkdownReport', () => {
  it('renders a two-number scope line when no filters are active', () => {
    const md = buildMarkdownReport(landscape, fdaMap, rxcuiMap, meta());
    expect(md).toContain('**1,000 of 6,000** active trials loaded');
    expect(md).not.toContain('matching filters');
    expect(md).toContain('7 non-drug / unspecified intervention mentions excluded');
  });

  it('renders THREE numbers when filters are active — filtered is never presented as load depth', () => {
    const md = buildMarkdownReport(
      landscape,
      fdaMap,
      rxcuiMap,
      meta({ filteredTrials: 300, filters: { phases: ['Phase 3'], statuses: ['Recruiting'] } }),
    );
    expect(md).toContain('**300** trials matching filters (phase: Phase 3; status: Recruiting)');
    expect(md).toContain('filtered from **1,000 of 6,000** active trials loaded');
  });

  it('mirrors the UI FDA cell rules, keeping pending separate from investigational', () => {
    const md = buildMarkdownReport(landscape, fdaMap, rxcuiMap, meta());
    expect(md).toContain('| Pembrolizumab | Phase 2 | 1 | Approved 2014 |');
    expect(md).toContain('| Carboplatin | Phase 2 | 1 | Approved · records since 2004 |');
    expect(md).toContain('| AB-106 | Phase 2 | 1 | Investigational |');
    // Pending + RxNorm definitive miss → hint, not a verdict.
    expect(md).toContain('— (not in RxNorm · likely investigational)');
    expect(md).toContain('**2** FDA-approved, **1** investigational, **1** pending verification.');
  });

  it('pending row without an RxNorm miss renders a bare dash', () => {
    const md = buildMarkdownReport(landscape, fdaMap, new Map(), meta());
    expect(md).not.toContain('not in RxNorm');
    expect(md).toContain('| XY\\|123 weird | Phase 2 | 1 | — | — | — |');
  });

  it('escapes pipes in free-text cells so the table stays parseable', () => {
    const md = buildMarkdownReport(landscape, fdaMap, rxcuiMap, meta());
    expect(md).toContain('XY\\|123 weird');
    const tableLines = md.split('\n').filter((l) => l.startsWith('|'));
    // Header + separator + 4 drug rows, each with exactly 6 columns (7 unescaped pipes).
    expect(tableLines).toHaveLength(6);
    for (const line of tableLines) {
      expect(line.replace(/\\\|/g, '').split('|')).toHaveLength(8);
    }
  });

  it('caps aliases at 3 and abbreviates extra sponsors', () => {
    const many = {
      ...landscape,
      drugs: [
        row({
          key: 'k',
          displayName: 'Drug',
          aliases: ['a1', 'a2', 'a3', 'a4', 'a5'],
          sponsors: ['S1', 'S2', 'S3'],
        }),
      ],
    };
    const md = buildMarkdownReport(many, new Map(), new Map(), meta());
    expect(md).toContain('a1, a2, a3 +2 more');
    expect(md).toContain('S1 +2');
  });

  it('is deterministic for a fixed generatedAt', () => {
    const a = buildMarkdownReport(landscape, fdaMap, rxcuiMap, meta());
    const b = buildMarkdownReport(landscape, fdaMap, rxcuiMap, meta());
    expect(a).toBe(b);
    expect(a).toContain('Generated 2026-08-14');
  });
});

describe('buildHtmlReport', () => {
  it('is a self-contained document with the same scope honesty as Markdown', () => {
    const html = buildHtmlReport(landscape, fdaMap, rxcuiMap, meta());
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/src=|href=/); // no external assets — attachable anywhere
    expect(html).toContain('<strong>1,000 of 6,000</strong> active trials loaded');
    expect(html).toContain('7 non-drug / unspecified intervention mentions excluded');
  });

  it('renders three numbers when filters are active', () => {
    const html = buildHtmlReport(
      landscape,
      fdaMap,
      rxcuiMap,
      meta({ filteredTrials: 300, filters: { phases: ['Phase 3'], statuses: ['Recruiting'] } }),
    );
    expect(html).toContain('<strong>300</strong> trials matching filters (phase: Phase 3; status: Recruiting)');
    expect(html).toContain('filtered from <strong>1,000 of 6,000</strong> active trials loaded');
  });

  it('keeps the FDA cell rules, pending separate from investigational', () => {
    const html = buildHtmlReport(landscape, fdaMap, rxcuiMap, meta());
    expect(html).toContain('<span class="chip approved">Approved 2014</span>');
    expect(html).toContain('<span class="chip approved">Approved · records since 2004</span>');
    expect(html).toContain('<span class="chip inv">Investigational</span>');
    expect(html).toContain('<span class="chip pending">— (not in RxNorm · likely investigational)</span>');
    expect(html).toContain('<strong>2</strong> FDA-approved, <strong>1</strong> investigational, <strong>1</strong> pending verification.');
  });

  it('entity-escapes free text so registry names cannot inject markup', () => {
    const hostile = {
      ...landscape,
      drugs: [
        row({ key: 'evil', displayName: '<script>alert(1)</script> & "co"', sponsors: ['A<B'] }),
      ],
    };
    const html = buildHtmlReport(hostile, new Map(), new Map(), meta());
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;');
    expect(html).toContain('A&lt;B');
  });

  it('is deterministic for a fixed generatedAt', () => {
    const a = buildHtmlReport(landscape, fdaMap, rxcuiMap, meta());
    const b = buildHtmlReport(landscape, fdaMap, rxcuiMap, meta());
    expect(a).toBe(b);
    expect(a).toContain('Generated 2026-08-14');
  });
});

describe('trials report', () => {
  const trial = (over: Partial<Trial> & { nctId: string }): Trial => ({
    title: 'A Study of Something',
    status: 'RECRUITING',
    phases: ['PHASE2', 'PHASE3'],
    enrollment: 1200,
    sponsor: 'Merck Sharp & Dohme',
    interventions: [{ type: 'DRUG', name: 'Pembrolizumab', otherNames: [] }],
    ...over,
  });

  const trials: Trial[] = [
    trial({ nctId: 'NCT00000001' }),
    trial({
      nctId: 'NCT00000002',
      title: 'Weird | piped <b>title</b>',
      enrollment: null,
      phases: [],
      interventions: [],
    }),
  ];

  it('markdown mirrors the trials table columns with NCT links and the scope line', () => {
    const md = buildTrialsMarkdownReport(trials, meta());
    expect(md).toContain('# Pipeline Radar — Lung cancer active clinical trials');
    expect(md).toContain('**1,000 of 6,000** active trials loaded');
    expect(md).toContain(`| ${['NCT ID', 'Title', "What's tested", 'Sponsor', 'Phase', 'Status', 'Enrollment'].join(' | ')} |`);
    expect(md).toContain('[NCT00000001](https://clinicaltrials.gov/study/NCT00000001)');
    expect(md).toContain('| Phase 2, Phase 3 | Recruiting | 1,200 |');
    // Null enrollment and empty phases/interventions render as dashes, pipes escaped.
    expect(md).toContain('Weird \\| piped <b>title</b>');
    expect(md).toContain('| N/A | Recruiting | — |');
  });

  it('html escapes free text and links each NCT id', () => {
    const html = buildTrialsHtmlReport(trials, meta());
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<a href="https://clinicaltrials.gov/study/NCT00000002">NCT00000002</a>');
    expect(html).toContain('Weird | piped &lt;b&gt;title&lt;/b&gt;');
    expect(html).not.toContain('<b>title</b>');
  });

  it('is deterministic for a fixed generatedAt', () => {
    expect(buildTrialsMarkdownReport(trials, meta())).toBe(buildTrialsMarkdownReport(trials, meta()));
    expect(buildTrialsHtmlReport(trials, meta())).toBe(buildTrialsHtmlReport(trials, meta()));
  });
});

describe('reportFilename', () => {
  it('slugs the disease and stamps the date', () => {
    expect(reportFilename('Non-Small Cell Lung Cancer!', FIXED_DATE)).toBe(
      'pipeline-radar-non-small-cell-lung-cancer-2026-08-14.md',
    );
  });
  it('falls back when the slug is empty', () => {
    expect(reportFilename('!!!', FIXED_DATE)).toBe('pipeline-radar-landscape-2026-08-14.md');
  });
  it('stamps the requested extension', () => {
    expect(reportFilename('lung cancer', FIXED_DATE, 'html')).toBe('pipeline-radar-lung-cancer-2026-08-14.html');
    expect(reportFilename('lung cancer', FIXED_DATE, 'pdf')).toBe('pipeline-radar-lung-cancer-2026-08-14.pdf');
  });
});

describe('date stamping', () => {
  it('localDateStamp uses the LOCAL calendar day, not the UTC one', () => {
    // 11:30pm local on Aug 14: for any TZ west of UTC this instant is already
    // Aug 15 in UTC — toISOString() would stamp tomorrow's date on the report.
    const lateEvening = new Date(2026, 7, 14, 23, 30, 0);
    expect(localDateStamp(lateEvening)).toBe('2026-08-14');
  });
  it('reportFilenameFor derives filename from the SAME meta the body renders from', () => {
    const m = meta();
    expect(reportFilenameFor(m, 'pdf')).toBe('pipeline-radar-lung-cancer-2026-08-14.pdf');
    expect(reportFilenameFor(m, 'md', 'trials')).toBe('pipeline-radar-lung-cancer-trials-2026-08-14.md');
    // The body's Generated line carries the same date as the filename.
    expect(buildMarkdownReport(landscape, fdaMap, rxcuiMap, m)).toContain(`Generated ${localDateStamp(m.generatedAt)}`);
  });
});
