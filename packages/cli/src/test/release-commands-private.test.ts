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
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

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

describe('no user-facing bundle references the repo-private release commands', () => {
  // Every file the installer ships into user configs.
  const shippedFiles = [
    ...readdirSync(path.join(ROOT, 'commands')).filter(f => f.endsWith('.md')).map(f => `commands/${f}`),
    'clauderules/CLAUDE.md',
    'codexrules/AGENTS.md',
    'geminirules/GEMINI.md',
    'cursorrules/agenfk.mdc',
    'SKILL.md',
  ];

  for (const rel of shippedFiles) {
    it(`${rel} does not mention agenfk-release`, () => {
      const content = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(content).not.toMatch(/agenfk-release/);
    });
  }
});

describe('installer cleans up release commands stale from previous versions', () => {
  it('install.mjs names each release command for stale removal on upgrade', () => {
    const src = readFileSync(path.join(ROOT, 'scripts', 'install.mjs'), 'utf8');
    for (const cmd of RELEASE_COMMANDS) {
      expect(src).toContain(`'${cmd.replace(/\.md$/, '')}'`);
    }
  });
});
