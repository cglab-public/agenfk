import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSourcePath } from '../agent-runs/resolveSource';

describe('resolveSourcePath (CGLAB-23)', () => {
  it('returns a non-glob path unchanged', () => {
    expect(resolveSourcePath('/abs/plain/session.jsonl')).toBe('/abs/plain/session.jsonl');
  });

  it('expands a leading ~ using the injected home dir', () => {
    // Joined natively: `\home\tester\x\session.jsonl` on Windows (#208).
    expect(resolveSourcePath('~/x/session.jsonl', { home: '/home/tester' }))
      .toBe(path.join('/home/tester', 'x', 'session.jsonl'));
  });

  it('resolves a glob written with forward slashes, as the orchestrator registers it, on every OS (#208)', () => {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agenfk-resolvesrc-'));
    try {
      const dir = path.join(base, 'sessionA'); fs.mkdirSync(dir);
      const file = path.join(dir, '2026-01-01T00-00-00_sid.jsonl');
      fs.writeFileSync(file, 'a');
      expect(resolveSourcePath(`${base.replace(/\\/g, '/')}/*/*_sid.jsonl`)).toBe(file);
    } finally {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('resolves a glob to the most-recently-modified matching file', () => {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agenfk-resolvesrc-'));
    try {
      const dirA = path.join(base, 'sessionA'); fs.mkdirSync(dirA);
      const dirB = path.join(base, 'sessionB'); fs.mkdirSync(dirB);
      const older = path.join(dirA, '2026-01-01T00-00-00_sid.jsonl');
      const newer = path.join(dirB, '2026-01-02T00-00-00_sid.jsonl');
      fs.writeFileSync(older, 'a');
      fs.writeFileSync(newer, 'b');
      const t0 = new Date('2026-01-01T00:00:00Z');
      const t1 = new Date('2026-01-02T00:00:00Z');
      fs.utimesSync(older, t0, t0);
      fs.utimesSync(newer, t1, t1);
      const resolved = resolveSourcePath(path.join(base, '*', '*_sid.jsonl'));
      expect(resolved).toBe(newer);
    } finally {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('returns undefined when a glob matches nothing', () => {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agenfk-resolvesrc-'));
    try {
      expect(resolveSourcePath(path.join(base, '*', '*_nomatch.jsonl'))).toBeUndefined();
    } finally {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});