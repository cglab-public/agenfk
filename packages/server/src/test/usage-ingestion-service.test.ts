/**
 * GH-389: token ingestion runs again, locally only. Per-turn events go to the
 * local store and nowhere else; the hub sees usage only as the per-transition
 * totals (step.transitioned / item.closed). The service polls the default
 * session folders, and flush(sessions) ingests just those sessions' files so a
 * card's usage is current at the moment it changes state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TokenEvent, IngestionState } from '@agenfk/core';
import { defaultIngestionSources, createUsageIngestion } from '../token-ingestion/service';

// Ingestion's first run, before the turns below: they are not backlog.
const EPOCH = new Date('2026-11-01T00:00:00Z');

const line = (sessionId: string, id: string) => JSON.stringify({
  type: 'assistant', timestamp: '2026-11-19T10:00:00Z', sessionId, cwd: '/repo',
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 } },
}) + '\n';

function memStorage() {
  const inserted: TokenEvent[] = [];
  const states: Record<string, IngestionState> = {};
  const keys = new Set<string>();
  let epoch: string | null = null;
  return {
    inserted,
    async insertTokenEvent(ev: TokenEvent) {
      const k = ev.dedupKey ? `${ev.client}/${ev.dedupKey}` : `${ev.sourcePath}@${ev.sourceOffset}`;
      if (keys.has(k)) throw new Error('duplicate');
      keys.add(k);
      inserted.push(ev);
    },
    async getIngestionState(p: string) { return states[p] ?? null; },
    async setIngestionState(s: IngestionState) { states[s.sourcePath] = s; },
    async ensureIngestionEpoch(now: string) { epoch = epoch ?? now; return epoch; },
    async listProjects() { return []; },
    async sessionCardAt() { return null; },
  } as any;
}

describe('defaultIngestionSources', () => {
  it('reads Claude Code, Codex and pi session folders under the home directory', () => {
    const roots = defaultIngestionSources('/home/u', {}).map((s) => [s.client, s.rootDir]);
    expect(roots).toEqual([
      ['claude-code', path.join('/home/u', '.claude', 'projects')],
      ['codex', path.join('/home/u', '.codex', 'sessions')],
      ['pi', path.join('/home/u', '.pi', 'agent', 'sessions')],
    ]);
  });

  it('honours CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
    const roots = Object.fromEntries(defaultIngestionSources('/home/u', { CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' })
      .map((s) => [s.client, s.rootDir]));
    expect(roots['claude-code']).toBe(path.join('/cfg/claude', 'projects'));
    expect(roots.codex).toBe(path.join('/cfg/codex', 'sessions'));
  });

  it('the Claude Code source takes subagent logs too, and only .jsonl files', () => {
    const claude = defaultIngestionSources('/home/u', {}).find((s) => s.client === 'claude-code')!;
    expect(claude.matches(path.join('-repo', 'sess-1.jsonl'))).toBe(true);
    expect(claude.matches(path.join('-repo', 'sess-1', 'subagents', 'agent-a1.jsonl'))).toBe(true);
    expect(claude.matches(path.join('-repo', 'sess-1', 'subagents', 'agent-a1.meta.json'))).toBe(false);
  });
});

describe('createUsageIngestion', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-usage-svc-')); });

  const sources = () => [{
    client: 'claude-code', rootDir: dir, matches: (r: string) => r.endsWith('.jsonl'),
    parser: defaultIngestionSources('/x', {}).find((s) => s.client === 'claude-code')!.parser,
  }];

  it('flush ingests only the files of the sessions asked for (including their subagent logs)', async () => {
    fs.mkdirSync(path.join(dir, '-repo', 'sess-a', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '-repo', 'sess-a.jsonl'), line('sess-a', 'm1'));
    fs.writeFileSync(path.join(dir, '-repo', 'sess-a', 'subagents', 'agent-z.jsonl'), line('sess-a', 'm2'));
    fs.writeFileSync(path.join(dir, '-repo', 'sess-b.jsonl'), line('sess-b', 'm3'));
    const storage = memStorage();
    const svc = createUsageIngestion({ storage, sources: sources(), now: () => EPOCH });

    await svc.flush([{ client: 'claude-code', sessionId: 'sess-a' }]);

    expect(storage.inserted.map((e: TokenEvent) => e.dedupKey).sort()).toEqual(['m1', 'm2']);
  });

  it('flush with no sessions reads nothing', async () => {
    fs.writeFileSync(path.join(dir, 'sess-a.jsonl'), line('sess-a', 'm1'));
    const storage = memStorage();
    await createUsageIngestion({ storage, sources: sources() }).flush([]);
    expect(storage.inserted).toEqual([]);
  });

  it('a pass and a flush running at once count each turn once', async () => {
    fs.writeFileSync(path.join(dir, 'sess-a.jsonl'), line('sess-a', 'm1') + line('sess-a', 'm2'));
    const storage = memStorage();
    const svc = createUsageIngestion({ storage, sources: sources(), now: () => EPOCH });

    await Promise.all([svc.runOnce(), svc.flush([{ client: 'claude-code', sessionId: 'sess-a' }]), svc.runOnce()]);

    expect(storage.inserted).toHaveLength(2);
  });

  it('takes the stored epoch, so a restart does not skip sessions written while the server was down', async () => {
    const storage = memStorage();
    await storage.ensureIngestionEpoch('2026-01-01T00:00:00.000Z');
    const f = path.join(dir, 'sess-a.jsonl');
    fs.writeFileSync(f, line('sess-a', 'm1'));
    const written = new Date('2026-06-01T00:00:00Z'); // after the stored epoch, before "now"
    fs.utimesSync(f, written, written);

    await createUsageIngestion({ storage, sources: sources() }).runOnce();

    expect(storage.inserted).toHaveLength(1);
  });

  it('on its very first run it skips the backlog written before it', async () => {
    const f = path.join(dir, 'sess-old.jsonl');
    fs.writeFileSync(f, line('sess-old', 'm1'));
    const old = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(f, old, old);
    const storage = memStorage();

    await createUsageIngestion({ storage, sources: sources() }).runOnce();

    expect(storage.inserted).toHaveLength(0);
  });

  it('a second pass does not start until the first has finished (passes are serialized)', async () => {
    fs.writeFileSync(path.join(dir, 'sess-a.jsonl'), line('sess-a', 'm1'));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let inside = 0;
    let maxInside = 0;
    const slowParser = (text: string, sp: string, base: number) => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      return [] as TokenEvent[];
    };
    const storage = memStorage();
    // Hold the first pass inside the store, after its parser ran.
    let firstState = true;
    let heldNow!: () => void;
    const firstHeld = new Promise<void>((r) => { heldNow = r; });
    const setState = storage.setIngestionState.bind(storage);
    storage.setIngestionState = async (st: IngestionState) => {
      if (firstState) { firstState = false; heldNow(); await gate; }
      inside--;
      return setState(st);
    };
    const svc = createUsageIngestion({ storage, sources: [{ client: 'claude-code', rootDir: dir, matches: (r: string) => r.endsWith('.jsonl'), parser: slowParser }], now: () => EPOCH });

    const first = svc.runOnce();
    fs.appendFileSync(path.join(dir, 'sess-a.jsonl'), line('sess-a', 'm2'));
    const second = svc.flush([{ client: 'claude-code', sessionId: 'sess-a' }]);
    await firstHeld;
    // Give the flush every chance to start while the first pass is held.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(maxInside).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(maxInside).toBe(1);
  });
});

