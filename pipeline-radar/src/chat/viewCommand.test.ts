import { applyViewCommand, type ViewState } from './viewCommand';

// The copilot's accept criterion (MILESTONE-6-PR-PLAN.md PR 9): assert the
// RESULTING view-state object, not any reply text. An agent that says it
// filtered but produced no state change fails here.

const base: ViewState = { disease: 'lung cancer', view: 'trials', phases: [], statuses: [] };

describe('applyViewCommand', () => {
  it('applies filters and view switch to the state object', () => {
    const out = applyViewCommand(base, { view: 'drugs', phases: ['PHASE3'], statuses: ['RECRUITING'] });
    expect(out.state).toEqual({
      disease: 'lung cancer',
      view: 'drugs',
      phases: ['PHASE3'],
      statuses: ['RECRUITING'],
    });
    expect(out.searchNeeded).toBe(false);
    expect(out.changed).toBe(true);
  });

  it('changes the disease and requests a fresh search', () => {
    const out = applyViewCommand(base, { condition: 'melanoma' });
    expect(out.state.disease).toBe('melanoma');
    expect(out.searchNeeded).toBe(true);
  });

  it('treats the same disease as no search', () => {
    const out = applyViewCommand(base, { condition: 'lung cancer' });
    expect(out.searchNeeded).toBe(false);
    expect(out.changed).toBe(false);
  });

  it('clears a filter on an explicit empty array', () => {
    const filtered = { ...base, phases: ['PHASE3'] };
    const out = applyViewCommand(filtered, { phases: [] });
    expect(out.state.phases).toEqual([]);
    expect(out.changed).toBe(true);
  });

  it('leaves omitted fields untouched', () => {
    const filtered = { ...base, phases: ['PHASE3'], view: 'drugs' as const };
    const out = applyViewCommand(filtered, { statuses: ['RECRUITING'] });
    expect(out.state.phases).toEqual(['PHASE3']);
    expect(out.state.view).toBe('drugs');
  });

  // The command crosses the network; malformed shapes must leave the app
  // exactly as it was, never half-applied.
  it.each([
    ['a non-object', 'drugs'],
    ['null', null],
    ['an unknown phase key', { phases: ['PHASE9'] }],
    ['a non-string phase entry', { phases: [3] }],
    ['an unknown view', { view: 'dashboard' }],
    ['a too-short condition', { condition: 'x' }],
    ['a junk-mixed status list', { statuses: ['RECRUITING', 'JUNK'] }],
  ])('ignores %s', (_name, command) => {
    const out = applyViewCommand(base, command);
    expect(out.state).toEqual(base);
    expect(out.changed).toBe(false);
  });

  it('applies the valid fields of a partially valid command', () => {
    const out = applyViewCommand(base, { view: 'drugs', phases: ['NOT_A_PHASE'] });
    expect(out.state.view).toBe('drugs');
    expect(out.state.phases).toEqual([]); // untouched, not cleared
    expect(out.changed).toBe(true);
  });
});
