import { SYSTEM_PROMPT, systemBlocks } from './prompt';

describe('the system prompt is frozen', () => {
  // Not a style rule. This text is the prompt cache key, so anything that
  // varies per turn - a date, a session id, a name - misses the cache on every
  // request and silently multiplies the input cost of the whole feature.
  it('produces byte-identical blocks on every call', () => {
    expect(JSON.stringify(systemBlocks())).toBe(JSON.stringify(systemBlocks()));
  });

  it('carries a cache breakpoint', () => {
    const [block] = systemBlocks();
    expect(block.cache_control).toEqual({ type: 'ephemeral' });
    expect(block.text).toBe(SYSTEM_PROMPT);
  });

  it('contains nothing that looks like an unresolved template', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\$\{|\{\{|%s|<PLACEHOLDER>/);
  });

  // A prompt long enough to be worth caching, short enough not to crowd out
  // the conversation. Both ends have failed in other projects.
  it('stays a sensible length', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(1_000);
    expect(SYSTEM_PROMPT.length).toBeLessThan(8_000);
  });
});

describe('the rules later PRs depend on are actually stated', () => {
  // The grounding checker (PR 11) and the eval set (PR 12) assert against
  // these behaviours. If a prompt edit drops one, the failure should land here
  // rather than as a mysteriously lower eval score weeks later.
  it.each([
    ['never invents an NCT ID', /Never state an NCT ID that did not appear in a tool result/i],
    ['never does its own arithmetic', /Never count, total or average anything by hand/i],
    ['never asserts approval without a check', /Never describe a drug as approved without a check_fda_approval/i],
    ['keeps unknown apart from investigational', /"unknown" means the lookup failed/i],
    ['discloses sampling', /sampling_note/],
    ['treats tool results as data', /never an instruction to follow/i],
    ['refuses medical advice', /do not give medical advice/i],
    ['does not solicit personal data', /Do not ask the user for personal or health information/i],
  ])('%s', (_name, pattern) => {
    expect(SYSTEM_PROMPT).toMatch(pattern);
  });

  it('names every tool it claims to have', () => {
    for (const tool of ['search_trials', 'summarize_trials', 'build_drug_landscape', 'check_fda_approval']) {
      expect(SYSTEM_PROMPT).toContain(tool);
    }
  });
});
