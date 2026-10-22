/**
 * Story 3a — upgradeState file-backed persistence helper.
 *
 * Stores the local "last upgrade directive applied" state so a self-restarting
 * upgrade (the new server boots after `agenfk upgrade` killed the old one)
 * can reconcile the directive without re-running it and emit the missing
 * outcome event.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readUpgradeState, writeUpgradeState, clearUpgradeState } from '../hub/upgradeState';

describe('upgradeState — file-backed persistence', () => {
  let dbDir: string;
  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-upgrade-state-'));
  });
  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('returns null when nothing has been written yet', () => {
    expect(readUpgradeState(dbDir)).toBeNull();
  });

  it('round-trips a started state', () => {
    writeUpgradeState(dbDir, { lastDirectiveId: 'd-1', outcome: 'started' });
    expect(readUpgradeState(dbDir)).toEqual({ lastDirectiveId: 'd-1', outcome: 'started' });
  });

  it('round-trips a succeeded state with resultVersion', () => {
    writeUpgradeState(dbDir, {
      lastDirectiveId: 'd-2',
      outcome: 'succeeded',
      resultVersion: '0.3.1',
      finishedAt: '2026-05-05T20:00:00Z',
    });
    const got = readUpgradeState(dbDir);
    expect(got).toEqual({
      lastDirectiveId: 'd-2',
      outcome: 'succeeded',
      resultVersion: '0.3.1',
      finishedAt: '2026-05-05T20:00:00Z',
    });
  });

  it('round-trips a failed state with error', () => {
    writeUpgradeState(dbDir, {
      lastDirectiveId: 'd-3',
      outcome: 'failed',
      error: 'install.mjs exit 1',
    });
    expect(readUpgradeState(dbDir)?.outcome).toBe('failed');
    expect(readUpgradeState(dbDir)?.error).toBe('install.mjs exit 1');
  });

  it('returns null when the file is malformed JSON', () => {
    const file = path.join(dbDir, 'upgrade-state.json');
    fs.writeFileSync(file, '{ this is not json');
    expect(readUpgradeState(dbDir)).toBeNull();
  });

  it('returns null when the file is missing required fields', () => {
    const file = path.join(dbDir, 'upgrade-state.json');
    fs.writeFileSync(file, JSON.stringify({ outcome: 'succeeded' })); // no lastDirectiveId
    expect(readUpgradeState(dbDir)).toBeNull();
  });

  it('clearUpgradeState removes the file', () => {
    writeUpgradeState(dbDir, { lastDirectiveId: 'd-1', outcome: 'succeeded' });
    expect(readUpgradeState(dbDir)).not.toBeNull();
    clearUpgradeState(dbDir);
    expect(readUpgradeState(dbDir)).toBeNull();
  });

  it('clearUpgradeState is a no-op when the file does not exist', () => {
    expect(() => clearUpgradeState(dbDir)).not.toThrow();
  });

  it('writes atomically via tmp+rename (no half-written file on crash)', () => {
    // Hard to assert atomicity in a unit test directly, but we can at least
    // verify the helper does NOT leave a tmp file lying around in the
    // happy path (a sentinel that the rename happened).
    writeUpgradeState(dbDir, { lastDirectiveId: 'd-x', outcome: 'started' });
    const entries = fs.readdirSync(dbDir);
    expect(entries.filter(n => n.endsWith('.tmp'))).toEqual([]);
  });
});

// Security audit, Fix 7 (AEF-5): the file was written with no mode, so it landed
// 0644 under the process umask. It holds no secret, but it sits beside files that
// do, and every other file this client writes in ~/.agenfk is 0600 (hub.json,
// the deadletter, the audit log). Consistency, not an exploit.
describe.skipIf(process.platform === 'win32')('upgradeState — file mode', () => {
  let dbDir: string;
  beforeEach(() => { dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-upgrade-state-mode-')); });
  afterEach(() => { fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
  const stateFile = () => fs.readdirSync(dbDir).filter(f => f.startsWith('upgrade-state'));

  it('writes upgrade-state.json owner-only, even under a permissive umask', () => {
    const before = process.umask(0o022);
    try {
      writeUpgradeState(dbDir, { lastDirectiveId: 'd-1', outcome: 'started' });
    } finally { process.umask(before); }
    const files = stateFile();
    expect(files).toEqual(['upgrade-state.json']);
    expect(modeOf(path.join(dbDir, files[0]))).toBe(0o600);
  });

  it('tightens a state file an older version left world-readable', () => {
    const p = path.join(dbDir, 'upgrade-state.json');
    fs.writeFileSync(p, JSON.stringify({ lastDirectiveId: 'old', outcome: 'started' }), { mode: 0o644 });
    fs.chmodSync(p, 0o644);
    writeUpgradeState(dbDir, { lastDirectiveId: 'd-2', outcome: 'started' });
    expect(modeOf(p)).toBe(0o600);
    expect(readUpgradeState(dbDir)).toEqual({ lastDirectiveId: 'd-2', outcome: 'started' });
  });

  it('leaves no temp file behind', () => {
    writeUpgradeState(dbDir, { lastDirectiveId: 'd-3', outcome: 'started' });
    expect(fs.readdirSync(dbDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});
