import { winAnsiSafe } from './pdfText';

// jsPDF's built-in fonts are WinAnsi — winAnsiSafe is the gate that keeps
// registry free text (Greek letters, CJK) from rendering as mojibake in the
// PDF export while the UTF-8 .md/.html of the same landscape stay verbatim.

describe('winAnsiSafe', () => {
  it('transliterates Greek letters common in drug names', () => {
    expect(winAnsiSafe('interferon β-1a')).toBe('interferon beta-1a');
    expect(winAnsiSafe('α-lipoic acid')).toBe('alpha-lipoic acid');
    expect(winAnsiSafe('TNF-α blocker')).toBe('TNF-alpha blocker');
  });

  it('keeps Latin-1 and CP1252-mapped punctuation untouched', () => {
    const s = 'Approved · records since 2004 — “Café” … ±5 µg'; // µ is Latin-1 (0xB5)
    expect(winAnsiSafe(s)).toBe(s);
    expect(winAnsiSafe('naïve — ‘quoted’ • €50™')).toBe('naïve — ‘quoted’ • €50™');
  });

  it('replaces unmappable characters with ? instead of mojibake', () => {
    expect(winAnsiSafe('新薬')).toBe('??');
    expect(winAnsiSafe('a→b')).toBe('a?b');
  });

  it('passes plain ASCII through unchanged', () => {
    expect(winAnsiSafe('Pembrolizumab 200mg IV')).toBe('Pembrolizumab 200mg IV');
  });
});
