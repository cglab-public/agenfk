/**
 * GH-397: the local server prices each turn the harness did not price when it
 * ingests it, from the public price table as it is then, and stores the price
 * with the turn as estimatedCostUsd. A harness's own cost (pi) is kept as
 * reported and never priced again; a turn with neither (a model the table does
 * not know, or no table at the time) is counted unpriced.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IngestionState, TokenEvent } from '@agenfk/core';
import { createUsageIngestion } from '../token-ingestion/service';
import { parseClaudeCodeJsonl } from '../token-ingestion/parsers/claude-code';
import { parseCodexJsonl } from '../token-ingestion/parsers/codex';
import { parsePiJsonl } from '../token-ingestion/parsers/pi';
import { aggregateUsage } from '../usage/stepUsage';

const EPOCH = new Date('2026-11-01T00:00:00Z');
const TABLE = { prices: [
  { id: 'claude-opus-5-5', input: 10, output: 50, input_cached: 1 },
  { id: 'gpt-5.5', input: 5, output: 30, input_cached: 0.5 },
  { id: 'qwen3.8', input: 100, output: 100 },
] };

function memStorage() {
  const inserted: TokenEvent[] = [];
  const states: Record<string, IngestionState> = {};
  let epoch: string | null = null;
  return {
    inserted,
    async insertTokenEvent(ev: TokenEvent) { inserted.push({ ...ev }); },
    async getIngestionState(p: string) { return states[p] ?? null; },
    async setIngestionState(s: IngestionState) { states[s.sourcePath] = s; },
    async ensureIngestionEpoch(now: string) { epoch = epoch ?? now; return epoch; },
    async listProjects() { return []; },
    async sessionCardAt() { return null; },
  } as any;
}

const claudeLine = (id: string, model: string, usage: Record<string, number>) => JSON.stringify({
  type: 'assistant', timestamp: '2026-11-19T10:00:00Z', sessionId: 'sess-c', cwd: '/repo',
  message: { id, model, usage },
}) + '\n';
const piLines = () => [
  JSON.stringify({ type: 'session', id: 'pi-1', cwd: '/repo' }),
  JSON.stringify({ type: 'message', id: 'r1', timestamp: '2026-11-19T10:00:00Z', message: {
    role: 'assistant', model: 'qwen3.8', responseId: 'resp-1',
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000, cost: { total: 0.25 } },
  } }),
].join('\n') + '\n';
const codexLines = () => [
  JSON.stringify({ type: 'session_meta', timestamp: '2026-11-19T10:00:00Z', payload: { id: 'cx-1', cwd: '/repo' } }),
  JSON.stringify({ type: 'turn_context', timestamp: '2026-11-19T10:00:01Z', payload: { turn_id: 't1', model: 'gpt-5.5', cwd: '/repo' } }),
  JSON.stringify({ type: 'event_msg', timestamp: '2026-11-19T10:00:02Z', payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 3_000_000, cached_input_tokens: 2_000_000, output_tokens: 1_000_000, reasoning_output_tokens: 0, total_tokens: 4_000_000 },
    total_token_usage: { input_tokens: 3_000_000, cached_input_tokens: 2_000_000, output_tokens: 1_000_000, reasoning_output_tokens: 0, total_tokens: 4_000_000 },
  } } }),
].join('\n') + '\n';

describe('pricing turns at ingestion', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-usage-price-'));
    for (const c of ['claude', 'codex', 'pi']) fs.mkdirSync(path.join(dir, c));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sources = () => [
    { client: 'claude-code', rootDir: path.join(dir, 'claude'), matches: (r: string) => r.endsWith('.jsonl'), parser: parseClaudeCodeJsonl },
    { client: 'codex', rootDir: path.join(dir, 'codex'), matches: (r: string) => r.endsWith('.jsonl'), parser: parseCodexJsonl },
    { client: 'pi', rootDir: path.join(dir, 'pi'), matches: (r: string) => r.endsWith('.jsonl'), parser: parsePiJsonl },
  ];
  const ingest = async (prices: () => Promise<any>) => {
    const storage = memStorage();
    await createUsageIngestion({ storage, sources: sources(), now: () => EPOCH, prices }).runOnce();
    return storage.inserted as TokenEvent[];
  };
  const byModel = (events: TokenEvent[], model: string) => events.find(e => e.model === model)!;

  it('prices a Claude Code turn from the table and stores it as estimatedCostUsd, leaving costUsd unset', async () => {
    fs.writeFileSync(path.join(dir, 'claude', 'sess-c.jsonl'), claudeLine('m1', 'claude-opus-5-5', {
      input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
    }));
    const [ev] = await ingest(async () => TABLE);
    expect(ev.estimatedCostUsd).toBe(71);
    expect(ev.costUsd).toBeUndefined();
  });

  it('prices a Codex turn, its cached input at the cached rate', async () => {
    fs.writeFileSync(path.join(dir, 'codex', 'rollout-cx-1.jsonl'), codexLines());
    const ev = byModel(await ingest(async () => TABLE), 'gpt-5.5');
    // fresh input 1M x 5 + cached 2M x 0.5 + output 1M x 30
    expect(ev.estimatedCostUsd).toBe(36);
  });

  it('leaves the cost pi reported alone and does not price the turn again', async () => {
    fs.writeFileSync(path.join(dir, 'pi', '2026_pi-1.jsonl'), piLines());
    const ev = byModel(await ingest(async () => TABLE), 'qwen3.8');
    expect(ev.costUsd).toBe(0.25);
    expect(ev.estimatedCostUsd).toBeUndefined();
  });

  it('a model the table does not know is left unpriced', async () => {
    fs.writeFileSync(path.join(dir, 'claude', 'sess-c.jsonl'), claudeLine('m1', 'mystery-9', { input_tokens: 5, output_tokens: 5 }));
    const [ev] = await ingest(async () => TABLE);
    expect(ev.estimatedCostUsd).toBeUndefined();
    expect(aggregateUsage([ev]).total.unpricedTurns).toBe(1);
  });

  it('with no table at the time (unavailable, or it failed), the turn is left unpriced and ingested all the same', async () => {
    fs.writeFileSync(path.join(dir, 'claude', 'sess-c.jsonl'), claudeLine('m1', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 5 }));
    const [none] = await ingest(async () => null);
    expect(none.estimatedCostUsd).toBeUndefined();
    fs.rmSync(path.join(dir, 'claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'claude'));
    fs.writeFileSync(path.join(dir, 'claude', 'sess-c.jsonl'), claudeLine('m2', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 5 }));
    const [failed] = await ingest(async () => { throw new Error('offline'); });
    expect(failed.dedupKey).toBe('m2');
    expect(failed.estimatedCostUsd).toBeUndefined();
  });

  it('reads the table at most once per pass, and not at all when every turn was priced by its harness', async () => {
    fs.writeFileSync(path.join(dir, 'claude', 'sess-c.jsonl'),
      claudeLine('m1', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 }) + claudeLine('m2', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 }));
    let reads = 0;
    await ingest(async () => { reads++; return TABLE; });
    expect(reads).toBe(1);

    fs.rmSync(path.join(dir, 'claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'claude'));
    fs.writeFileSync(path.join(dir, 'pi', '2026_pi-1.jsonl'), piLines());
    reads = 0;
    await ingest(async () => { reads++; return TABLE; });
    expect(reads).toBe(0);
  });

  it('the summed usage keeps reported and estimated apart and counts only turns with neither as unpriced', async () => {
    fs.writeFileSync(path.join(dir, 'claude', 'sess-c.jsonl'),
      claudeLine('m1', 'claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0 }) + claudeLine('m2', 'mystery-9', { input_tokens: 1, output_tokens: 1 }));
    fs.writeFileSync(path.join(dir, 'pi', '2026_pi-1.jsonl'), piLines());
    const u = aggregateUsage(await ingest(async () => TABLE));
    expect(u.total).toMatchObject({ turns: 3, costUsd: 0.25, estimatedCostUsd: 10, unpricedTurns: 1 });
    expect(u.byModel.find(m => m.model === 'claude-opus-5-5')).toMatchObject({ estimatedCostUsd: 10, unpricedTurns: 0, costUsd: 0 });
    expect(u.byModel.find(m => m.model === 'qwen3.8')).toMatchObject({ estimatedCostUsd: 0, unpricedTurns: 0, costUsd: 0.25 });
  });
});
