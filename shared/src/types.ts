export interface Intervention {
  type: string;
  name: string;
  otherNames: string[];
}

export interface Trial {
  nctId: string;
  title: string;
  status: string;
  phases: string[];
  enrollment: number | null;
  sponsor: string;
  interventions: Intervention[];
}

export interface SearchResult {
  trials: Trial[];
  total: number;
  nextPageToken?: string;
}
