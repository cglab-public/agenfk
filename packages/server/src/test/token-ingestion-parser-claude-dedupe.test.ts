/**
 * GH-389: Claude Code writes one JSONL line per content block of an assistant
 * message, and every one of those lines repeats the SAME message.usage. Counting
 * per line overcounted a real session ~1.85x (50 lines, 27 message ids). Usage
 * is counted once per message.id, and the split between cache reads and cache
 * writes is kept, because a card's cost depends on it.
 */
import { describe, it, expect } from 'vitest';
import { parseClaudeCodeJsonl } from '../token-ingestion/parsers/claude-code';

const usage = { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000, output_tokens: 40 };

const line = (over: Record<string, unknown>, msg: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant',
  timestamp: '2026-11-19T10:00:00.000Z',
  sessionId: 'sess-1',
  cwd: '/repo',
  requestId: 'req_1',
  ...over,
  message: { id: 'msg_1', model: 'claude-opus-5-5', usage, ...msg },
});

describe('parseClaudeCodeJsonl - one event per message', () => {
  it('collapses the content-block lines of one message into a single event', () => {
    const text = [
      line({ uuid: 'u1' }, { content: [{ type: 'thinking' }] }),
      line({ uuid: 'u2' }, { content: [{ type: 'text' }] }),
      line({ uuid: 'u3' }, { content: [{ type: 'tool_use' }] }),
      '',
    ].join('\n');

    const events = parseClaudeCodeJsonl(text, '/p/s.jsonl', 0);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ input: 3, output: 40, cachedInput: 9500 });
  });

  it('keys the event on message.id so a copy in another file is the same turn', () => {
    const events = parseClaudeCodeJsonl(line({ uuid: 'u1' }) + '\n', '/p/s.jsonl', 0);
    expect(events[0].dedupKey).toBe('msg_1');
    expect(events[0].turnId).toBe('msg_1');
  });

  it('anchors the event at the offset of the FIRST line of the message', () => {
    const user = JSON.stringify({ type: 'user', sessionId: 'sess-1', message: { content: 'hi' } });
    const first = line({ uuid: 'u1' });
    const text = [user, first, line({ uuid: 'u2' }), ''].join('\n');

    const events = parseClaudeCodeJsonl(text, '/p/s.jsonl', 100);

    expect(events[0].sourceOffset).toBe(100 + Buffer.byteLength(user + '\n', 'utf8'));
  });

  it('still counts distinct messages separately', () => {
    const text = [
      line({ uuid: 'u1' }, { id: 'msg_1' }),
      line({ uuid: 'u2' }, { id: 'msg_2', usage: { ...usage, output_tokens: 7 } }),
      '',
    ].join('\n');

    const events = parseClaudeCodeJsonl(text, '/p/s.jsonl', 0);

    expect(events.map((e) => [e.dedupKey, e.output])).toEqual([['msg_1', 40], ['msg_2', 7]]);
  });

  it('keeps cache reads and cache writes apart', () => {
    const [ev] = parseClaudeCodeJsonl(line({}) + '\n', '/p/s.jsonl', 0);
    expect(ev.cacheRead).toBe(9000);
    expect(ev.cacheWrite).toBe(500);
  });

  it('a line with no message.id is still counted, with no dedup key', () => {
    const text = JSON.stringify({
      type: 'assistant', timestamp: '2026-11-19T10:00:00Z', sessionId: 's', uuid: 'u9',
      message: { model: 'm', usage: { input_tokens: 1, output_tokens: 2 } },
    }) + '\n';

    const events = parseClaudeCodeJsonl(text, '/p/s.jsonl', 0);

    expect(events).toHaveLength(1);
    expect(events[0].dedupKey).toBeUndefined();
  });

  it('a subagent line is the parent session, so its usage follows the parent', () => {
    const sub = line({ isSidechain: true, agentId: 'a253', sessionId: 'parent-sess' });
    const [ev] = parseClaudeCodeJsonl(sub + '\n', '/p/parent-sess/subagents/agent-a253.jsonl', 0);
    expect(ev.sessionId).toBe('parent-sess');
  });
});
