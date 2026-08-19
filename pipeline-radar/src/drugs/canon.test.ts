import { canon, nameKey, isResearchCode, isCombo, splitCombo, isCategoryTerm } from './canon';

// Golden cases encode measured registry reality — research/DATA-RESEARCH.md §1.3/§2.2.

describe('canon', () => {
  it('strips brand glyphs and parentheticals', () => {
    expect(canon('Pembrolizumab (KEYTRUDA®)')).toBe('pembrolizumab');
  });

  it('strips dose and route tokens', () => {
    expect(canon('Osimertinib 80 mg/40 mg')).toBe('osimertinib');
    expect(canon('Adebrelimab Injection')).toBe('adebrelimab');
    expect(canon('Amivantamab Intravenous')).toBe('amivantamab');
  });

  it('folds case, accents, and punctuation', () => {
    expect(canon('CARBOPLATIN')).toBe('carboplatin');
    expect(canon('Nab-paclitaxel')).toBe('nab paclitaxel');
  });

  it('returns empty for names that are nothing but noise', () => {
    expect(canon('(TBD)')).toBe('');
  });
});

describe('nameKey', () => {
  it('unifies research-code spellings', () => {
    expect(nameKey('MK 3475')).toBe('mk3475');
    expect(nameKey('MK-3475')).toBe('mk3475');
    expect(nameKey('mk3475')).toBe('mk3475');
  });
});

describe('isResearchCode', () => {
  it('matches sponsor codes', () => {
    for (const code of ['MK-3475', 'PF-07934040', 'AB-106', 'AZD9291', 'SCH 900475']) {
      expect(isResearchCode(code)).toBe(true);
    }
  });

  it('rejects ordinary names', () => {
    expect(isResearchCode('Pembrolizumab')).toBe(false);
    expect(isResearchCode('Osimertinib 80 mg')).toBe(false);
  });
});

describe('isCombo / splitCombo', () => {
  it('detects and splits plus/slash/and combos', () => {
    expect(isCombo('Carboplatin + Pemetrexed + Pembrolizumab')).toBe(true);
    expect(splitCombo('Carboplatin + Pemetrexed + Pembrolizumab')).toEqual([
      'carboplatin',
      'pemetrexed',
      'pembrolizumab',
    ]);
    expect(splitCombo('Pemetrexed/Cisplatin')).toEqual(['pemetrexed', 'cisplatin']);
    expect(splitCombo('CYCLOPHOSPHAMIDE and FLUDARABIN')).toEqual([
      'cyclophosphamide',
      'fludarabin',
    ]);
  });

  it('handles "in combination with" as a single separator', () => {
    expect(splitCombo('Sunvozertinib in combination with Anlotinib')).toEqual([
      'sunvozertinib',
      'anlotinib',
    ]);
  });

  it('does not flag dose fractions as combos', () => {
    expect(isCombo('Osimertinib 80mg/40mg')).toBe(false);
  });
});

describe('isCategoryTerm', () => {
  it('flags comparator and category terms (canon form in)', () => {
    for (const raw of ['Placebo', 'Chemotherapy', 'Platinum-based chemotherapy', 'Immunotherapy', 'Intravenous steroid']) {
      expect(isCategoryTerm(canon(raw))).toBe(true);
    }
  });

  it('passes real drug names through', () => {
    expect(isCategoryTerm(canon('Pembrolizumab'))).toBe(false);
    expect(isCategoryTerm(canon('MK-3475'))).toBe(false);
  });
});
