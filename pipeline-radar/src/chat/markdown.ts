// Minimal markdown for assistant replies, parsed to data rather than HTML.
//
// The renderer builds React elements from these blocks, so no model output is
// ever interpreted as markup. Deliberately small: the system prompt asks for
// tight prose, short tables and inline NCT IDs, and that is what this covers —
// paragraphs, headings, lists, pipe tables, bold, inline code.
//
// Links are the one security-relevant rule (MILESTONE-6-PR-PLAN.md PR 8):
// model-composed URLs are NEVER turned into anchors. The only links rendered
// are the ones we construct ourselves from a detected NCT ID, pointing at the
// canonical ClinicalTrials.gov record. A URL in the text stays inert text.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'nct'; id: string };

export type Block =
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] };

const NCT_ID = /NCT\d{8}/g;

/** The one URL shape the UI will link to - built from the ID, never from text. */
export function nctUrl(id: string): string {
  return `https://clinicaltrials.gov/study/${id}`;
}

function pushText(out: Inline[], text: string) {
  if (text.length === 0) return;
  NCT_ID.lastIndex = 0;
  let at = 0;
  for (const m of text.matchAll(NCT_ID)) {
    if (m.index! > at) out.push({ kind: 'text', text: text.slice(at, m.index) });
    out.push({ kind: 'nct', id: m[0] });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
}

export function parseInlines(text: string): Inline[] {
  const out: Inline[] = [];
  // Code spans first (their content is verbatim), then bold, then NCT IDs
  // inside whatever plain text remains.
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/);
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      out.push({ kind: 'code', text: part.slice(1, -1) });
    } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      out.push({ kind: 'bold', text: part.slice(2, -2) });
    } else {
      pushText(out, part);
    }
  }
  return out;
}

const LIST_ITEM = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_RULE = /^\s*\|?[\s:|-]+\|?\s*$/;

function splitRow(line: string): Inline[][] {
  const m = line.match(TABLE_ROW);
  const inner = m ? m[1] : line;
  return inner.split('|').map((cell) => parseInlines(cell.trim()));
}

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, inlines: parseInlines(heading[2]) });
      i += 1;
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const header = splitRow(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const ordered = /^\s*\d+\./.test(line);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM);
        if (!m) break;
        items.push(parseInlines(m[1]));
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // Paragraph: consecutive non-blank lines that are not any structure above.
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !LIST_ITEM.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !(TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', inlines: parseInlines(para.join('\n')) });
  }

  return blocks;
}
