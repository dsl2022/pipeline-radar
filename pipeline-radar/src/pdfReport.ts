import { jsPDF } from 'jspdf';
import autoTable, { type UserOptions } from 'jspdf-autotable';
import {
  METHODOLOGY,
  TRIALS_SOURCE_NOTE,
  TABLE_HEADERS,
  TRIALS_TABLE_HEADERS,
  drugRowCells,
  generatedLine,
  excludedLine,
  phaseBucketsLine,
  reportTitle,
  scopeSentence,
  statsLine,
  trialRowCells,
  type ReportMeta,
} from '@pipeline-radar/shared/report';
import { winAnsiSafe } from './pdfText';
import type { Trial } from '@pipeline-radar/shared/types';
import type { Landscape } from '@pipeline-radar/shared/drugs/cluster';
import type { FdaBadge } from '@pipeline-radar/shared/drugs/openfda';

// PDF renderer for the consultant deliverable — a real .pdf file download, not
// the print dialog. Kept out of report.ts so the pure text renderers stay
// dependency-free, and imported dynamically from the export bar so jspdf
// (~350KB) never loads unless someone clicks Export .pdf.
//
// All text is routed through winAnsiSafe (pdfText.ts): jsPDF's built-in fonts
// are WinAnsi-encoded, and registry free text does NOT stay within that —
// Greek letters in drug names are routine. Prose wording comes from report.ts
// helpers so the .pdf can never drift from the .md/.html of the same landscape.
//
// Both builders share one scaffold (page geometry, paragraph flow, header
// sequence, table theme) — only orientation, columns and body differ.

const MARGIN = 48; // pt
const A4_SHORT = 595.28;
const A4_LONG = 841.89;

interface PdfPage {
  doc: jsPDF;
  width: number; // content width
  pageHeight: number;
  paragraph: (text: string, size: number, color: string, gapAfter: number) => void;
  currentY: () => number;
}

function startPage(orientation: 'portrait' | 'landscape'): PdfPage {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation });
  const pageWidth = orientation === 'landscape' ? A4_LONG : A4_SHORT;
  const pageHeight = orientation === 'landscape' ? A4_SHORT : A4_LONG;
  const width = pageWidth - 2 * MARGIN;
  let y = MARGIN;

  const paragraph = (text: string, size: number, color: string, gapAfter: number) => {
    doc.setFontSize(size).setTextColor(color);
    const wrapped = doc.splitTextToSize(winAnsiSafe(text), width) as string[];
    doc.text(wrapped, MARGIN, y);
    y += wrapped.length * size * 1.25 + gapAfter;
  };

  return { doc, width, pageHeight, paragraph, currentY: () => y };
}

// Title + generated + body lines, shared by every PDF view.
function renderHeader(page: PdfPage, title: string, generated: string, bodyLines: string[]) {
  page.doc.setFont('helvetica', 'bold');
  page.paragraph(title, 16, '#111827', 4);
  page.doc.setFont('helvetica', 'normal');
  page.paragraph(generated, 8.5, '#6b7280', 6);
  bodyLines.forEach((line, i) => {
    page.paragraph(line, 9.5, i === bodyLines.length - 1 ? '#374151' : '#1f2937', i === bodyLines.length - 1 ? 4 : 2);
  });
}

// FIXED column widths, never auto. Real registry data contains unbroken
// 70-char intervention names and long sponsor strings; autotable's
// content-proportional sizing hands those columns everything and squeezes
// the rest to ~one character, wrapping their text vertically letter-by-
// letter (seen on the real 353-drug lung-cancer export). With fixed widths
// the 'linebreak' overflow mode breaks long words instead.
function renderTable(page: PdfPage, head: string[], body: string[][], fontSize: number, columnStyles: UserOptions['columnStyles']) {
  autoTable(page.doc, {
    startY: page.currentY(),
    margin: { left: MARGIN, right: MARGIN },
    head: [head],
    body: body.map((row) => row.map(winAnsiSafe)),
    styles: { fontSize, cellPadding: 3, textColor: '#1f2937', overflow: 'linebreak' },
    headStyles: { fillColor: '#1a56db', textColor: '#ffffff', fontStyle: 'bold' },
    alternateRowStyles: { fillColor: '#f8fafc' },
    columnStyles,
  });
}

// Footnote below the table, spilling to a new page if the table ran long.
function appendFootnote(page: PdfPage, text: string) {
  const { doc } = page;
  let y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? page.currentY()) + 18;
  doc.setFontSize(7.5).setTextColor('#4b5563');
  const wrapped = doc.splitTextToSize(winAnsiSafe(text), page.width) as string[];
  if (y + wrapped.length * 7.5 * 1.25 > page.pageHeight - MARGIN) {
    doc.addPage();
    y = MARGIN;
  }
  doc.text(wrapped, MARGIN, y);
}

export function buildPdfReport(
  landscape: Landscape,
  fdaMap: ReadonlyMap<string, FdaBadge | null>,
  rxcuiMap: ReadonlyMap<string, string | null>,
  meta: ReportMeta,
): jsPDF {
  const page = startPage('portrait');

  renderHeader(
    page,
    reportTitle(meta),
    generatedLine(meta),
    [scopeSentence(meta, (s) => s), excludedLine(landscape), statsLine(landscape, fdaMap), phaseBucketsLine(meta)].filter(
      (l): l is string => l !== null,
    ),
  );

  renderTable(
    page,
    TABLE_HEADERS,
    landscape.drugs.map((d) => {
      const c = drugRowCells(d, fdaMap, rxcuiMap);
      return [c.name, c.phase, String(c.trials), c.fda, c.sponsor, c.aliases];
    }),
    8,
    {
      0: { cellWidth: 105 }, // Drug
      1: { cellWidth: 48 }, // Highest phase
      2: { cellWidth: 30, halign: 'right' }, // Trials
      3: { cellWidth: 80 }, // FDA status
      4: { cellWidth: 100 }, // Lead sponsor
      5: { cellWidth: 'auto' }, // Also known as — takes the remainder (~136pt)
    },
  );

  appendFootnote(page, `Methodology. ${METHODOLOGY}`);
  return page.doc;
}

// Trials-view export: seven columns need the width, so this one is A4
// LANDSCAPE. Same fixed-width rule as the drug table — registry titles and
// intervention lists are long free text and must never starve the columns.
export function buildTrialsPdfReport(trials: Trial[], meta: ReportMeta): jsPDF {
  const page = startPage('landscape');

  renderHeader(
    page,
    reportTitle(meta, 'trials'),
    generatedLine(meta, 'trials'),
    [scopeSentence(meta, (s) => s), phaseBucketsLine(meta)].filter((l): l is string => l !== null),
  );

  renderTable(
    page,
    TRIALS_TABLE_HEADERS,
    trials.map((t) => {
      const c = trialRowCells(t);
      return [c.nctId, c.title, c.tested, c.sponsor, c.phase, c.status, c.enrollment];
    }),
    7.5,
    {
      0: { cellWidth: 62 }, // NCT ID
      1: { cellWidth: 'auto' }, // Title — takes the remainder
      2: { cellWidth: 150 }, // What's tested
      3: { cellWidth: 120 }, // Sponsor
      4: { cellWidth: 58 }, // Phase
      5: { cellWidth: 75 }, // Status
      6: { cellWidth: 48, halign: 'right' }, // Enrollment
    },
  );

  appendFootnote(page, `Source. ${TRIALS_SOURCE_NOTE}`);
  return page.doc;
}
