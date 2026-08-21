/**
 * Release commands are repo-private (CGLAB-8).
 *
 * /agenfk-release, /agenfk-release-beta and /agenfk-release-hub cut releases OF
 * THE AGENFK FRAMEWORK ITSELF (package-dist tarballs, hub-v* tags, beta
 * branches) — they are meaningless in end-user projects. They live in
 * .claude/commands/ (project-scoped slash commands) instead of commands/
 * (which the installer copies to every client's global config), and no
 * user-facing bundle may reference them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { runInstall, makeHome, cleanupHome, type RunResult } from './helpers/runInstaller';

const ROOT = path.resolve(__dirname, '../../../..');
const RELEASE_COMMANDS = ['agenfk-release.md', 'agenfk-release-beta.md', 'agenfk-release-hub.md'];

describe('release commands live in .claude/commands/, not the installable bundle', () => {
  it('commands/ (installed globally for every user) has no release commands', () => {
    const files = readdirSync(path.join(ROOT, 'commands'));
    for (const cmd of RELEASE_COMMANDS) expect(files).not.toContain(cmd);
  });

  it('.claude/commands/ (this repo only) has all three', () => {
    for (const cmd of RELEASE_COMMANDS) {
      expect(existsSync(path.join(ROOT, '.claude', 'commands', cmd))).toBe(true);
    }
  });
});

describe('installer removes release commands stale from previous versions', () => {
  // Behaviour-based: seed a throwaway $HOME as if a previous version had installed
  // the repo-private release commands globally, run the installer, and assert they
  // are actually removed — instead of grepping install.mjs for the cleanup names.
  let r: RunResult;
  beforeAll(() => {
    r = runInstallWithSeededReleaseCommands();
  });
  afterAll(() => cleanupHome(r.home));

  function runInstallWithSeededReleaseCommands(): RunResult {
    const home = makeHome('agenfk-release-clean');
    // Claude: ~/.claude/commands/agenfk-release.md
    mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
    for (const cmd of RELEASE_COMMANDS) {
      writeFileSync(path.join(home, '.claude', 'commands', cmd), 'stale\n');
    }
    // Gemini: the installer writes agenfk-release.md → ~/.gemini/commands/agenfk/release.toml
    // (prefix-stripped). Seed that exact path so a mismatched cleanup would be caught.
    mkdirSync(path.join(home, '.gemini', 'commands', 'agenfk'), { recursive: true });
    writeFileSync(path.join(home, '.gemini', 'commands', 'agenfk', 'release.toml'), 'stale\n');
    return runInstall(['--rules-scope=global'], home);
  }

  it('removes each stale release command from ~/.claude/commands/', () => {
    for (const cmd of RELEASE_COMMANDS) {
      expect(existsSync(r.p('.claude', 'commands', cmd))).toBe(false);
    }
  });

  it('removes the prefix-stripped Gemini release.toml (agenfk/<name>.toml, not agenfk-<name>.toml)', () => {
    expect(existsSync(r.p('.gemini', 'commands', 'agenfk', 'release.toml'))).toBe(false);
  });
});
