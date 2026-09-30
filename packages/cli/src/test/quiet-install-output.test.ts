/**
 * e04dac92 (CGLAB-164): install and upgrade print a few lines, not a hundred.
 *
 * An upgrade used to print ~130 lines: a `[n/14]` header per step, an
 * `Installed: <path>` per skill, command and hook, a "not found, skipping" per
 * client the user does not have, raw `npm ci` output, a telemetry notice and a
 * five-line usage blurb - on every upgrade. Detail now lives behind
 * `--debuglog` only; warnings and errors always print; a first install gets a
 * short next-steps block and the telemetry notice once; `--quiet` (what
 * `agenfk upgrade` passes, since it prints its own summary) prints only
 * warnings. The figlet banner the npx bootstrap printed first is gone too.
 *
 * Behaviour-based: runs the real installer / bootstrap against a throwaway HOME.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { runInstall, runBootstrap, makeHome, cleanupHome, REPO_ROOT, type RunResult } from './helpers/runInstaller';

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const lines = (r: RunResult) => strip(`${r.stdout}${r.stderr}`).split('\n').map((l) => l.trim()).filter(Boolean);
/** Warnings always print; the sandbox (no npm on PATH) produces some. They are not the noise under test. */
const isWarning = (l: string) => l.startsWith('⚠');
const nonWarnings = (r: RunResult) => lines(r).filter((l) => !isWarning(l));

const STEP_HEADER = /\[\d+[a-z]?(-\d+)?\/14\]/;

describe('install.mjs - a first install is short', () => {
  let r: RunResult;
  beforeAll(() => { r = runInstall(['--rules-scope=global']); });
  afterAll(() => cleanupHome(r.home));

  it('succeeds', () => {
    expect(r.status).toBe(0);
  });

  it('prints no step headers and no per-file lines', () => {
    const out = lines(r);
    expect(out.filter((l) => STEP_HEADER.test(l))).toEqual([]);
    expect(out.filter((l) => /^(Installed|Written|Registered|Removed|Pruned)\b/.test(l))).toEqual([]);
    expect(out.filter((l) => /not found\.? Skipping/i.test(l))).toEqual([]);
  });

  it('says it installed, then how to start and how to opt out of telemetry - in at most 8 lines', () => {
    const out = nonWarnings(r);
    expect(out[0]).toMatch(/^✓ AgEnFK \S+ installed/);
    expect(out.join('\n')).toMatch(/agenfk up/);
    expect(out.join('\n')).toMatch(/agenfk config set telemetry false/);
    expect(out.length).toBeLessThanOrEqual(8);
  });

  it('prefixes every warning it does print with ⚠, so a reader can tell them apart', () => {
    // The sandbox has no npm on PATH, so the npm ci warning must appear, and as a warning.
    const npm = lines(r).filter((l) => /npm ci/.test(l));
    expect(npm.length).toBeGreaterThan(0);
    for (const l of npm) expect(l.startsWith('⚠')).toBe(true);
  });
});

describe('install.mjs - a re-install (the upgrade path) is one line', () => {
  let home: string;
  let second: RunResult;
  beforeAll(() => {
    home = makeHome('agenfk-reinstall');
    runInstall(['--rules-scope=global'], home);
    second = runInstall(['--rules-scope=global'], home);
  });
  afterAll(() => cleanupHome(home));

  it('succeeds with a single non-warning line', () => {
    expect(second.status).toBe(0);
    expect(nonWarnings(second)).toHaveLength(1);
    expect(nonWarnings(second)[0]).toMatch(/^✓ AgEnFK \S+ installed/);
  });

  it('repeats neither the telemetry notice nor the usage instructions', () => {
    const out = lines(second).join('\n');
    expect(out).not.toMatch(/Telemetry|telemetry false/);
    expect(out).not.toMatch(/Usage Instructions|agenfk up/);
  });
});

describe('install.mjs --quiet (what `agenfk upgrade` runs) prints only warnings', () => {
  let home: string;
  let quiet: RunResult;
  beforeAll(() => {
    home = makeHome('agenfk-quiet');
    runInstall(['--rules-scope=global'], home);
    quiet = runInstall(['--rules-scope=global', '--quiet'], home);
  });
  afterAll(() => cleanupHome(home));

  it('succeeds and prints nothing but warnings', () => {
    expect(quiet.status).toBe(0);
    expect(nonWarnings(quiet)).toEqual([]);
  });

  it('still prints the warnings (the sandbox has no npm)', () => {
    expect(lines(quiet).some((l) => /^⚠ npm ci failed/.test(l))).toBe(true);
  });
});

describe("install.mjs prints a failing child's own output", () => {
  let r: RunResult;
  beforeAll(() => {
    const home = makeHome('agenfk-npmfail');
    const bin = path.join(home, 'fakebin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "npm ERR! code ETARGET (fake)"\nexit 1\n', 'utf8');
    chmodSync(path.join(bin, 'npm'), 0o755);
    r = runInstall(['--rules-scope=global'], home, undefined, { PATH: bin });
  });
  afterAll(() => cleanupHome(r.home));

  it('shows what npm said, then the warning', () => {
    if (process.platform === 'win32') return; // a POSIX shell script stands in for npm
    const out = lines(r);
    const said = out.indexOf('npm ERR! code ETARGET (fake)');
    expect(said).toBeGreaterThan(-1);
    expect(out[said + 1]).toMatch(/^⚠ npm ci failed \(exit 1\)/);
  });
});

describe('install.mjs - a first install is one even when ~/.agenfk/config.json already exists', () => {
  // `agenfk config set`, the desktop's settings and hub setup all write that file.
  let r: RunResult;
  beforeAll(() => {
    const home = makeHome('agenfk-preconfig');
    mkdirSync(path.join(home, '.agenfk'), { recursive: true });
    writeFileSync(path.join(home, '.agenfk', 'config.json'), JSON.stringify({ telemetry: true }), 'utf8');
    r = runInstall(['--rules-scope=global'], home);
  });
  afterAll(() => cleanupHome(r.home));

  it('still shows the next steps and the telemetry notice', () => {
    const out = nonWarnings(r).join('\n');
    expect(out).toMatch(/agenfk up/);
    expect(out).toMatch(/agenfk config set telemetry false/);
  });
});

describe('install.mjs --debuglog keeps the step-by-step log', () => {
  let r: RunResult;
  beforeAll(() => { r = runInstall(['--rules-scope=global', '--debuglog']); });
  afterAll(() => cleanupHome(r.home));

  it('prints the step headers and what each step wrote', () => {
    const out = lines(r);
    expect(out.some((l) => /\[1\/14\]/.test(l))).toBe(true);
    expect(out.some((l) => /\[14\/14\]/.test(l))).toBe(true);
    expect(out.some((l) => /^Installed: /.test(l))).toBe(true);
  });
});

describe('bin/agenfk.js (npx bootstrap) prints no ASCII banner', () => {
  let r: RunResult;
  // Run from this checkout: the bootstrap refuses a source checkout, which is
  // enough to see what it prints before doing any work.
  beforeAll(() => { r = runBootstrap([], makeHome('agenfk-bootstrap-banner'), REPO_ROOT); });
  afterAll(() => cleanupHome(r.home));

  it('starts with what it is doing, not with ASCII art', () => {
    const out = strip(`${r.stdout}${r.stderr}`);
    expect(out).toMatch(/Refusing to run the AgEnFK installer/); // guard: it really ran
    expect(out).not.toMatch(/\/_\/|\|_+\||__\/ \|/);
    expect(out).not.toMatch(/=== AgEnFK Installer ===/);
  });
});
