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

  it('round-trips each outcome: started, succeeded with resultVersion, failed with error', () => {
    writeUpgradeState(dbDir, { lastDirectiveId: 'd-1', outcome: 'started' });
    expect(readUpgradeState(dbDir)).toEqual({ lastDirectiveId: 'd-1', outcome: 'started' });

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

    writeUpgradeState(dbDir, { lastDirectiveId: 'd-3', outcome: 'failed', error: 'install.mjs exit 1' });
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
});
