import { describe, it, expect } from 'vitest';
import { processFile } from '../token-ingestion/watcher';
import type { TokenEvent, IngestionState } from '@agenfk/core';

/**
 * processFile is the pure-logic core of the file watcher: given the prior
 * ingestion state for a path, the file's current contents, and a parser, it
 * returns the new events to insert plus the next ingestion state. No I/O.
 */
describe('processFile', () => {
  const fakeParser = (text: string, basePath: string, baseOffset: number): TokenEvent[] => {
    // Each line is "<input>,<output>" → one event per non-empty line.
    const out: TokenEvent[] = [];
    let off = baseOffset;
    for (const line of text.split('\n')) {
      if (line.trim()) {
        const [i, o] = line.split(',').map(Number);
        out.push({
          id: `${basePath}:${off}`,
          ts: '2026-05-10T00:00:00Z',
          client: 'codex',
          sessionId: 'sess',
          model: 'm',
          input: i,
          cachedInput: 0,
          output: o,
          reasoning: 0,
          total: i + o,
          sourcePath: basePath,
          sourceOffset: off,
        });
      }
      off += Buffer.byteLength(line, 'utf8') + 1;
    }
    return out;
  };

  it('returns events for the full file on first run (no prior state)', () => {
    const r = processFile('/p/a.jsonl', '10,20\n30,40\n', null, fakeParser);
    expect(r.events.map((e) => e.input)).toEqual([10, 30]);
    expect(r.nextState.lastOffset).toBe(Buffer.byteLength('10,20\n30,40\n', 'utf8'));
    expect(r.nextState.sourcePath).toBe('/p/a.jsonl');
  });

  it('returns only newly-appended events on subsequent runs', () => {
    const initial: IngestionState = {
      sourcePath: '/p/a.jsonl',
      lastOffset: Buffer.byteLength('10,20\n', 'utf8'),
      lastRunAt: '2026-05-10T00:00:00Z',
    };
    const r = processFile('/p/a.jsonl', '10,20\n30,40\n', initial, fakeParser);
    expect(r.events.map((e) => e.input)).toEqual([30]);
    expect(r.nextState.lastOffset).toBe(Buffer.byteLength('10,20\n30,40\n', 'utf8'));
  });

  it('returns no events when nothing has been appended', () => {
    const initial: IngestionState = {
      sourcePath: '/p/a.jsonl',
      lastOffset: Buffer.byteLength('10,20\n30,40\n', 'utf8'),
      lastRunAt: '2026-05-10T00:00:00Z',
    };
    const r = processFile('/p/a.jsonl', '10,20\n30,40\n', initial, fakeParser);
    expect(r.events).toEqual([]);
    expect(r.nextState.lastOffset).toBe(initial.lastOffset);
  });

  it('handles file truncation by resetting offset to 0 and re-emitting', () => {
    // File got truncated/rotated; current contents are smaller than lastOffset.
    const initial: IngestionState = {
      sourcePath: '/p/a.jsonl',
      lastOffset: 999,
      lastRunAt: '2026-05-10T00:00:00Z',
    };
    const r = processFile('/p/a.jsonl', '5,5\n', initial, fakeParser);
    expect(r.events.map((e) => e.input)).toEqual([5]);
    expect(r.nextState.lastOffset).toBe(Buffer.byteLength('5,5\n', 'utf8'));
  });
});
