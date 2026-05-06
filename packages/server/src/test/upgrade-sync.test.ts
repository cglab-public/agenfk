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

function makeFakes(opts: {
  directive?: any;
  spawnExitCode?: number;
  spawnStdout?: string;
  installedVersion?: string | null;
} = {}) {
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
  // Default: pretend the install actually landed the target version, so the
  // existing tests stay happy. Cases that exercise the on-disk verification
  // override this explicitly.
  const readInstalledVersionImpl = vi.fn((): string | null => {
    if (opts.installedVersion !== undefined) return opts.installedVersion;
    if (opts.directive?.targetVersion) return opts.directive.targetVersion;
    return null;
  });
  return { events, flushNowCalls, fetchImpl, recordEvent, flushNow, spawnImpl, readInstalledVersionImpl };
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
      readInstalledVersionImpl: f.readInstalledVersionImpl,
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
      readInstalledVersionImpl: f.readInstalledVersionImpl,
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
      readInstalledVersionImpl: f.readInstalledVersionImpl,
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
      readInstalledVersionImpl: f.readInstalledVersionImpl,
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

  it('emits failed when CLI exits 0 + emits no JSON envelope BUT the on-disk version is unchanged (regression for directive→0.3.0-beta.24, 97f4db4c)', async () => {
    const f = makeFakes({
      directive: { directiveId: 'd-real', targetVersion: '0.3.0-beta.24' },
      spawnExitCode: 0,
      // CLI was killed mid-install before emitting JSON.
      spawnStdout: 'Some non-JSON noise that snuck in\n',
      installedVersion: '0.2.28', // unchanged — install never landed
    });
    await reconcileUpgradeDirective({
      dbDir,
      currentVersion: '0.2.28',
      fetchImpl: f.fetchImpl,
      recordEvent: f.recordEvent,
      flushNow: f.flushNow,
      spawnImpl: f.spawnImpl,
      readInstalledVersionImpl: f.readInstalledVersionImpl,
      hubUrl: 'http://hub.test',
      installationId: 'inst-1',
      hubToken: 't',
    });
    const failed = f.events.find(e => e.type === 'fleet:upgrade:failed');
    expect(failed).toBeDefined();
    // Error must mention both the intent and the actual on-disk version.
    expect(failed!.payload.error).toMatch(/0\.3\.0-beta\.24/);
    expect(failed!.payload.error).toMatch(/0\.2\.28/);
    expect(readUpgradeState(dbDir)?.outcome).toBe('failed');
  });

  it('emits succeeded when on-disk version matches intent even if CLI was killed mid-emit (no JSON, exit 0)', async () => {
    // The install replaced files on disk but the parent CLI process died before
    // writing its `{"status":"upgraded"}` line. We trust the on-disk truth.
    const f = makeFakes({
      directive: { directiveId: 'd-killed', targetVersion: '0.3.0-beta.25' },
      spawnExitCode: 0,
      spawnStdout: '', // nothing emitted
      installedVersion: '0.3.0-beta.25',
    });
    await reconcileUpgradeDirective({
      dbDir,
      currentVersion: '0.3.0-beta.24',
      fetchImpl: f.fetchImpl,
      recordEvent: f.recordEvent,
      flushNow: f.flushNow,
      spawnImpl: f.spawnImpl,
      readInstalledVersionImpl: f.readInstalledVersionImpl,
      hubUrl: 'http://hub.test',
      installationId: 'inst-1',
      hubToken: 't',
    });
    expect(f.events.map(e => e.type)).toContain('fleet:upgrade:succeeded');
    const succeeded = f.events.find(e => e.type === 'fleet:upgrade:succeeded')!;
    expect(succeeded.payload.resultVersion).toBe('0.3.0-beta.25');
    expect(readUpgradeState(dbDir)).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Stale-CLI bootstrap recovery
  //
  // Pre-upgrade fleet clients installed before the `--version <ver>` option
  // existed treat that flag as commander's built-in --version: they print
  // their own version and exit 0 with no install side-effects. The reconciler
  // detects this (exit 0 + no parsed status + on-disk unchanged + on-disk ===
  // currentVersion) and tries a self-extract fallback that downloads the
  // tarball and untars it directly into the install root, bypassing the
  // bootstrap-stuck CLI entirely.
  // ──────────────────────────────────────────────────────────────────────────

  it('stale CLI: self-extract recovery succeeds → emits succeeded with recoveredVia=self-extract', async () => {
    let onDiskNow = '0.2.28'; // pre-upgrade
    const f = makeFakes({
      directive: { directiveId: 'd-stale-1', targetVersion: '0.3.0-beta.27' },
      spawnExitCode: 0,
      // Stale CLI prints its own version then exits.
      spawnStdout: '0.2.28\n',
    });
    // Make readInstalledVersion observe the on-disk swap performed by self-extract.
    f.readInstalledVersionImpl.mockImplementation(() => onDiskNow);
    const selfExtractImpl = vi.fn(async (_input: { installRoot: string; targetVersion: string }) => {
      onDiskNow = '0.3.0-beta.27';
      return { ok: true as const };
    });
    await reconcileUpgradeDirective({
      dbDir,
      currentVersion: '0.2.28',
      fetchImpl: f.fetchImpl,
      recordEvent: f.recordEvent,
      flushNow: f.flushNow,
      spawnImpl: f.spawnImpl,
      readInstalledVersionImpl: f.readInstalledVersionImpl,
      installRoot: '/fake/install/root',
      selfExtractImpl,
      hubUrl: 'http://hub.test',
      installationId: 'inst-1',
      hubToken: 't',
    });
    expect(selfExtractImpl).toHaveBeenCalledTimes(1);
    expect(selfExtractImpl.mock.calls[0][0]).toMatchObject({
      installRoot: '/fake/install/root',
      targetVersion: '0.3.0-beta.27',
    });
    const succeeded = f.events.find(e => e.type === 'fleet:upgrade:succeeded');
    expect(succeeded).toBeDefined();
    expect(succeeded!.payload.resultVersion).toBe('0.3.0-beta.27');
    expect(succeeded!.payload.recoveredVia).toBe('self-extract');
    // No failed event should also be present.
    expect(f.events.find(e => e.type === 'fleet:upgrade:failed')).toBeUndefined();
    // State cleared after settled outcome.
    expect(readUpgradeState(dbDir)).toBeNull();
  });

  it('stale CLI: self-extract failure → emits failed with predates-pinned-version remediation hint', async () => {
    const f = makeFakes({
      directive: { directiveId: 'd-stale-2', targetVersion: '0.3.0-beta.27' },
      spawnExitCode: 0,
      spawnStdout: '0.2.28\n',
      installedVersion: '0.2.28',
    });
    const selfExtractImpl = vi.fn(async () => ({ ok: false as const, error: 'curl: 404' }));
    await reconcileUpgradeDirective({
      dbDir,
      currentVersion: '0.2.28',
      fetchImpl: f.fetchImpl,
      recordEvent: f.recordEvent,
      flushNow: f.flushNow,
      spawnImpl: f.spawnImpl,
      readInstalledVersionImpl: f.readInstalledVersionImpl,
      installRoot: '/fake/install/root',
      selfExtractImpl,
      hubUrl: 'http://hub.test',
      installationId: 'inst-1',
      hubToken: 't',
    });
    expect(selfExtractImpl).toHaveBeenCalledTimes(1);
    const failed = f.events.find(e => e.type === 'fleet:upgrade:failed');
    expect(failed).toBeDefined();
    // Error must explain WHY (CLI predates --version) and HOW (manual remediation),
    // not just the cryptic "exited 0 but on-disk version is X" message.
    expect(failed!.payload.error).toMatch(/predates|does not recognise|--version/i);
    expect(failed!.payload.error).toMatch(/agenfk upgrade --beta|npx github:cglab-public\/agenfk/);
    // Underlying self-extract error should be referenced for diagnosis.
    expect(failed!.payload.error).toMatch(/curl: 404/);
    expect(readUpgradeState(dbDir)?.outcome).toBe('failed');
  });

  it('does NOT attempt self-extract when the CLI clearly errored non-zero (regression for the existing happy-path failure mode)', async () => {
    const f = makeFakes({
      directive: { directiveId: 'd-non-stale', targetVersion: '0.3.1' },
      spawnExitCode: 1,
      spawnStdout: '{"status":"failed","error":"install.mjs exit 2"}',
      installedVersion: '0.3.0',
    });
    const selfExtractImpl = vi.fn(async () => ({ ok: true as const }));
    await reconcileUpgradeDirective({
      dbDir,
      currentVersion: '0.3.0',
      fetchImpl: f.fetchImpl,
      recordEvent: f.recordEvent,
      flushNow: f.flushNow,
      spawnImpl: f.spawnImpl,
      readInstalledVersionImpl: f.readInstalledVersionImpl,
      installRoot: '/fake/install/root',
      selfExtractImpl,
      hubUrl: 'http://hub.test',
      installationId: 'inst-1',
      hubToken: 't',
    });
    // Stale-CLI heuristic must NOT match a CLI that returned a real failure.
    expect(selfExtractImpl).not.toHaveBeenCalled();
    expect(f.events.find(e => e.type === 'fleet:upgrade:failed')).toBeDefined();
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
      readInstalledVersionImpl: f.readInstalledVersionImpl,
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
