import { mapStudy, formatPhases, formatStatus, type RawStudy } from './mapStudy';
import sample from './samples/lung-cancer.json';

describe('mapStudy', () => {
  const fullStudy: RawStudy = {
    protocolSection: {
      identificationModule: { nctId: 'NCT12345678', briefTitle: 'A Trial' },
      statusModule: { overallStatus: 'RECRUITING' },
      designModule: { phases: ['PHASE2', 'PHASE3'], enrollmentInfo: { count: 120 } },
      sponsorCollaboratorsModule: { leadSponsor: { name: 'Merck' } },
      armsInterventionsModule: {
        interventions: [
          { type: 'DRUG', name: 'Pembrolizumab', otherNames: ['MK-3475', 'Keytruda'] },
        ],
      },
    },
  };

  it('maps a fully-populated study', () => {
    expect(mapStudy(fullStudy)).toEqual({
      nctId: 'NCT12345678',
      title: 'A Trial',
      status: 'RECRUITING',
      phases: ['PHASE2', 'PHASE3'],
      enrollment: 120,
      sponsor: 'Merck',
      interventions: [{ type: 'DRUG', name: 'Pembrolizumab', otherNames: ['MK-3475', 'Keytruda'] }],
    });
  });

  it('survives a completely empty study with safe fallbacks', () => {
    expect(mapStudy({})).toEqual({
      nctId: '',
      title: '(untitled)',
      status: 'UNKNOWN',
      phases: [],
      enrollment: null,
      sponsor: 'Unknown',
      interventions: [],
    });
  });

  it('defaults missing otherNames to an empty array', () => {
    const study: RawStudy = {
      protocolSection: {
        armsInterventionsModule: { interventions: [{ type: 'RADIATION', name: 'Chemoradiotherapy' }] },
      },
    };
    expect(mapStudy(study).interventions[0].otherNames).toEqual([]);
  });

  it('maps every study in the real saved sample without throwing', () => {
    const studies = (sample as { studies: RawStudy[] }).studies;
    expect(studies.length).toBeGreaterThan(0);
    const trials = studies.map(mapStudy);
    for (const t of trials) {
      expect(t.nctId).toMatch(/^NCT\d{8}$/);
      expect(Array.isArray(t.phases)).toBe(true);
      expect(Array.isArray(t.interventions)).toBe(true);
    }
  });
});

describe('formatPhases', () => {
  it('renders N/A for empty array', () => {
    expect(formatPhases([])).toBe('N/A');
  });

  it('renders N/A for ["NA"]', () => {
    expect(formatPhases(['NA'])).toBe('N/A');
  });

  it('renders a single phase', () => {
    expect(formatPhases(['PHASE3'])).toBe('Phase 3');
  });

  it('renders multi-phase trials joined', () => {
    expect(formatPhases(['PHASE2', 'PHASE3'])).toBe('Phase 2, Phase 3');
  });

  it('renders early phase 1', () => {
    expect(formatPhases(['EARLY_PHASE1'])).toBe('Early Phase 1');
  });
});

describe('formatStatus', () => {
  it('humanizes known enums', () => {
    expect(formatStatus('ACTIVE_NOT_RECRUITING')).toBe('Active, not recruiting');
    expect(formatStatus('RECRUITING')).toBe('Recruiting');
  });

  it('passes unknown enums through unchanged', () => {
    expect(formatStatus('SOME_NEW_STATUS')).toBe('SOME_NEW_STATUS');
  });
});
