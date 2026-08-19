import { buildPdfReport, buildTrialsPdfReport } from './pdfReport';
import type { Landscape, DrugRow } from './drugs/cluster';
import type { FdaBadge } from './drugs/openfda';
import type { ReportMeta } from './report';
import type { Trial } from './types';

// Smoke-level only: the cell text and scope rules are unit-tested in
// report.test.ts against the shared helpers; here we prove jspdf actually
// produces a well-formed document from the same inputs.

function row(over: Partial<DrugRow> & { key: string; displayName: string }): DrugRow {
  return {
    trialCount: 1,
    maxPhase: 3,
    phaseLabel: 'Phase 2',
    sponsors: ['Merck'],
    aliases: [],
    nctIds: ['NCT00000001'],
    ...over,
  };
}

const landscape: Landscape = {
  drugs: [
    row({ key: 'pembrolizumab', displayName: 'Pembrolizumab', aliases: ['Keytruda'] }),
    row({ key: 'ab106', displayName: 'AB-106' }),
  ],
  excludedCount: 2,
  excludedNames: [],
  assignedCount: 3,
  mentionTotal: 5,
};

const fdaMap = new Map<string, FdaBadge | null>([
  ['pembrolizumab', { status: 'approved', approvalYear: '2014', via: 'generic' }],
  ['ab106', null],
]);

const meta: ReportMeta = {
  disease: 'lung cancer',
  generatedAt: new Date('2026-08-14T12:00:00Z'),
  totalTrials: 6000,
  fetchedTrials: 1000,
  filteredTrials: 1000,
  filters: { phases: [], statuses: [] },
  phaseBuckets: [{ key: 'PHASE3', label: 'Phase 3', count: 120 }],
};

describe('buildPdfReport', () => {
  it('produces a well-formed non-trivial PDF', () => {
    const doc = buildPdfReport(landscape, fdaMap, new Map(), meta);
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(2000);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('paginates instead of overflowing on a large landscape', () => {
    const many: Landscape = {
      ...landscape,
      drugs: Array.from({ length: 120 }, (_, i) => row({ key: `d${i}`, displayName: `Drug ${i}` })),
    };
    const doc = buildPdfReport(many, new Map(), new Map(), meta);
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
  });

  // Regression: real registry data (unbroken 70-char names, long sponsors)
  // once collapsed the narrow columns to ~1 char, wrapping text vertically —
  // each row grew ~10x tall. Fixed column widths keep rows compact: 40 such
  // rows must fit in a few pages, not one page per couple of rows.
  it('trials report renders landscape-oriented, well-formed, and compact', () => {
    const trials: Trial[] = Array.from({ length: 40 }, (_, i) => ({
      nctId: `NCT0000${1000 + i}`,
      title: `A Phase 3 Randomized Study of Something Long-Winded and Specific, Cohort ${i}`,
      status: 'RECRUITING',
      phases: ['PHASE3'],
      enrollment: i % 3 === 0 ? null : 100 + i,
      sponsor: 'Intergroupe Francophone de Cancerologie Thoracique',
      interventions: [
        { type: 'DRUG', name: 'Osimertinibforsymptomaticbrainmetastasesinegfrclassicmutatedlungcancer', otherNames: [] },
        { type: 'DRUG', name: 'Carboplatin', otherNames: [] },
      ],
    }));
    const doc = buildTrialsPdfReport(trials, meta);
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    const size = doc.internal.pageSize;
    expect(size.getWidth()).toBeGreaterThan(size.getHeight()); // landscape A4
    expect(doc.getNumberOfPages()).toBeLessThanOrEqual(5);
  });

  it('keeps rows compact with hostile unbroken names and long sponsors', () => {
    const hostile: Landscape = {
      ...landscape,
      drugs: Array.from({ length: 40 }, (_, i) =>
        row({
          key: `d${i}`,
          displayName: `Osimertinibforsymptomaticbrainmetastasesinegfrclassicmutatedlungcancer${i}`,
          sponsors: ['Intergroupe Francophone de Cancerologie Thoracique', 'AstraZeneca'],
          aliases: ['Demethyl Epipodophyllotoxin Ethylidine Glucoside', 'EPEG', 'Lastet', 'x', 'y'],
        }),
      ),
    };
    const doc = buildPdfReport(hostile, new Map(), new Map(), meta);
    expect(doc.getNumberOfPages()).toBeLessThanOrEqual(4);
  });
});
