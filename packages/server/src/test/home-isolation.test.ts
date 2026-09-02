/**
 * HOME isolation — the 2026-08-31 / 2026-09-01 clobber incident (item 9c297075).
 *
 * StrykerJS mutation runs wrote test-fixture hub.json values into the REAL
 * ~/.agenfk twice: once losing 57 hub events (WAL-recovered), once destroying
 * the real hub credentials (token rotated; re-login never happened). A third
 * hit surfaced 2026-09-02 during this item's own mutation pass: under the
 * Stryker child-process runner, a process.env.HOME mutation does not reach
 * libuv on this machine (os.homedir() kept returning the machine home), so a
 * test that writes through a HOME-derived path deleted the LIVE
 * ~/.agenfk/server-port file.
 *
 * Structural fixes verified here:
 *  1. Hub/telemetry home paths resolve at CALL time, not import time —
 *     proven by swapping os.homedir() (the single source the getters read)
 *     for a sandbox per test. The homedir mock — rather than an env override —
 *     is what makes this verification environment-independent: the getters
 *     must track whatever os.homedir() returns at call time, in every runner.
 *  2. The vitest runner pins process.env.HOME to a per-run sandbox
 *     (see vitest.config.ts / scripts/vitest-home-pin.mjs) — a JS-level
 *     guarantee for every worker. Under the forks pool (normal runs, CI)
 *     libuv/os.homedir() follows it (asserted below); under Stryker's forced
 *     threads pool the C environ is frozen on this machine, so Stryker must
 *     be launched via `npm run test:stryker` (spawn-time pin + sentinel) —
 *     also asserted below, via the AGENFK_SPAWN_PIN marker.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hubConfigPath } from '../hub/hubClient';
import { defaultDeadletterPath } from '../hub/flusher';
import { agenfkDir } from '@agenfk/telemetry';

// Mockable homedir: delegates to the real one unless a test re-points it.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

// Set by the vitest config BEFORE the HOME pin — the machine's real home.
const REAL_HOME = process.env.AGENFK_REAL_HOME;

describe('home isolation (item 9c297075)', () => {
  it('the vitest runner pins HOME to a per-run sandbox, not the machine home', () => {
    expect(REAL_HOME, 'AGENFK_REAL_HOME unset — the vitest HOME pin is missing').toBeTruthy();
    expect(process.env.HOME).toBeTruthy();
    expect(process.env.HOME, 'test HOME must differ from the real home').not.toBe(REAL_HOME);
    // The sandbox is pre-seeded with the framework dir so code that reads
    // verify-token/server-port gets "absent", not "hostile".
    expect(fs.existsSync(path.join(process.env.HOME!, '.agenfk'))).toBe(true);
  });

  it('os.homedir() honors the pinned HOME — or the run was launched via the spawn-time Stryker guard', () => {
    // Probe the libuv linkage directly: re-point the JS-level HOME and check
    // whether os.homedir() follows.
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-probe-'));
    const prev = process.env.HOME!;
    process.env.HOME = probeDir;
    let follows = false;
    try { follows = os.homedir() === probeDir; } finally { process.env.HOME = prev; }
    if (follows) return; // forks pool (normal runs, CI): libuv linkage holds.
    // Frozen C environ (Stryker threads pool): HOME can only reach
    // os.homedir() if it was baked in at SPAWN time — require the guard's
    // marker so an unguarded Stryker launch fails LOUDLY instead of letting
    // tests silently write into the machine home.
    expect(
      process.env.AGENFK_SPAWN_PIN,
      'os.homedir() linkage is frozen in this runner — launch Stryker via `npm run test:stryker`',
    ).toBe('1');
  });

  it('the hub config path resolves against the CURRENT homedir (lazy, not import-time)', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lazy-'));
    vi.mocked(os.homedir).mockReturnValue(sandbox);
    try {
      expect(hubConfigPath()).toBe(path.join(sandbox, '.agenfk', 'hub.json'));
    } finally {
      vi.mocked(os.homedir).mockRestore();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('the deadletter path resolves against the CURRENT homedir (lazy)', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lazy-'));
    vi.mocked(os.homedir).mockReturnValue(sandbox);
    try {
      expect(defaultDeadletterPath()).toBe(path.join(sandbox, '.agenfk', 'hub-deadletter.jsonl'));
    } finally {
      vi.mocked(os.homedir).mockRestore();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('the telemetry agenfk dir resolves against the CURRENT homedir (lazy)', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lazy-'));
    vi.mocked(os.homedir).mockReturnValue(sandbox);
    try {
      expect(agenfkDir()).toBe(path.join(sandbox, '.agenfk'));
    } finally {
      vi.mocked(os.homedir).mockRestore();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('a write through the lazy hub path lands in the sandbox homedir, never the real home', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lazy-'));
    vi.mocked(os.homedir).mockReturnValue(sandbox);
    try {
      const p = hubConfigPath();
      expect(p.startsWith(sandbox)).toBe(true);
      expect(p.startsWith(REAL_HOME!), 'path must not point into the real home').toBe(false);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ url: 'https://sandbox.example', token: 'test-token', orgId: 'test-org' }));
      expect(JSON.parse(fs.readFileSync(p, 'utf8')).token).toBe('test-token');
      fs.rmSync(p, { force: true });
    } finally {
      vi.mocked(os.homedir).mockRestore();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
