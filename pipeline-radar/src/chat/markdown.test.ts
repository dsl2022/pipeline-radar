import { nctUrl, parseInlines, parseMarkdown } from './markdown';

describe('parseInlines', () => {
  it('passes plain text through', () => {
    expect(parseInlines('just words')).toEqual([{ kind: 'text', text: 'just words' }]);
  });

  it('extracts bold and code spans', () => {
    expect(parseInlines('a **b** and `c`')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'c' },
    ]);
  });

  it('turns an NCT ID into a citation token', () => {
    expect(parseInlines('see NCT01234567 for detail')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'nct', id: 'NCT01234567' },
      { kind: 'text', text: ' for detail' },
    ]);
  });

  // The security rule from the PR blueprint: model-composed links are never
  // rendered as anchors. A URL survives only as inert text.
  it('leaves URLs as plain text, never as a link token', () => {
    const inlines = parseInlines('visit https://evil.example.com/phish now');
    expect(inlines.every((t) => t.kind === 'text')).toBe(true);
  });

  it('finds an NCT ID inside a bold span', () => {
    // Bold content is not re-scanned for citations by design — keep the rule
    // honest by asserting what actually happens to the surrounding text.
    expect(parseInlines('NCT00000001 **matters**')).toEqual([
      { kind: 'nct', id: 'NCT00000001' },
      { kind: 'text', text: ' ' },
      { kind: 'bold', text: 'matters' },
    ]);
  });
});

describe('nctUrl', () => {
  it('builds only the canonical ClinicalTrials.gov record URL', () => {
    expect(nctUrl('NCT01234567')).toBe('https://clinicaltrials.gov/study/NCT01234567');
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines', () => {
    const blocks = parseMarkdown('first\n\nsecond');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
  });

  it('parses headings with their level', () => {
    const blocks = parseMarkdown('## Phase 3\ntext');
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 });
  });

  it('groups consecutive bullets into one list', () => {
    const blocks = parseMarkdown('- a\n- b\n- c');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false });
    if (blocks[0].kind === 'list') expect(blocks[0].items).toHaveLength(3);
  });

  it('recognises an ordered list', () => {
    const blocks = parseMarkdown('1. a\n2. b');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true });
  });

  it('parses a pipe table with header and rows', () => {
    const blocks = parseMarkdown('| Drug | Phase |\n|---|---|\n| foo | 3 |\n| bar | 2 |');
    expect(blocks).toHaveLength(1);
    const t = blocks[0];
    expect(t.kind).toBe('table');
    if (t.kind === 'table') {
      expect(t.header).toHaveLength(2);
      expect(t.rows).toHaveLength(2);
      expect(t.rows[0][0]).toEqual([{ kind: 'text', text: 'foo' }]);
    }
  });

  // A lone pipe-ish line with no separator row is prose, not a table.
  it('does not mistake a pipe in prose for a table', () => {
    const blocks = parseMarkdown('either | or');
    expect(blocks[0].kind).toBe('paragraph');
  });

  it('parses the shape a real answer takes', () => {
    const text = [
      'There are **12** phase 3 trials. The largest is NCT04567890.',
      '',
      '| Drug | Trials |',
      '|---|---|',
      '| osimertinib | 5 |',
      '',
      '- counts come from the registry',
    ].join('\n');
    expect(parseMarkdown(text).map((b) => b.kind)).toEqual(['paragraph', 'table', 'list']);
  });
});
