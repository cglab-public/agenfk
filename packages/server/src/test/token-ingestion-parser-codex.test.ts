import { describe, it, expect } from 'vitest';
import { parseCodexJsonl } from '../token-ingestion/parsers/codex';

/**
 * Codex writes session JSONL where each `event_msg` with payload.type ==='token_count'
 * carries cumulative totals. Per-turn deltas are derived by subtracting the
 * previous cumulative.
 */

function ev(ts: string, cum: Partial<{ input: number; cached_input: number; output: number; reasoning: number; total: number }>) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: ts,
    payload: {
      type: 'token_count',
      session_id: 'sess-codex',
      model: 'gpt-5',
      ...cum,
    },
  });
}

describe('parseCodexJsonl', () => {
  it('emits per-turn deltas from cumulative totals', () => {
    const text = [
      ev('2026-05-10T00:00:00Z', { input: 10, output: 5, total: 15 }),
      ev('2026-05-10T00:01:00Z', { input: 30, output: 12, total: 42 }),
      '',
    ].join('\n');
    const events = parseCodexJsonl(text, '/p/codex.jsonl', 0);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      ts: '2026-05-10T00:00:00Z',
      sessionId: 'sess-codex',
      model: 'gpt-5',
      input: 10,
      output: 5,
      total: 15,
    });
    // Second event delta = current - prev within this slice.
    expect(events[1]).toMatchObject({
      ts: '2026-05-10T00:01:00Z',
      input: 20,
      output: 7,
      total: 27,
    });
  });

  it('captures cached_input and reasoning when present', () => {
    const text = [
      ev('2026-05-10T00:00:00Z', {
        input: 100,
        cached_input: 30,
        output: 50,
        reasoning: 10,
        total: 190,
      }),
      '',
    ].join('\n');
    const events = parseCodexJsonl(text, '/p/codex.jsonl', 0);
    expect(events[0]).toMatchObject({
      input: 100,
      cachedInput: 30,
      output: 50,
      reasoning: 10,
      total: 190,
    });
  });

  it('ignores non-token_count event_msg lines', () => {
    const noise = JSON.stringify({ type: 'event_msg', timestamp: '2026-05-10T00:00:00Z', payload: { type: 'agent_message' } });
    const real = ev('2026-05-10T00:00:00Z', { input: 1, output: 1, total: 2 });
    const text = [noise, real, ''].join('\n');
    expect(parseCodexJsonl(text, '/p/c.jsonl', 0)).toHaveLength(1);
  });

  it('skips negative deltas (treats as session reset / new file)', () => {
    // After truncation/rotation, cumulative may go down. Don't emit negative usage.
    const text = [
      ev('2026-05-10T00:00:00Z', { input: 100, output: 50, total: 150 }),
      ev('2026-05-10T00:01:00Z', { input: 30, output: 12, total: 42 }), // smaller — likely session reset
      '',
    ].join('\n');
    const events = parseCodexJsonl(text, '/p/codex.jsonl', 0);
    expect(events.length).toBe(2);
    // Second event treated as a fresh baseline (its cumulative IS the delta).
    expect(events[1]).toMatchObject({ input: 30, output: 12, total: 42 });
  });
});
