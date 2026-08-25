import { applyEvent, emptyAssistant, historyFrom, type Msg } from './turns';

const doneAssistant = (text: string): Msg => ({
  role: 'assistant',
  text,
  thinking: '',
  tools: [],
  streaming: false,
});

describe('applyEvent', () => {
  it('accumulates deltas into the text', () => {
    let m = emptyAssistant();
    m = applyEvent(m, { event: 'delta', data: { text: 'The answer ' } });
    m = applyEvent(m, { event: 'delta', data: { text: 'is 12.' } });
    expect(m.text).toBe('The answer is 12.');
  });

  it('keeps thinking separate from the answer', () => {
    let m = emptyAssistant();
    m = applyEvent(m, { event: 'thinking', data: { text: 'weighing' } });
    expect(m.text).toBe('');
    expect(m.thinking).toBe('weighing');
  });

  it('collects tool names in call order', () => {
    let m = emptyAssistant();
    m = applyEvent(m, { event: 'tool', data: { name: 'search_trials' } });
    m = applyEvent(m, { event: 'tool', data: { name: 'summarize_trials' } });
    expect(m.tools).toEqual(['search_trials', 'summarize_trials']);
  });

  it('records notices and errors', () => {
    let m = emptyAssistant();
    m = applyEvent(m, { event: 'notice', data: { text: 'cut short' } });
    m = applyEvent(m, { event: 'error', data: { message: 'failed' } });
    expect(m.notice).toBe('cut short');
    expect(m.error).toBe('failed');
  });

  it('attaches a brief card, and ignores one missing its token', () => {
    const withCard = applyEvent(emptyAssistant(), {
      event: 'brief',
      data: { filename: 'melanoma-brief.md', markdown: '# Brief', token: 'exp.mac' },
    });
    expect(withCard.brief).toEqual({ filename: 'melanoma-brief.md', markdown: '# Brief', token: 'exp.mac' });

    const malformed = applyEvent(emptyAssistant(), { event: 'brief', data: { markdown: '# Brief' } });
    expect(malformed.brief).toBeUndefined();
  });

  it('marks the message finished on done', () => {
    const m = applyEvent(emptyAssistant(), { event: 'done', data: { stop: 'end_turn' } });
    expect(m.streaming).toBe(false);
  });

  it('ignores events that carry no message content', () => {
    const m = applyEvent(emptyAssistant(), { event: 'open', data: { sessionId: 'abc' } });
    expect(m).toEqual(emptyAssistant());
  });
});

describe('historyFrom', () => {
  it('pairs completed exchanges in order', () => {
    const msgs: Msg[] = [
      { role: 'user', text: 'q1' },
      doneAssistant('a1'),
      { role: 'user', text: 'q2' },
      doneAssistant('a2'),
    ];
    expect(historyFrom(msgs)).toEqual([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: 'a2' },
    ]);
  });

  // A failed turn has nothing for the model to remember, and its user half
  // alone would break the alternating shape the server enforces.
  it('drops a failed exchange as a pair', () => {
    const failed = { ...doneAssistant(''), error: 'boom' };
    const msgs: Msg[] = [
      { role: 'user', text: 'q1' },
      failed,
      { role: 'user', text: 'q2' },
      doneAssistant('a2'),
    ];
    expect(historyFrom(msgs)).toEqual([
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: 'a2' },
    ]);
  });

  it('excludes the exchange still streaming', () => {
    const msgs: Msg[] = [
      { role: 'user', text: 'q1' },
      doneAssistant('a1'),
      { role: 'user', text: 'q2' },
      emptyAssistantWithText('partial'),
    ];
    expect(historyFrom(msgs)).toEqual([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
    ]);
  });

  it('sends an empty history for the first question', () => {
    expect(historyFrom([])).toEqual([]);
  });
});

function emptyAssistantWithText(text: string): Msg {
  return { role: 'assistant', text, thinking: '', tools: [], streaming: true };
}
