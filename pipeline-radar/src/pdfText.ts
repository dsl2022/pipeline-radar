// jsPDF's built-in fonts are WinAnsi (CP1252): registry free text routinely
// carries characters outside that ("interferon β-1a", "α-lipoic acid", CJK
// sponsor names) which the PDF would render as mojibake while the UTF-8
// .md/.html exports stay correct. Everything PDF-bound passes through
// winAnsiSafe: transliterate what has a faithful ASCII reading, replace the
// rest with '?' — a visible, honest degradation instead of garbage glyphs.
// (Kept free of jspdf imports so it stays unit-testable.)

// Greek letters are the common case in drug names.
const TRANSLITERATE: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta',
  η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu',
  ν: 'nu', ξ: 'xi', π: 'pi', ρ: 'rho', σ: 'sigma', τ: 'tau',
  υ: 'upsilon', φ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
  Α: 'Alpha', Β: 'Beta', Γ: 'Gamma', Δ: 'Delta', Ω: 'Omega',
};

// Unicode punctuation jsPDF maps into CP1252's 0x80–0x9F block — these render
// correctly and must pass through untouched (em dash, curly quotes, bullet, …).
const CP1252_MAPPED = new Set(
  'ŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™',
);

export function winAnsiSafe(s: string): string {
  return s.replace(/[^\x00-\xFF]/g, (ch) =>
    CP1252_MAPPED.has(ch) ? ch : (TRANSLITERATE[ch] ?? '?'),
  );
}
