/**
 * Story 3b — upgradeSync polling reconciler + boot-time outcome replay.
 *
 * The module exports two pure-ish functions that startUpgradeSync wires into
 * a polling timer. We test the pure functions directly with injected deps so
 * we don't have to mock setTimeout / axios / child_process all at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  reconcileUpgradeDirective,
  replayPendingUpgradeOutcome,
} from '../hub/upgradeSync';
import { readUpgradeState, writeUpgradeState } from '../hub/upgradeState';

let dbDir: string;
beforeEach(() => { dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-upgrade-sync-')); });
afterEach(() => { fs.rmSync(dbDir, { recursive: true, force: true }); });

interface RecordedEvent { type: string; payload: any }

function makeFakes(opts: { directive?: any; spawnExitCode?: number; spawnStdout?: string } = {}) {
  const events: RecordedEvent[] = [];
  const flushNowCalls: number[] = [];
  const fetchImpl = vi.fn(async () => ({
    status: opts.directive ? 200 : 204,
    json: async () => opts.directive,
  }));
  const recordEvent = vi.fn((e: any) => { events.push({ type: e.type, payload: e.payload }); });
  const flushNow = vi.fn(async (timeoutMs?: number) => { flushNowCalls.push(timeoutMs ?? 5000); });
  const spawnImpl = vi.fn((_cmd: string, _args: string[]) => ({
    exitCode: opts.spawnExitCode ?? 0,
    stdout: opts.spawnStdout ?? '{"status":"upgraded","fromVersion":"0.3.0","toVersion":"0.3.1"}',
  }));
  return { events, flushNowCalls, fetchImpl, recordEvent, flushNow, spawnImpl };
}

describe('Story 3b — reconcileUpgradeDirective', () => {
  it('no-op when the hub returns 204 (no pending directive)', async () => {
    const f = makeFakes({ directive: undefined });
    await reconcileUpgradeDirective({
      dbDir,
      currentVersion: '0.3.0',
      fetchImpl: f.fetchImpl,
      recordEvent: f.recordEvent,
      flushNow: f.flushNow,
      spawnImpl: f.spawnImpl,
      hubUrl: 'http://hub.test',
      installationId: 'inst-1',
      hubToken: 't',
    });
    expect(f.events).toHaveLength(0);
    expect(f.spawnImpl).not.toHaveBeenCalled();
  });

  it('skips when state already shows this directive was applied', async () => {
    writeUpgradeState(dbDir, { lastDirectiveId: 'd-1', outcome: 'succeeded' });
    const f = makeFakes({ directive: { directiveId: 'd-1', targetVersion: '0.3.1' } });
    await reconcileUpgradeDirective({
      dbDir,
      currentVersion: '0.3.1',
      fetchImpl: f.fetchImpl,
      recordEvent: f.recordEvent,
      flushNow: f.flushNow,
      spawnImpl: f.spawnImpl,
      hubUrl: 'http://hub.test',
      installationId: 'inst-1',
      hubToken: 't',
    });
    expect(f.events).toHaveLength(0);
    expect(f.spawnImpl).not.toHaveBeenCalled();
  });

  it('emits started + flushes + spawns CLI + emits succeeded for a new directive (noop CLI path)', async () => {
    const f = makeFakes({
      directive: { directiveId: 'd-2', targetVersion: '0.3.0' },
      spawnStdout: '{"status":"noop","fromVersion":"0.3.0","toVersion":"0.3.0"}',
    });
    await reconcileUpgradeDirective({
      dbDir,
      currentVersion: '0.3.0',
      fetchImpl: f.fetchImpl,
      recordEvent: f.recordEvent,
      flushNow: f.flushNow,
      spawnImpl: f.spawnImpl,
      hubUrl: 'http://hub.test',
      installationId: 'inst-1',
      hubToken: 't',
    });
    const types = f.events.map(e => e.type);
    expect(types).toContain('fleet:upgrade:started');
    expect(types).toContain('fleet:upgrade:succeeded');
    expect(f.flushNowCalls.length).toBeGreaterThanOrEqual(1);
    expect(f.spawnImpl).toHaveBeenCalledTimes(1);
    const succeeded = f.events.find(e => e.type === 'fleet:upgrade:succeeded')!;
    expect(succeeded.payload.directiveId).toBe('d-2');
    expect(succeeded.payload.resultVersion).toBe('0.3.0');
    // State should be cleared after a successful settled outcome.
    expect(readUpgradeState(dbDir)).toBeNull();
  });

  it('emits failed when the CLI exits non-zero', async () => {
    const f = makeFakes({
      directive: { directiveId: 'd-3', targetVersion: '0.3.1' },
      spawnExitCode: 1,
      spawnStdout: '{"status":"failed","fromVersion":"0.3.0","toVersion":"0.3.1","error":"install.mjs exit 1"}',
    });
    await reconcileUpgradeDirective({
      dbDir,
      currentVersion: '0.3.0',
      fetchImpl: f.fetchImpl,
      recordEvent: f.recordEvent,
      flushNow: f.flushNow,
      spawnImpl: f.spawnImpl,
      hubUrl: 'http://hub.test',
      installationId: 'inst-1',
      hubToken: 't',
    });
    const failed = f.events.find(e => e.type === 'fleet:upgrade:failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.error).toMatch(/install\.mjs/);
    // Persisted as failed so we don't re-spawn on the next poll.
    expect(readUpgradeState(dbDir)?.outcome).toBe('failed');
  });

  it('writes upgrade state to "started" before flushNow returns', async () => {
    let stateAtFlush: any = null;
    const f = makeFakes({
      directive: { directiveId: 'd-4', targetVersion: '0.3.0' },
      spawnStdout: '{"status":"noop","fromVersion":"0.3.0","toVersion":"0.3.0"}',
    });
    f.flushNow.mockImplementation(async () => {
      stateAtFlush = readUpgradeState(dbDir);
    });
    await reconcileUpgradeDirective({
      dbDir,
      currentVersion: '0.3.0',
      fetchImpl: f.fetchImpl,
      recordEvent: f.recordEvent,
      flushNow: f.flushNow,
      spawnImpl: f.spawnImpl,
      hubUrl: 'http://hub.test',
      installationId: 'inst-1',
      hubToken: 't',
    });
    // The "started" outcome must be persisted BEFORE we surrender control to
    // the upgrade child process, so a self-restarting upgrade can be replayed.
    expect(stateAtFlush?.lastDirectiveId).toBe('d-4');
    expect(stateAtFlush?.outcome).toBe('started');
  });
});

describe('Story 3b — replayPendingUpgradeOutcome (boot-time replay)', () => {
  it('does nothing when no upgrade state exists', async () => {
    const f = makeFakes();
    await replayPendingUpgradeOutcome({
      dbDir,
      currentVersion: '0.3.0',
      recordEvent: f.recordEvent,
      installationId: 'inst-1',
    });
    expect(f.events).toHaveLength(0);
  });

  it('does nothing when state is already settled (succeeded)', async () => {
    writeUpgradeState(dbDir, { lastDirectiveId: 'd-1', outcome: 'succeeded' });
    const f = makeFakes();
    await replayPendingUpgradeOutcome({
      dbDir,
      currentVersion: '0.3.0',
      recordEvent: f.recordEvent,
      installationId: 'inst-1',
    });
    expect(f.events).toHaveLength(0);
  });

  it('emits succeeded + clears state when started + version changed as expected', async () => {
    writeUpgradeState(dbDir, {
      lastDirectiveId: 'd-1',
      outcome: 'started',
      resultVersion: '0.3.1', // intent
    });
    const f = makeFakes();
    await replayPendingUpgradeOutcome({
      dbDir,
      currentVersion: '0.3.1',
      recordEvent: f.recordEvent,
      installationId: 'inst-1',
    });
    expect(f.events.map(e => e.type)).toEqual(['fleet:upgrade:succeeded']);
    expect(f.events[0].payload.directiveId).toBe('d-1');
    expect(f.events[0].payload.resultVersion).toBe('0.3.1');
    expect(readUpgradeState(dbDir)).toBeNull();
  });

  it('emits failed + clears state when started but version did NOT change', async () => {
    writeUpgradeState(dbDir, {
      lastDirectiveId: 'd-1',
      outcome: 'started',
      resultVersion: '0.3.1', // intent
    });
    const f = makeFakes();
    await replayPendingUpgradeOutcome({
      dbDir,
      currentVersion: '0.3.0', // didn't move
      recordEvent: f.recordEvent,
      installationId: 'inst-1',
    });
    expect(f.events.map(e => e.type)).toEqual(['fleet:upgrade:failed']);
    expect(f.events[0].payload.error).toBeTruthy();
    expect(readUpgradeState(dbDir)).toBeNull();
  });
});
