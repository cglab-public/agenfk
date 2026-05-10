import { describe, it, expect } from 'vitest';
import { parseClaudeCodeJsonl } from '../token-ingestion/parsers/claude-code';

describe('parseClaudeCodeJsonl', () => {
  it('emits one event per assistant message with usage; ignores other lines', () => {
    const a1 = {
      type: 'assistant',
      timestamp: '2026-05-10T00:00:00.000Z',
      sessionId: 'sess-1',
      message: {
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 30,
          output_tokens: 40,
        },
      },
    };
    const userMsg = { type: 'user', timestamp: '2026-05-10T00:00:01Z', sessionId: 'sess-1', message: { content: 'hi' } };
    const a2 = {
      type: 'assistant',
      timestamp: '2026-05-10T00:00:02Z',
      sessionId: 'sess-1',
      message: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 5, cache_read_input_tokens: 80, output_tokens: 12 },
      },
    };
    const text = [JSON.stringify(a1), JSON.stringify(userMsg), JSON.stringify(a2), ''].join('\n');
    const events = parseClaudeCodeJsonl(text, '/p/sess.jsonl', 0);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      ts: '2026-05-10T00:00:00.000Z',
      sessionId: 'sess-1',
      model: 'claude-opus-4-7',
      input: 100,
      // cached_input combines cache-creation + cache-read because Claude bills both as "non-fresh" input
      cachedInput: 80,
      output: 40,
      reasoning: 0,
      total: 100 + 80 + 40,
      sourcePath: '/p/sess.jsonl',
    });
    expect(events[0].sourceOffset).toBe(0);

    // Second event's offset is past the first two lines.
    const expectedOffset = Buffer.byteLength(JSON.stringify(a1) + '\n' + JSON.stringify(userMsg) + '\n', 'utf8');
    expect(events[1].sourceOffset).toBe(expectedOffset);
    expect(events[1].input).toBe(5);
    expect(events[1].cachedInput).toBe(80);
    expect(events[1].output).toBe(12);
  });

  it('handles a slice with a non-zero baseOffset', () => {
    const a = {
      type: 'assistant',
      timestamp: '2026-05-10T00:00:00Z',
      sessionId: 'sess-1',
      message: { model: 'claude', usage: { input_tokens: 1, output_tokens: 2 } },
    };
    const text = JSON.stringify(a) + '\n';
    const events = parseClaudeCodeJsonl(text, '/p/sess.jsonl', 1024);
    expect(events).toHaveLength(1);
    expect(events[0].sourceOffset).toBe(1024);
  });

  it('skips malformed JSON lines without throwing', () => {
    const a = {
      type: 'assistant',
      timestamp: '2026-05-10T00:00:00Z',
      sessionId: 'sess-1',
      message: { model: 'claude', usage: { input_tokens: 1, output_tokens: 2 } },
    };
    const text = ['{not json}', JSON.stringify(a), ''].join('\n');
    const events = parseClaudeCodeJsonl(text, '/p/sess.jsonl', 0);
    expect(events).toHaveLength(1);
  });
});
