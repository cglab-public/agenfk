/**
 * GH-389: pi session logs (~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl).
 * The first record is the session header (id, cwd); usage is on `message`
 * records whose message.role is 'assistant', one per model response, with
 * pi's own cost. A forked session copies earlier records into a new file, so
 * the response id is the turn's identity across files.
 */
import { describe, it, expect } from 'vitest';
import { parsePiJsonl } from '../token-ingestion/parsers/pi';
import { processFile } from '../token-ingestion/watcher';

const header = JSON.stringify({ type: 'session', version: 3, id: 'pi-sess-1', timestamp: '2026-11-19T10:00:00.000Z', cwd: '/repo' });

const assistant = (over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => JSON.stringify({
  type: 'message', id: 'e1', parentId: 'e0', timestamp: '2026-11-19T10:00:05.000Z',
  message: {
    role: 'assistant', api: 'openai-completions', provider: 'qwen38', model: 'qwen3.8-27b',
    usage: {
      input: 919, output: 128, cacheRead: 6464, cacheWrite: 10, reasoning: 30, totalTokens: 7551,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0, total: 0.0035 },
      ...usage,
    },
    responseId: 'resp-1', timestamp: 1795000000000, content: [],
    ...over,
  },
});

describe('parsePiJsonl', () => {
  it('emits one event per assistant response, with session id and cwd from the header', () => {
    const user = JSON.stringify({ type: 'message', id: 'e0', timestamp: '2026-11-19T10:00:01.000Z', message: { role: 'user', content: 'hi' } });
    const text = [header, user, assistant(), ''].join('\n');

    const events = parsePiJsonl(text, '/p/pi.jsonl', 0);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ts: '2026-11-19T10:00:05.000Z',
      sessionId: 'pi-sess-1',
      cwd: '/repo',
      model: 'qwen3.8-27b',
      input: 919,
      output: 128,
      cacheRead: 6464,
      cacheWrite: 10,
      cachedInput: 6474,
      reasoning: 30,
      total: 7551,
      costUsd: 0.0035,
      sourcePath: '/p/pi.jsonl',
    });
    expect(events[0].sourceOffset).toBe(Buffer.byteLength(`${header}\n${user}\n`, 'utf8'));
  });

  it('uses the response id as the dedup key, so a forked copy is not counted twice', () => {
    const [ev] = parsePiJsonl([header, assistant(), ''].join('\n'), '/p/pi.jsonl', 0);
    expect(ev.dedupKey).toBe('resp-1');
  });

  it('falls back to session id + record id when the response has no id', () => {
    const [ev] = parsePiJsonl([header, assistant({ responseId: undefined }), ''].join('\n'), '/p/pi.jsonl', 0);
    expect(ev.dedupKey).toBe('pi-sess-1:e1');
  });

  it('skips a response that used no tokens (an aborted or empty turn)', () => {
    const zero = assistant({}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { total: 0 } });
    expect(parsePiJsonl([header, zero, ''].join('\n'), '/p/pi.jsonl', 0)).toEqual([]);
  });

  it('ignores records that are not assistant messages, even if they carry usage', () => {
    const tool = JSON.stringify({ type: 'message', id: 'e2', timestamp: 't', message: { role: 'toolResult', usage: { input: 5, output: 5, totalTokens: 10 } } });
    const update = JSON.stringify({ type: 'message_update', id: 'e3', timestamp: 't', message: { role: 'assistant', usage: { input: 5, output: 5, totalTokens: 10 } } });
    expect(parsePiJsonl([header, tool, update, ''].join('\n'), '/p/pi.jsonl', 0)).toEqual([]);
  });

  it('records no cost when pi reported none, rather than a made-up zero', () => {
    const [ev] = parsePiJsonl([header, assistant({}, { cost: undefined }), ''].join('\n'), '/p/pi.jsonl', 0);
    expect(ev.costUsd).toBeUndefined();
  });

  it('skips malformed lines without throwing', () => {
    expect(parsePiJsonl([header, '{oops', assistant(), ''].join('\n'), '/p/pi.jsonl', 0)).toHaveLength(1);
  });

  it('remembers the header across passes, so an appended response keeps its session and cwd', () => {
    const head = `${header}\n${assistant()}\n`;
    const first = processFile('/p/pi.jsonl', head, null, parsePiJsonl);
    const second = processFile('/p/pi.jsonl', `${head}${assistant({ responseId: 'resp-2' })}\n`, first.nextState, parsePiJsonl);

    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ sessionId: 'pi-sess-1', cwd: '/repo', dedupKey: 'resp-2' });
  });
});
