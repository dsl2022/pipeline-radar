import type { BetaTool } from '@anthropic-ai/sdk/resources/beta';
import { clearFdaCache } from '@pipeline-radar/shared/drugs/openfda';
import type { Trial } from '@pipeline-radar/shared/types';
import { createTools, fitToBudget, stripUnsupported, RESULT_BUDGET_CHARS } from './tools';
import type { TrialData, TrialSet } from './data';

// What these prove is that the agent cannot state a number the tools did not
// compute, and cannot be handed more data than the turn budget allows. The
// FDA cases matter most: "unknown" and "investigational" are different claims
// about a real drug, and collapsing them turns a network blip into a false
// regulatory statement.

const trial = (over: Partial<Trial> = {}): Trial => ({
  nctId: 'NCT00000001',
  title: 'A study of something',
  status: 'RECRUITING',
  phases: ['PHASE2'],
  enrollment: 100,
  sponsor: 'Acme Onc',
  interventions: [{ type: 'DRUG', name: 'examplemab', otherNames: [] }],
  ...over,
});

const stubData = (
  set: Partial<TrialSet> & { trials: Trial[] },
  detail: unknown = {},
): TrialData => ({
  search: async () => ({ total: set.trials.length, sampled: false, ...set }),
  detail: async () => detail,
});

const toolsFor = (data: TrialData) => {
  const map = new Map(createTools(data).map((t) => [t.name, t]));
  return (name: string) => {
    const tool = map.get(name);
    if (!tool) throw new Error(`no tool named ${name}`);
    return tool;
  };
};

const call = async (data: TrialData, name: string, input: unknown) => {
  const tool = toolsFor(data)(name);
  return JSON.parse((await tool.run(input as never)) as string);
};

describe('tool surface', () => {
  const tools = createTools(stubData({ trials: [] }));

  it('exposes exactly the ten tools, in a stable order', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'search_trials',
      'summarize_trials',
      'build_drug_landscape',
      'check_fda_approval',
      'get_trial_detail',
      'get_adverse_events',
      'pubmed_count',
      'diff_watchlist',
      'set_view',
      'prepare_brief',
    ]);
  });

  // The tool block is part of the cached prefix; a set built twice must be
  // byte-identical or every turn pays full input price.
  it('builds an identical schema every time', () => {
    const again = createTools(stubData({ trials: [] }));
    expect(JSON.stringify(again)).toBe(JSON.stringify(tools));
  });

  it.each([
    'search_trials',
    'summarize_trials',
    'build_drug_landscape',
    'check_fda_approval',
    'get_trial_detail',
    'get_adverse_events',
    'pubmed_count',
    'diff_watchlist',
    'set_view',
    'prepare_brief',
  ])(
    '%s is strict and refuses unknown properties',
    (name) => {
      const tool = tools.find((t) => t.name === name)! as unknown as BetaTool;
      const schema = tool.input_schema as { additionalProperties?: boolean };
      expect(tool.strict).toBe(true);
      expect(schema.additionalProperties).toBe(false);
    },
  );

  it('rejects an input the schema does not allow before running', async () => {
    const tool = tools.find((t) => t.name === 'search_trials')!;
    expect(() => tool.parse({ condition: 'x' })).toThrow(); // min length 2 is enforced
    expect(() => tool.parse({ condition: 'lung cancer', limit: 5000 })).toThrow();
  });
});

describe('strict schemas carry only what the API accepts', () => {
  // Learned from a live 400: "For 'integer' type, properties maximum, minimum
  // are not supported". The SDK strips these for structured output schemas but
  // not for tool inputs, so a Zod .min()/.max() reaches the API and the whole
  // turn fails before a single token is generated.
  it('strips numeric and length constraints anywhere in the schema', () => {
    const schema = {
      type: 'object',
      properties: {
        n: { type: 'integer', minimum: 1, maximum: 50 },
        s: { type: 'string', minLength: 2, maxLength: 120 },
        a: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 4 } },
      },
      $defs: { nested: { type: 'integer', exclusiveMinimum: 0, multipleOf: 2 } },
    };
    stripUnsupported(schema);
    expect(JSON.stringify(schema)).not.toMatch(
      /minimum|maximum|minLength|maxLength|minItems|maxItems|multipleOf|uniqueItems/,
    );
  });

  it('leaves the parts of the schema the model needs', () => {
    const schema = {
      type: 'object',
      properties: { p: { type: 'string', enum: ['a', 'b'], description: 'pick one' } },
      required: ['p'],
    };
    stripUnsupported(schema);
    expect(schema.properties.p.enum).toEqual(['a', 'b']);
    expect(schema.properties.p.description).toBe('pick one');
    expect(schema.required).toEqual(['p']);
  });

  it('emits no unsupported keyword on any real tool', () => {
    const wire = JSON.stringify(
      createTools(stubData({ trials: [] })).map((t) => (t as unknown as BetaTool).input_schema),
    );
    expect(wire).not.toMatch(
      /minimum|maximum|minLength|maxLength|minItems|maxItems|multipleOf|uniqueItems/,
    );
  });

  // The constraints must still be enforced - they just cannot travel to the API.
  it('still rejects an out-of-range input client-side', () => {
    const tool = createTools(stubData({ trials: [] })).find((t) => t.name === 'search_trials')!;
    expect(() => tool.parse({ condition: 'lung cancer', limit: 9999 })).toThrow();
    expect(() => tool.parse({ condition: 'lung cancer', limit: 20 })).not.toThrow();
  });
});

describe('fitToBudget', () => {
  it('leaves a small payload alone', () => {
    const out = JSON.parse(fitToBudget({ rows: [{ a: 1 }] }));
    expect(out).toEqual({ rows: [{ a: 1 }] });
  });

  it('cuts to fit and says how much it cut', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ i, pad: 'x'.repeat(200) }));
    const text = fitToBudget({ rows });
    const out = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(RESULT_BUDGET_CHARS);
    // The point of the field: a truncation the model cannot see reads as
    // "that was all the data".
    expect(out.omitted_rows).toBe(2000 - out.rows.length);
    expect(out.rows.length).toBeGreaterThan(0);
  });

  it('keeps the non-row fields when it truncates', () => {
    const out = JSON.parse(
      fitToBudget({ matched_in_registry: 900, rows: Array.from({ length: 900 }, () => ({ pad: 'y'.repeat(300) })) }),
    );
    expect(out.matched_in_registry).toBe(900);
  });
});

describe('search_trials', () => {
  const many = [
    trial({ nctId: 'NCT01', phases: ['PHASE1'], sponsor: 'Beta Bio' }),
    trial({ nctId: 'NCT02', phases: ['PHASE3'], sponsor: 'Acme Onc' }),
    trial({ nctId: 'NCT03', phases: ['PHASE2'], sponsor: 'Acme Onc', status: 'RECRUITING' }),
  ];

  it('returns the highest phase first, regardless of registry order', async () => {
    const out = await call(stubData({ trials: many }), 'search_trials', { condition: 'lung cancer' });
    expect(out.rows.map((r: { nct_id: string }) => r.nct_id)).toEqual(['NCT02', 'NCT03', 'NCT01']);
  });

  it('honours the limit', async () => {
    const out = await call(stubData({ trials: many }), 'search_trials', { condition: 'lung cancer', limit: 1 });
    expect(out.rows).toHaveLength(1);
  });

  it('filters by phase and by sponsor substring', async () => {
    const byPhase = await call(stubData({ trials: many }), 'search_trials', {
      condition: 'lung cancer',
      phases: ['PHASE3'],
    });
    expect(byPhase.rows.map((r: { nct_id: string }) => r.nct_id)).toEqual(['NCT02']);

    const bySponsor = await call(stubData({ trials: many }), 'search_trials', {
      condition: 'lung cancer',
      sponsor_contains: 'acme',
    });
    expect(bySponsor.matched_after_filters).toBe(2);
  });

  // A figure derived from 500 of 4,000 trials is a sample, and an answer that
  // does not say so is wrong in a way the reader cannot detect.
  it('declares sampling when the registry holds more than was fetched', async () => {
    const out = await call(
      { search: async () => ({ trials: many, total: 4000, sampled: true }), detail: async () => ({}) },
      'search_trials',
      { condition: 'lung cancer' },
    );
    expect(out.matched_in_registry).toBe(4000);
    expect(out.analysed).toBe(3);
    expect(out.sampling_note).toMatch(/not all 4000/);
  });

  it('says nothing about sampling when the whole set was fetched', async () => {
    const out = await call(stubData({ trials: many }), 'search_trials', { condition: 'lung cancer' });
    expect(out.sampling_note).toBeUndefined();
  });
});

describe('summarize_trials', () => {
  it('counts by phase and by sponsor', async () => {
    const trials = [
      trial({ nctId: 'NCT01', phases: ['PHASE3'], sponsor: 'Acme Onc' }),
      trial({ nctId: 'NCT02', phases: ['PHASE3'], sponsor: 'Acme Onc' }),
      trial({ nctId: 'NCT03', phases: ['PHASE1'], sponsor: 'Beta Bio' }),
    ];
    const out = await call(stubData({ trials }), 'summarize_trials', { condition: 'lung cancer' });
    expect(out.by_phase).toEqual([
      { key: 'PHASE3', label: 'Phase 3', count: 2 },
      { key: 'PHASE1', label: 'Phase 1', count: 1 },
    ]);
    expect(out.rows[0]).toEqual({ sponsor: 'Acme Onc', trial_count: 2 });
  });
});

describe('build_drug_landscape', () => {
  it('rolls trials up to one row per drug', async () => {
    const trials = [
      trial({ nctId: 'NCT01', interventions: [{ type: 'DRUG', name: 'examplemab', otherNames: [] }] }),
      trial({ nctId: 'NCT02', interventions: [{ type: 'DRUG', name: 'Examplemab', otherNames: [] }] }),
      trial({ nctId: 'NCT03', interventions: [{ type: 'DRUG', name: 'otherdrug', otherNames: [] }] }),
    ];
    const out = await call(stubData({ trials }), 'build_drug_landscape', { condition: 'lung cancer' });
    const top = out.rows.find((r: { drug: string }) => /examplemab/i.test(r.drug));
    expect(top.trial_count).toBe(2);
    expect(top.example_nct_ids).toEqual(['NCT01', 'NCT02']);
  });

  it('reports what it threw out rather than hiding it', async () => {
    const trials = [
      trial({
        nctId: 'NCT01',
        interventions: [
          { type: 'DRUG', name: 'examplemab', otherNames: [] },
          { type: 'PROCEDURE', name: 'surgery', otherNames: [] },
        ],
      }),
    ];
    const out = await call(stubData({ trials }), 'build_drug_landscape', { condition: 'lung cancer' });
    expect(out).toHaveProperty('non_drug_interventions_excluded');
  });
});

describe('check_fda_approval', () => {
  const data = stubData({ trials: [] });
  const okJson = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    clearFdaCache();
    jest.restoreAllMocks();
  });

  it('reports an approval with its year and sponsor', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({
        meta: { results: { total: 1 } },
        results: [
          {
            application_number: 'BLA125514',
            sponsor_name: 'MERCK',
            submissions: [
              { submission_type: 'ORIG', submission_status: 'AP', submission_status_date: '20140904' },
            ],
            openfda: { generic_name: ['PEMBROLIZUMAB'], brand_name: ['KEYTRUDA'] },
          },
        ],
      }),
    );
    const out = await call(data, 'check_fda_approval', { drug: 'pembrolizumab' });
    expect(out.status).toBe('approved');
    expect(out.approval_year).toBe('2014');
    expect(out.application_number).toBe('BLA125514');
    expect(out.approval_year_is_approximate).toBe(false);
  });

  // Any generic in the matched set means the year is the earliest RECORD, not
  // the originator's approval. Stating it flatly would be a false precision.
  it('flags the approval year as approximate when a generic is in the set', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({
        meta: { results: { total: 2 } },
        results: [
          {
            application_number: 'ANDA090001',
            submissions: [
              { submission_type: 'ORIG', submission_status: 'AP', submission_status_date: '20010101' },
            ],
            openfda: { generic_name: ['CISPLATIN'] },
          },
          { application_number: 'NDA018057', openfda: { generic_name: ['CISPLATIN'] } },
        ],
      }),
    );
    const out = await call(data, 'check_fda_approval', { drug: 'cisplatin' });
    expect(out.approval_year_is_approximate).toBe(true);
  });

  it('reports investigational when the register definitively has no record', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
    const out = await call(data, 'check_fda_approval', { drug: 'examplemab' });
    expect(out.status).toBe('investigational');
  });

  // The negative that matters: a transport failure must not be reported as
  // "no approval record exists". Those are different claims about a real drug.
  it('reports unknown - never investigational - when the lookup fails', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const out = await call(data, 'check_fda_approval', { drug: 'examplemab' });
    expect(out.status).toBe('unknown');
    expect(out.status).not.toBe('investigational');
  });

  it('reports unknown when openFDA returns a server error', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const out = await call(data, 'check_fda_approval', { drug: 'examplemab' });
    expect(out.status).toBe('unknown');
  });

  it('rejects a name that canonicalises to nothing', async () => {
    const out = await call(data, 'check_fda_approval', { drug: '...' });
    expect(out.status).toBe('unknown');
  });
});

// --- the copilot layer (PR 9) ------------------------------------------------

import { runInTurnScope } from './turn-scope';
import { verifyBriefToken } from './brief';
import type { Pubmed } from './pubmed';

const collectEmit = () => {
  const events: { event: string; data: unknown }[] = [];
  return { events, emit: (event: string, data: unknown) => events.push({ event, data }) };
};

const callInScope = async (
  data: TrialData,
  name: string,
  input: unknown,
  scope: { context?: Record<string, unknown>; emit: (e: string, d: unknown) => void },
  extras: Parameters<typeof createTools>[1] = {},
) => {
  const tool = createTools(data, extras).find((t) => t.name === name)!;
  return runInTurnScope(scope as never, async () => JSON.parse((await tool.run(input as never)) as string));
};

describe('get_trial_detail', () => {
  it('shapes the protocol section and refuses malformed IDs at the schema', async () => {
    const detail = {
      protocolSection: {
        identificationModule: { briefTitle: 'A deep study' },
        statusModule: { overallStatus: 'RECRUITING', startDateStruct: { date: '2025-01' } },
        designModule: { phases: ['PHASE3'], enrollmentInfo: { count: 420 }, studyType: 'INTERVENTIONAL' },
        sponsorCollaboratorsModule: { leadSponsor: { name: 'Acme Onc' } },
        descriptionModule: { briefSummary: 'Why this trial exists.' },
        armsInterventionsModule: { interventions: [{ type: 'DRUG', name: 'examplemab', description: 'the drug' }] },
      },
    };
    const out = await call(stubData({ trials: [] }, detail), 'get_trial_detail', { nct_id: 'NCT01234567' });
    expect(out.title).toBe('A deep study');
    expect(out.phases).toEqual(['PHASE3']);
    expect(out.enrollment).toBe(420);
    expect(out.rows).toEqual([{ type: 'DRUG', name: 'examplemab', description: 'the drug' }]);

    const tool = createTools(stubData({ trials: [] }))!.find((t) => t.name === 'get_trial_detail')!;
    expect(() => tool.parse({ nct_id: 'NCT123' })).toThrow();
    expect(() => tool.parse({ nct_id: 'https://evil.example.com' })).toThrow();
  });
});

describe('get_adverse_events', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    clearFdaCache();
  });

  it('returns report counts with the incidence caveat', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: [{ term: 'NAUSEA', count: 12 }] }), { status: 200 }) as never,
    );
    const out = await call(stubData({ trials: [] }), 'get_adverse_events', { drug: 'examplemab' });
    expect(out.rows).toEqual([{ reaction: 'NAUSEA', reports: 12 }]);
    expect(out.caveat).toMatch(/not incidence/i);
  });
});

describe('pubmed_count', () => {
  it('reports the count from the pubmed client', async () => {
    const pubmed: Pubmed = { count: async () => 1234 };
    const out = await call(
      { ...stubData({ trials: [] }) },
      'pubmed_count',
      { term: 'examplemab AND melanoma' },
    ).catch(() => null);
    // Without extras the tool must say so rather than guessing.
    expect(out.status).toBe('unavailable');

    const tool = createTools(stubData({ trials: [] }), { pubmed }).find((t) => t.name === 'pubmed_count')!;
    const withClient = JSON.parse((await tool.run({ term: 'examplemab' } as never)) as string);
    expect(withClient.article_count).toBe(1234);
  });
});

describe('diff_watchlist', () => {
  it('returns the client-supplied diff from the turn scope', async () => {
    const { emit } = collectEmit();
    const out = await callInScope(
      stubData({ trials: [] }),
      'diff_watchlist',
      {},
      { context: { watchlistDiff: { has_changes: true, added: ['x'] } }, emit },
    );
    expect(out.status).toBe('ok');
    expect(out.diff).toEqual({ has_changes: true, added: ['x'] });
  });

  it('says no_watchlist when the turn carries none', async () => {
    const out = await call(stubData({ trials: [] }), 'diff_watchlist', {});
    expect(out.status).toBe('no_watchlist');
  });
});

describe('set_view', () => {
  it('forwards the command to the browser and reports what was applied', async () => {
    const { events, emit } = collectEmit();
    const out = await callInScope(
      stubData({ trials: [] }),
      'set_view',
      { view: 'drugs', phases: ['PHASE3'] },
      { emit },
    );
    expect(out).toEqual({ status: 'applied', applied: { view: 'drugs', phases: ['PHASE3'] } });
    expect(events).toEqual([{ event: 'view', data: { view: 'drugs', phases: ['PHASE3'] } }]);
  });

  it('does nothing on an empty command', async () => {
    const { events, emit } = collectEmit();
    const out = await callInScope(stubData({ trials: [] }), 'set_view', {}, { emit });
    expect(out.status).toBe('noop');
    expect(events).toEqual([]);
  });
});

describe('prepare_brief', () => {
  const SECRET = 'brief-secret';
  const T0 = 1_756_000_000_000;

  afterEach(() => {
    jest.restoreAllMocks();
    clearFdaCache();
  });

  it('sends the preview and token to the browser, never to the model', async () => {
    // openFDA badge lookups inside the brief resolve to "no record".
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }) as never);

    const { events, emit } = collectEmit();
    const out = await callInScope(
      stubData({ trials: [trial()] }),
      'prepare_brief',
      { condition: 'melanoma' },
      { emit },
      { briefSecret: SECRET, now: () => T0 },
    );

    expect(out.status).toBe('preview_shown');
    expect(JSON.stringify(out)).not.toContain('token');

    const brief = events.find((e) => e.event === 'brief')!.data as {
      filename: string;
      markdown: string;
      token: string;
    };
    expect(brief.filename).toMatch(/\.md$/);
    expect(brief.markdown).toMatch(/melanoma/i);
    // The token the browser got commits exactly this content.
    expect(verifyBriefToken(brief.markdown, brief.token, SECRET, T0)).toBe(true);
    expect(verifyBriefToken(brief.markdown + 'x', brief.token, SECRET, T0)).toBe(false);
  });

  it('reports itself unavailable without a signing secret', async () => {
    const { emit } = collectEmit();
    const out = await callInScope(stubData({ trials: [trial()] }), 'prepare_brief', { condition: 'melanoma' }, { emit });
    expect(out.status).toBe('unavailable');
  });
});
