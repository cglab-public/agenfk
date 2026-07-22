import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import type { AgentRun } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tailRunsOnce, type RunEventBroadcast } from '../agent-runs/tailer';

const asst = (tool: string, cmd: string, tokens: number) => JSON.stringify({
  type: 'message', message: { role: 'assistant',
    content: [{ type: 'toolCall', id: 't', name: tool, arguments: { command: cmd, path: cmd } }],
    usage: { totalTokens: tokens } } });

describe('tailRunsOnce resolves a glob sourcePath (CGLAB-23)', () => {
  let storage: SQLiteStorageProvider;
  let emitted: RunEventBroadcast[];
  const emit = (b: RunEventBroadcast) => emitted.push(b);
  beforeEach(async () => {
    storage = new SQLiteStorageProvider();
    await storage.init({ path: ':memory:' });
    emitted = [];
  });

  it('ingests the worker session file even when sourcePath is a glob pattern', async () => {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agenfk-tailer-glob-'));
    try {
      const dir = path.join(base, 'encoded-cwd'); fs.mkdirSync(dir);
      const file = path.join(dir, '2026-07-22T00-00-00_sess-glob.jsonl');
      fs.writeFileSync(file, asst('bash', 'npx vitest', 100));

      const run: AgentRun = {
        id: 'run-glob', itemId: 'item-glob', step: 'IN_PROGRESS', actor: 'worker',
        harness: 'pi', model: 'qwen3.6:27b', sessionId: 'sess-glob',
        sourcePath: path.join(base, '*', '*_sess-glob.jsonl'),
        status: 'running', startedAt: '2026-07-22T00:00:00.000Z',
      };
      await storage.createAgentRun(run);

      const appended = await tailRunsOnce(storage, emit);
      expect(appended).toHaveLength(1);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ itemId: 'item-glob', runId: 'run-glob' });
      expect(emitted[0].event).toMatchObject({ kind: 'tool', tool: 'bash' });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});