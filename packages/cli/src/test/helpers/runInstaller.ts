/**
 * Test helper: run the real installer/uninstaller/bootstrap scripts against a
 * throwaway $HOME so tests can assert on what they actually write, instead of
 * grepping install.mjs / uninstall.mjs / bin/agenfk.js as strings.
 *
 * Safety: the child runs with HOME/USERPROFILE pointed at a temp dir and an
 * empty PATH (so real claude/codex/gemini/npm CLIs can't be found — those steps
 * self-skip). install.mjs's cleanStaleSrc() is additionally guarded to skip when
 * a `.git` dir is present at the repo root, so running it from this checkout
 * never deletes the workspace source directories.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fakeBin, type FakeBin } from './fakeBin';

export const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const INSTALL = path.join(REPO_ROOT, 'scripts', 'install.mjs');
const UNINSTALL = path.join(REPO_ROOT, 'scripts', 'uninstall.mjs');
const BOOTSTRAP = path.join(REPO_ROOT, 'bin', 'agenfk.js');

export interface RunResult {
  home: string;
  status: number | null;
  stdout: string;
  stderr: string;
  /** join a path under the throwaway HOME */
  p: (...segs: string[]) => string;
}

function run(script: string, args: string[], home: string, opts: { cwd?: string; extraEnv?: Record<string, string> } = {}): RunResult {
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: opts.cwd,
    // VITEST is carried in deliberately. This env is built from scratch rather
    // than inherited, so without it the child runs with every test-runner guard
    // OFF — no telemetry guard, no federation guard, and no net guard — which is
    // the one path where an unmocked client could quietly start talking to the
    // internet again. NODE_ENV stays 'production' because the installer's own
    // behaviour under test depends on it.
    env: {
      HOME: home, USERPROFILE: home, PATH: '', NODE_ENV: 'production', VITEST: '1',
      // Never the developer's running AgEnFK server (default port): the installer asks it whether
      // Airlock is in use (CGLAB-696), and would then download smolvm into the throwaway HOME.
      AGENFK_API_URL: 'http://127.0.0.1:9',
      ...(opts.extraEnv || {}),
    },
  });
  return {
    home,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    p: (...segs: string[]) => path.join(home, ...segs),
  };
}

/** Fresh throwaway HOME directory. Caller must cleanupHome() in afterAll/afterEach. */
export function makeHome(label = 'agenfk-test'): string {
  return mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

export function cleanupHome(home: string): void {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/*
 * The installer runs `npm ci` and (#232) fails the install when it fails. The
 * sandbox PATH used to hold no npm at all, so every spec ran the "npm ci
 * failed" path and passed only because that failure was a warning. A stub npm
 * that succeeds (and touches nothing) stands in for a working one; a spec that
 * wants npm to fail passes its own PATH. One stub dir per process, reused.
 */
let okNpm: FakeBin | undefined;
export function workingNpmEnv(): NodeJS.ProcessEnv {
  okNpm ??= fakeBin(mkdtempSync(path.join(os.tmpdir(), 'agenfk-ok-npm-')), { stubs: { npm: '' } });
  return okNpm.env();
}

/** Run scripts/install.mjs into a throwaway HOME (created if not supplied). */
export function runInstall(args: string[] = [], home = makeHome('agenfk-install'), cwd?: string, extraEnv?: Record<string, string>): RunResult {
  return run(INSTALL, args, home, { cwd, extraEnv: { ...(workingNpmEnv() as Record<string, string>), ...(extraEnv || {}) } });
}

/** Run scripts/uninstall.mjs against an existing throwaway HOME. */
export function runUninstall(args: string[], home: string, cwd?: string, extraEnv?: Record<string, string>): RunResult {
  return run(UNINSTALL, args, home, { cwd, extraEnv });
}

/** Run bin/agenfk.js (the npx bootstrap) with a given cwd via extra env. */
export function runBootstrap(args: string[], home = makeHome('agenfk-bootstrap'), cwd?: string): RunResult {
  const res = spawnSync(process.execPath, [BOOTSTRAP, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd,
    env: { HOME: home, USERPROFILE: home, PATH: '', NODE_ENV: 'production' },
  });
  return {
    home,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    p: (...segs: string[]) => path.join(home, ...segs),
  };
}
