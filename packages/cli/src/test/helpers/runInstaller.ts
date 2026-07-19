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

function run(script: string, args: string[], home: string, extraEnv: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { HOME: home, USERPROFILE: home, PATH: '', NODE_ENV: 'production', ...extraEnv },
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
  rmSync(home, { recursive: true, force: true });
}

/** Run scripts/install.mjs into a throwaway HOME (created if not supplied). */
export function runInstall(args: string[] = [], home = makeHome('agenfk-install')): RunResult {
  return run(INSTALL, args, home);
}

/** Run scripts/uninstall.mjs against an existing throwaway HOME. */
export function runUninstall(args: string[], home: string): RunResult {
  return run(UNINSTALL, args, home);
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
