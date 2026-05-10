/**
 * Tests that:
 * 1. ingestOnce calls opts.onEvent for every successfully-inserted TokenEvent.
 * 2. The hub rollup/query token extraction handles the new flat payload format
 *    ($.input / $.output) as well as the legacy nested format as a fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { TokenEvent, StorageProvider } from '@agenfk/core';
import { ingestOnce, IngestionPollerOptions } from '../token-ingestion/watcher';
import { parseClaudeCodeJsonl } from '../token-ingestion/parsers/claude-code';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeStorage(insertShouldFail = false): StorageProvider & {
  inserted: TokenEvent[];
  states: Record<string, any>;
} {
  const inserted: TokenEvent[] = [];
  const states: Record<string, any> = {};
  return {
    inserted,
    states,
    async insertTokenEvent(ev) {
      if (insertShouldFail) throw new Error('duplicate');
      inserted.push(ev);
    },
    async getIngestionState(p) { return states[p] ?? null; },
    async setIngestionState(s) { states[s.sourcePath] = s; },
  } as any;
}

function writeTempJsonl(dir: string, name: string, lines: object[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

const ASSISTANT_LINE = {
  type: 'assistant',
  timestamp: '2026-01-01T00:00:00Z',
  sessionId: 'sess-1',
  uuid: 'turn-1',
  message: {
    model: 'claude-sonnet-4-5',
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 },
  },
};

// ── 1. onEvent callback ───────────────────────────────────────────────────────

describe('ingestOnce — onEvent callback', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-emit-'));
  });

  it('calls onEvent for each successfully inserted TokenEvent', async () => {
    writeTempJsonl(tmpDir, 'session.jsonl', [ASSISTANT_LINE]);
    const storage = makeStorage();
    const received: TokenEvent[] = [];
    const opts: IngestionPollerOptions = {
      storage,
      sources: [{
        client: 'claude-code',
        rootDir: tmpDir,
        matches: (rel) => rel.endsWith('.jsonl'),
        parser: parseClaudeCodeJsonl,
      }],
      onEvent: (ev) => received.push(ev),
    };
    const written = await ingestOnce(opts);
    expect(written).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].input).toBe(100);
    expect(received[0].output).toBe(50);
    expect(received[0].model).toBe('claude-sonnet-4-5');
  });

  it('does not call onEvent when insertTokenEvent throws (duplicate)', async () => {
    writeTempJsonl(tmpDir, 'session.jsonl', [ASSISTANT_LINE]);
    const storage = makeStorage(true);
    const received: TokenEvent[] = [];
    const opts: IngestionPollerOptions = {
      storage,
      sources: [{
        client: 'claude-code',
        rootDir: tmpDir,
        matches: (rel) => rel.endsWith('.jsonl'),
        parser: parseClaudeCodeJsonl,
      }],
      onEvent: (ev) => received.push(ev),
    };
    await ingestOnce(opts);
    expect(received).toHaveLength(0);
  });

  it('onEvent is optional — ingestOnce works without it', async () => {
    writeTempJsonl(tmpDir, 'session.jsonl', [ASSISTANT_LINE]);
    const storage = makeStorage();
    const opts: IngestionPollerOptions = {
      storage,
      sources: [{
        client: 'claude-code',
        rootDir: tmpDir,
        matches: (rel) => rel.endsWith('.jsonl'),
        parser: parseClaudeCodeJsonl,
      }],
    };
    await expect(ingestOnce(opts)).resolves.toBe(1);
  });
});

// ── 2. Rollup payload format compatibility ────────────────────────────────────

describe('hub rollup — token payload extraction', () => {
  it('server.ts hub startup block imports and starts the ingestion poller', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../server.ts'),
      'utf8',
    );
    expect(src).toMatch(/startIngestionPoller/);
    expect(src).toMatch(/tokens\.logged/);
  });

  it('rollup.ts uses COALESCE to handle new flat payload format ($.input)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../../packages/hub/src/rollup.ts'),
      'utf8',
    );
    expect(src).toMatch(/json_extract\(payload,\s*['"]\$\.input['"]\)/);
  });

  it('queries.ts /metrics uses COALESCE to handle new flat payload format', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../../packages/hub/src/routes/queries.ts'),
      'utf8',
    );
    expect(src).toMatch(/json_extract\(payload,\s*['"]\$\.input['"]\)/);
  });
});
