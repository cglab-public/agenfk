/**
 * GH-389: session logs reach 90 MB and total gigabytes, so ingestion reads only
 * what was appended since the last pass, keeps what a parser needs from earlier
 * lines in a small saved state, never consumes a half-written line, does not
 * open a file that has not grown, and does not backfill sessions that predate
 * ingestion (they have no session-to-card journal, so none of it could be
 * attributed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TokenEvent, IngestionState, StorageProvider } from '@agenfk/core';
import { processFile, ingestOnce, type ParserContext } from '../token-ingestion/watcher';
import { parseCodexJsonl } from '../token-ingestion/parsers/codex';

/** "<input>,<output>" per line; counts lines it has seen in ctx.state.seen. */
function countingParser(calls: Array<{ text: string; baseOffset: number; state: unknown }>) {
  return (text: string, sourcePath: string, baseOffset: number, ctx?: ParserContext): TokenEvent[] => {
    calls.push({ text, baseOffset, state: ctx?.state === undefined ? undefined : JSON.parse(JSON.stringify(ctx.state)) });
    const out: TokenEvent[] = [];
    let off = baseOffset;
    let seen = Number((ctx?.state as any)?.seen ?? 0);
    for (const line of text.split('\n')) {
      if (line.trim()) {
        const [i, o] = line.split(',').map(Number);
        seen++;
        out.push({
          id: `${sourcePath}:${off}`, ts: '2026-11-19T00:00:00Z', client: 'claude-code', sessionId: 's', model: 'm',
          input: i, cachedInput: 0, output: o, reasoning: 0, total: i + o, sourcePath, sourceOffset: off,
        });
      }
      off += Buffer.byteLength(line, 'utf8') + 1;
    }
    if (ctx) ctx.state = { seen };
    return out;
  };
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('processFile - complete lines only', () => {
  it('does not consume a half-written last line, and counts it once it is complete', () => {
    const calls: any[] = [];
    const parser = countingParser(calls);

    const first = processFile('/p/a.jsonl', '10,20\n30,4', null, parser);
    expect(first.events.map((e) => e.input)).toEqual([10]);
    expect(first.nextState.lastOffset).toBe(bytes('10,20\n'));

    const second = processFile('/p/a.jsonl', '10,20\n30,40\n', first.nextState, parser);
    expect(second.events.map((e) => [e.input, e.output])).toEqual([[30, 40]]);
  });
});

describe('processFile - resumes from saved parser state', () => {
  it('hands the parser only the appended tail, at its real offset, with the saved state', () => {
    const calls: any[] = [];
    const prior: IngestionState = {
      sourcePath: '/p/a.jsonl', lastOffset: bytes('10,20\n'), lastRunAt: 'x', parserState: JSON.stringify({ seen: 1 }),
    };

    const r = processFile('/p/a.jsonl', '10,20\n30,40\n', prior, countingParser(calls));

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe('30,40\n');
    expect(calls[0].baseOffset).toBe(bytes('10,20\n'));
    expect(calls[0].state).toEqual({ seen: 1 });
    expect(r.events[0].sourceOffset).toBe(bytes('10,20\n'));
    expect(JSON.parse(r.nextState.parserState!)).toEqual({ seen: 2 });
  });

  it('a state from before parser state existed rebuilds context from the whole file once', () => {
    const calls: any[] = [];
    const prior: IngestionState = { sourcePath: '/p/a.jsonl', lastOffset: bytes('10,20\n'), lastRunAt: 'x' };

    const r = processFile('/p/a.jsonl', '10,20\n30,40\n', prior, countingParser(calls));

    expect(calls[0].baseOffset).toBe(0);
    expect(r.events.map((e) => e.input)).toEqual([30]);
    expect(JSON.parse(r.nextState.parserState!)).toEqual({ seen: 2 });
  });

  it('a truncated file starts over with no saved state', () => {
    const calls: any[] = [];
    const prior: IngestionState = { sourcePath: '/p/a.jsonl', lastOffset: 999, lastRunAt: 'x', parserState: JSON.stringify({ seen: 50 }) };

    const r = processFile('/p/a.jsonl', '5,5\n', prior, countingParser(calls));

    expect(calls[0].state).toBeUndefined();
    expect(r.events.map((e) => e.input)).toEqual([5]);
  });

  it('Codex keeps its session id, model and cwd across passes through the saved state', () => {
    const meta = JSON.stringify({ type: 'session_meta', timestamp: 't0', payload: { id: 'sess-codex', cwd: '/repo' } });
    const ctxLine = JSON.stringify({ type: 'turn_context', timestamp: 't1', payload: { turn_id: 'turn-1', model: 'gpt-6', cwd: '/repo' } });
    const tc = (n: number, cum: number) => JSON.stringify({
      type: 'event_msg', timestamp: `t${n}`,
      payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        total_token_usage: { input_tokens: cum, output_tokens: 2, total_tokens: cum + 2 },
      } },
    });
    const head = `${meta}\n${ctxLine}\n${tc(2, 10)}\n`;
    const first = processFile('/p/c.jsonl', head, null, parseCodexJsonl);
    const second = processFile('/p/c.jsonl', `${head}${tc(3, 20)}\n`, first.nextState, parseCodexJsonl);

    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ sessionId: 'sess-codex', model: 'gpt-6', cwd: '/repo', turnId: 'turn-1', input: 10 });
  });
});

// ── ingestOnce: what it opens ────────────────────────────────────────────────

function memStorage(): StorageProvider & { inserted: TokenEvent[]; states: Record<string, IngestionState> } {
  const inserted: TokenEvent[] = [];
  const states: Record<string, IngestionState> = {};
  return {
    inserted, states,
    async insertTokenEvent(ev: TokenEvent) { inserted.push(ev); },
    async getIngestionState(p: string) { return states[p] ?? null; },
    async setIngestionState(s: IngestionState) { states[s.sourcePath] = s; },
  } as any;
}

describe('ingestOnce - reads only what changed', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-incr-')); });

  const source = (parser: any) => ({ client: 'claude-code', rootDir: dir, matches: (r: string) => r.endsWith('.jsonl'), parser });

  it('does not parse a file that has not grown since the last pass', async () => {
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '1,1\n');
    const calls: any[] = [];
    const storage = memStorage();
    const opts = { storage, sources: [source(countingParser(calls))] };

    await ingestOnce(opts);
    await ingestOnce(opts);

    expect(calls).toHaveLength(1);
    expect(storage.inserted).toHaveLength(1);
  });

  it('parses only the appended bytes on the next pass', async () => {
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, '1,1\n');
    const calls: any[] = [];
    const storage = memStorage();
    const opts = { storage, sources: [source(countingParser(calls))] };

    await ingestOnce(opts);
    fs.appendFileSync(f, '2,2\n');
    await ingestOnce(opts);

    expect(calls[1].text).toBe('2,2\n');
    expect(storage.inserted.map((e) => e.input)).toEqual([1, 2]);
  });

  it('skips the backlog: a file last written before the epoch is fast-forwarded, not parsed', async () => {
    const f = path.join(dir, 'old.jsonl');
    fs.writeFileSync(f, '1,1\n2,2\n');
    const old = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(f, old, old);
    const calls: any[] = [];
    const storage = memStorage();
    const opts = { storage, sources: [source(countingParser(calls))], epoch: '2026-11-01T00:00:00Z' };

    await ingestOnce(opts);

    expect(calls).toHaveLength(0);
    expect(storage.inserted).toHaveLength(0);
    expect(storage.states[f].lastOffset).toBe(bytes('1,1\n2,2\n'));

    fs.appendFileSync(f, '3,3\n');
    await ingestOnce(opts);
    expect(storage.inserted.map((e) => e.input)).toEqual([3]);
  });

  it('a file written after the epoch is ingested from the start', async () => {
    fs.writeFileSync(path.join(dir, 'new.jsonl'), '1,1\n');
    const storage = memStorage();

    await ingestOnce({ storage, sources: [source(countingParser([]))], epoch: '2026-01-01T00:00:00Z' });

    expect(storage.inserted.map((e) => e.input)).toEqual([1]);
  });

  it('a session still running across the epoch keeps only the turns after it', async () => {
    const f = path.join(dir, 'live.jsonl');
    fs.writeFileSync(f, '1,1\n2,2\n');
    const storage = memStorage();
    const stamped = (text: string, sp: string, base: number, ctx?: ParserContext) =>
      countingParser([])(text, sp, base, ctx).map((e, i) => ({ ...e, ts: i === 0 ? '2026-10-01T00:00:00Z' : '2026-11-19T00:00:00Z' }));

    await ingestOnce({ storage, sources: [source(stamped)], epoch: '2026-11-01T00:00:00Z' });

    expect(storage.inserted.map((e) => e.input)).toEqual([2]);
  });
});

