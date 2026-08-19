// Pure string layer for the drug rollup (milestone 3). Every regex here was
// validated against 2,000 real intervention names — see research/DATA-RESEARCH.md §2.2
// before changing anything.

// Words that describe how a drug is given, not what it is.
const ROUTE_FORM =
  /\b(injection|tablet|capsule|oral|solution|infusion|intravenous|subcutaneous|topical|cream|ointment|gel|patch|iv|sc)\b/g;

// "80 mg", "4.5mg/kg", "100 IU" … dose tokens carry no identity.
const DOSE = /\b\d+(\.\d+)?\s*(mg|mcg|ug|g|ml|%|iu|units?)(\/(m2|kg|ml|day|dose))?\b/g;

// Sponsor research codes: "MK-3475", "PF-07934040", "AB-106", "SCH 900475".
const RESEARCH_CODE = /^[A-Z]{1,5}[- ]?\d{2,8}[A-Za-z]?$/;

// Category/comparator terms that must never become a drug row. Includes the
// measured leaks (steroid) and the deliberate scope cuts (vaccine, cells → CAR-T).
const CATEGORY =
  /\b(chemotherapy|chemoradiotherapy|immunotherapy|radiotherapy|radiation|surgery|placebo|sham|vehicle|standard of care|soc|best supportive care|targeted therapy|physician s choice|investigator s choice|treatment|therapy|therapies|regimen|platinum|doublet|steroid|vaccine|cells?)\b/;

// Combo detectors: "+", "plus", "and", "with", word/word (but not 80mg/40mg).
const COMBO_MARKER = /[+]|\bplus\b|\bin combination with\b|\bcombined with\b|\band\b|\bwith\b/i;
const WORD_SLASH = /[a-z]\s*\/\s*[a-z]/i;
const DIGIT_SLASH = /\d\s*\/\s*\d/;
// Longer phrases first so "in combination with" wins over bare "with". "or" splits
// alternatives ("Cisplatin or Carboplatin") but is NOT a combo marker on its own.
const COMBO_SPLIT =
  /\s*(?:\+|\/|\bin combination with\b|\bcombined with\b|\bplus\b|\band\b|\bwith\b|\bor\b|,)\s*/i;

/** Canonical lowercase form for matching: strips glyphs, parentheticals, route/form words, doses. */
export function canon(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[®™©]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(ROUTE_FORM, ' ')
    .replace(DOSE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cluster key: canon with spaces squashed, so "MK 3475" ≡ "MK-3475" ≡ "mk3475". */
export function nameKey(s: string): string {
  return canon(s).replace(/ /g, '');
}

export function isResearchCode(s: string): boolean {
  return RESEARCH_CODE.test(s.trim());
}

export function isCombo(s: string): boolean {
  return COMBO_MARKER.test(s) || (WORD_SLASH.test(s) && !DIGIT_SLASH.test(s));
}

/** Split a combo-flagged name into canon'd component parts (empties dropped). */
export function splitCombo(s: string): string[] {
  return s
    .split(COMBO_SPLIT)
    .map(canon)
    .filter((p) => p.length > 0);
}

/** Takes the CANON form (not the raw name). */
export function isCategoryTerm(canonForm: string): boolean {
  return CATEGORY.test(canonForm);
}
