import { InMemorySpanExporter, createTelemetry, NOOP_TELEMETRY } from './telemetry';

// What matters here is the tree and the degrade path: spans must parent to
// the turn, and a missing backend must cost the turn nothing.

const harness = () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = createTelemetry({}, { exporter });
  return { exporter, telemetry };
};

describe('createTelemetry', () => {
  it('degrades to a no-op without keys', () => {
    const t = createTelemetry({ publicKey: undefined, secretKey: undefined });
    expect(t.enabled).toBe(false);
    // The no-op interface holds up under use.
    const turn = t.turn({ a: 1 });
    turn.span('tool.x').end();
    turn.end('ok');
    expect(t).toBe(NOOP_TELEMETRY);
  });

  it('builds one tree per turn: children share the root trace and parent', async () => {
    const { exporter, telemetry } = harness();
    const turn = telemetry.turn({ 'session.hash': 'abc123' });
    turn.span('gate.budget').end({ 'gate.allowed': true });
    turn.span('llm.call#1').end();
    turn.span('tool.search_trials').end();
    turn.end('ok');
    await telemetry.flush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual([
      'chat-turn',
      'gate.budget',
      'llm.call#1',
      'tool.search_trials',
    ]);

    const root = spans.find((s) => s.name === 'chat-turn')!;
    const children = spans.filter((s) => s.name !== 'chat-turn');
    for (const child of children) {
      expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
      expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    }
  });

  it('carries attributes onto the spans', async () => {
    const { exporter, telemetry } = harness();
    const turn = telemetry.turn({ 'prompt.hash': 'deadbeef' });
    turn.setAttributes({ 'gen_ai.prompt': 'the question' });
    turn.end('ok', { 'chat.cost_usd': 0.13 });
    await telemetry.flush();

    const root = exporter.getFinishedSpans().find((s) => s.name === 'chat-turn')!;
    expect(root.attributes['prompt.hash']).toBe('deadbeef');
    expect(root.attributes['gen_ai.prompt']).toBe('the question');
    expect(root.attributes['chat.cost_usd']).toBe(0.13);
  });

  it('marks an errored span', async () => {
    const { exporter, telemetry } = harness();
    const turn = telemetry.turn();
    const span = turn.span('gate.budget');
    span.recordError(new Error('ddb unreachable'));
    span.end();
    turn.end('error');
    await telemetry.flush();

    const gate = exporter.getFinishedSpans().find((s) => s.name === 'gate.budget')!;
    expect(gate.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(gate.events.some((e) => e.name === 'exception')).toBe(true);
  });
});
