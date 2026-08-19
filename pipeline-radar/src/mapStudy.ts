import type { Trial } from './types';

// The raw API shape is deeply nested and every field is optional in practice —
// this is the ONLY module allowed to touch it.
export interface RawStudy {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string };
    statusModule?: { overallStatus?: string };
    designModule?: { phases?: string[]; enrollmentInfo?: { count?: number } };
    sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } };
    armsInterventionsModule?: {
      interventions?: { type?: string; name?: string; otherNames?: string[] }[];
    };
  };
}

export function mapStudy(study: RawStudy): Trial {
  const p = study.protocolSection ?? {};
  const interventions = p.armsInterventionsModule?.interventions ?? [];
  return {
    nctId: p.identificationModule?.nctId ?? '',
    title: p.identificationModule?.briefTitle ?? '(untitled)',
    status: p.statusModule?.overallStatus ?? 'UNKNOWN',
    phases: p.designModule?.phases ?? [],
    enrollment: p.designModule?.enrollmentInfo?.count ?? null,
    sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name ?? 'Unknown',
    interventions: interventions.map((i) => ({
      type: i.type ?? 'OTHER',
      name: i.name ?? '(unnamed)',
      otherNames: i.otherNames ?? [], // synonym goldmine for milestone 3
    })),
  };
}

const STATUS_LABELS: Record<string, string> = {
  RECRUITING: 'Recruiting',
  ACTIVE_NOT_RECRUITING: 'Active, not recruiting',
  NOT_YET_RECRUITING: 'Not yet recruiting',
  ENROLLING_BY_INVITATION: 'Enrolling by invitation',
  COMPLETED: 'Completed',
  TERMINATED: 'Terminated',
  SUSPENDED: 'Suspended',
  WITHDRAWN: 'Withdrawn',
  UNKNOWN: 'Unknown',
};

export function formatStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function formatPhases(phases: string[]): string {
  const real = phases.filter((ph) => ph !== 'NA');
  if (real.length === 0) return 'N/A';
  return real.map((ph) => ph.replace('PHASE', 'Phase ').replace('EARLY_', 'Early ')).join(', ');
}
