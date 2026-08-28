/**
 * CGLAB-94 / issue #163 — no macOS AppleDouble (`._*`) artifact may reach a
 * platform's skills or commands directory, and uninstall must clean up the ones
 * already-published releases left behind.
 *
 * Claude Code (and Cursor/Codex/Gemini/OpenCode) discover skills by listing the
 * directory, so a stray `._agenfk-foo/SKILL.md` is surfaced as a skill whose
 * description is mojibake binary — injected into the system prompt of every
 * session. The sync filters only checked `endsWith('.md')`, which `._agenfk.md`
 * satisfies; the removal filters only checked `startsWith('agenfk')`, which
 * `._agenfk.md` does not.
 *
 * Behaviour-based: seed real artifacts, run the real installer/uninstaller
 * against a throwaway $HOME, assert on the files on disk.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import { runInstall, runUninstall, makeHome, cleanupHome, REPO_ROOT, type RunResult } from './helpers/runInstaller';
import { isInstallableMarkdown, isMacMetadata, isAgenfkOwnedEntry } from '../../../../scripts/install-helpers.mjs';
import { isAgenfkOwnedFile } from '../../../../scripts/uninstall-helpers.mjs';

/** Every dir the installer syncs skills or commands into, relative to $HOME. */
const PLATFORM_DIRS: string[][] = [
  ['.agents', 'skills'],
  ['.claude', 'skills'],
  ['.claude', 'commands'],
  ['.cursor', 'skills'],
  ['.codex', 'skills'],
  ['.gemini', 'skills'],
  ['.config', 'opencode', 'skills'],
  ['.config', 'opencode', 'commands'],
];

/** Our AppleDouble artifacts only — third-party `._*` is not ours to delete. */
function appleDoubleIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n: string) => n.startsWith('._agenfk'));
}

function allAppleDoubleUnderHome(r: RunResult): string[] {
  return PLATFORM_DIRS.flatMap((segs) =>
    appleDoubleIn(r.p(...segs)).map((n) => path.join(...segs, n))
  );
}

/** Seed `._agenfk*` artifacts into every platform dir under a throwaway HOME. */
function seedPollution(homePath: (...s: string[]) => string): void {
  for (const segs of PLATFORM_DIRS) {
    const dir = homePath(...segs);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '._agenfk.md'), 'AppleDouble junk');
    mkdirSync(path.join(dir, '._agenfk-calc-tokens'), { recursive: true });
    writeFileSync(path.join(dir, '._agenfk-calc-tokens', 'SKILL.md'), 'AppleDouble junk');
    // An AppleDouble dir holding more than SKILL.md: a non-recursive rmdir
    // throws on this and silently leaves the whole directory behind.
    writeFileSync(path.join(dir, '._agenfk-calc-tokens', 'extra.bin'), 'junk');
  }
}

/** Files belonging to OTHER tools that agenfk must never touch. */
function seedThirdParty(homePath: (...s: string[]) => string): string[] {
  const seeded: string[] = [];
  for (const segs of [['.claude', 'skills'], ['.claude', 'commands']]) {
    const dir = homePath(...segs);
    mkdirSync(dir, { recursive: true });
    for (const name of ['._other-tool-skill', '.DS_Store', '._somebody-elses-note.md']) {
      const full = path.join(dir, name);
      writeFileSync(full, 'not ours');
      seeded.push(full);
    }
  }
  return seeded;
}

describe('installer — never propagates ._* artifacts from the source tree', () => {
  let r: RunResult;
  // Registered BEFORE the writes so a throw mid-seed still gets cleaned up.
  const seeded = [
    path.join(REPO_ROOT, 'commands', '._agenfk-probe.md'),
    path.join(REPO_ROOT, 'skills', 'claude-code', '._agenfk-probe'),
  ];

  beforeAll(() => {
    // A polluted payload is exactly what every published release shipped, so
    // reproduce it at the source: an AppleDouble file sitting in commands/.
    writeFileSync(seeded[0], 'AppleDouble junk');
    mkdirSync(seeded[1], { recursive: true });
    writeFileSync(path.join(seeded[1], 'SKILL.md'), 'AppleDouble junk');

    r = runInstall(['--rules-scope=global']);
  });

  afterAll(() => {
    for (const s of seeded) rmSync(s, { recursive: true, force: true });
    cleanupHome(r.home);
  });

  it('still installs the real skills', () => {
    const skills = readdirSync(r.p('.agents', 'skills')).filter((n: string) => n.startsWith('agenfk'));
    expect(skills.length).toBeGreaterThan(5);
  });

  it('lets no ._* entry into any platform skills or commands dir', () => {
    expect(allAppleDoubleUnderHome(r)).toEqual([]);
  });
});

describe('installer — heals machines polluted by an earlier release', () => {
  let r: RunResult;
  let thirdParty: string[] = [];

  beforeAll(() => {
    const home = makeHome('agenfk-appledouble-heal');
    const at = (...s: string[]) => path.join(home, ...s);
    seedPollution(at);
    thirdParty = seedThirdParty(at);
    r = runInstall(['--rules-scope=global'], home);
  });

  afterAll(() => cleanupHome(r.home));

  it('sweeps pre-existing ._agenfk* artifacts out of every platform dir', () => {
    expect(allAppleDoubleUnderHome(r)).toEqual([]);
  });

  it('leaves other tools’ files alone', () => {
    expect(thirdParty.filter((f) => !existsSync(f))).toEqual([]);
  });
});

describe('uninstaller — removes ._agenfk* artifacts a polluted release left behind', () => {
  let uninstalled: RunResult;
  let thirdParty: string[] = [];

  beforeAll(() => {
    const home = makeHome('agenfk-appledouble-uninstall');
    runInstall(['--rules-scope=global'], home);
    // Simulate a machine that installed a polluted release: the real skills are
    // present alongside AppleDouble twins.
    const at = (...s: string[]) => path.join(home, ...s);
    seedPollution(at);
    thirdParty = seedThirdParty(at);
    uninstalled = runUninstall(['-y'], home);
  });

  afterAll(() => cleanupHome(uninstalled.home));

  it('leaves no ._agenfk* entry behind in any platform dir', () => {
    expect(allAppleDoubleUnderHome(uninstalled)).toEqual([]);
  });

  it('leaves other tools’ files alone', () => {
    expect(thirdParty.filter((f) => !existsSync(f))).toEqual([]);
  });
});

// The predicates every sync/removal site shares. The installer behaviour above
// proves they are wired in; these pin the classification itself, including the
// case the original filters got wrong in BOTH directions: `._agenfk.md` ends
// with .md (so the old sync filter installed it) and does not start with
// `agenfk` (so the old removal filter left it behind).
describe('macOS metadata predicates', () => {
  it('installs real payload markdown', () => {
    expect(isInstallableMarkdown('agenfk.md')).toBe(true);
    expect(isInstallableMarkdown('agenfk-calc-tokens.md')).toBe(true);
  });

  it('refuses AppleDouble markdown that satisfies a naive .md check', () => {
    expect('._agenfk.md'.endsWith('.md')).toBe(true); // why the old filter passed it
    expect(isInstallableMarkdown('._agenfk.md')).toBe(false);
    expect(isInstallableMarkdown('.DS_Store')).toBe(false);
  });

  it('claims our AppleDouble artifacts despite the agenfk prefix check', () => {
    expect('._agenfk.md'.startsWith('agenfk')).toBe(false); // why the old filter kept it
    expect(isAgenfkOwnedEntry('._agenfk-calc-tokens')).toBe(true);
    expect(isAgenfkOwnedFile('._agenfk.md', '.md')).toBe(true);
    expect(isMacMetadata('._agenfk')).toBe(true);
  });

  it('does not claim files belonging to other tools', () => {
    expect(isAgenfkOwnedEntry('some-other-skill')).toBe(false);
    expect(isAgenfkOwnedEntry('._other-tool-skill')).toBe(false);
    expect(isAgenfkOwnedEntry('.DS_Store')).toBe(false);
    expect(isAgenfkOwnedFile('._somebody-elses-note.md', '.md')).toBe(false);
  });

  it('checks the extension against the shadowed name', () => {
    // `._agenfk.json` must not be swept by a call site that handles `.md`.
    expect(isAgenfkOwnedFile('._agenfk.json', '.md')).toBe(false);
    expect(isAgenfkOwnedFile('._agenfk.toml', '.toml')).toBe(true);
  });
});
