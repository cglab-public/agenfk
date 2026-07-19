/**
 * Skills installation:
 *  - the universal ~/.agents/skills/ path (Codex reads skills only from there)
 *  - name-frontmatter injection into installed SKILL.md files
 *  - claude skills + opencode slash commands
 *  - uninstall cleans up ~/.agents/skills/
 *
 * Behaviour-based: run the real installer/uninstaller against a throwaway $HOME
 * and assert on the files they write/remove, instead of grepping cli/index.ts /
 * install.mjs / uninstall.mjs.
 *
 * NOTE: the Gemini TOML slash-command generation only fires when the Gemini CLI
 * is detected (needs the real binary, absent under the sandbox's empty PATH), so
 * it isn't observable here; those greps, plus cli-internal-shape greps
 * (LEGACY_COMMANDS_DIRS, syncCommandsToDir using writeFileSync), were dropped in
 * the behaviour-based conversion (CGLAB-16) — the observable outcome (skills and
 * commands land in the right dirs, with name frontmatter) is asserted instead.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { runInstall, runUninstall, makeHome, cleanupHome, type RunResult } from './helpers/runInstaller';

describe('install.mjs — installs skills + commands to the expected dirs', () => {
  let r: RunResult;
  beforeAll(() => { r = runInstall(['--rules-scope=global']); });
  afterAll(() => cleanupHome(r.home));

  it('installs agenfk skills into the universal ~/.agents/skills/ path (Codex source)', () => {
    const skills = readdirSync(r.p('.agents', 'skills')).filter((n) => n.startsWith('agenfk'));
    expect(skills.length).toBeGreaterThan(5);
  });

  it('installs agenfk skills into ~/.claude/skills/', () => {
    const skills = readdirSync(r.p('.claude', 'skills')).filter((n) => n.startsWith('agenfk'));
    expect(skills.length).toBeGreaterThan(5);
  });

  it('injects a `name:` frontmatter field into installed SKILL.md files', () => {
    // agenfk.md ships without a name field; syncing must inject one derived from
    // the filename so the skill is addressable.
    const skillMd = readFileSync(r.p('.agents', 'skills', 'agenfk', 'SKILL.md'), 'utf8');
    expect(skillMd).toMatch(/^name:\s*agenfk\s*$/m);
  });

  it('installs the opencode slash commands into ~/.config/opencode/commands/', () => {
    expect(existsSync(r.p('.config', 'opencode', 'commands'))).toBe(true);
    expect(readdirSync(r.p('.config', 'opencode', 'commands')).length).toBeGreaterThan(0);
  });
});

describe('uninstall.mjs — removes ~/.agents/skills/agenfk*', () => {
  let home: string;
  let installedCount = 0;
  let uninstall: RunResult;
  beforeAll(() => {
    home = makeHome('agenfk-skills-uninstall');
    const install = runInstall(['--rules-scope=global'], home);
    installedCount = readdirSync(install.p('.agents', 'skills')).filter((n) => n.startsWith('agenfk')).length;
    uninstall = runUninstall(['-y'], home);
  });
  afterAll(() => cleanupHome(home));

  it('installed skills first (precondition)', () => {
    expect(installedCount).toBeGreaterThan(5);
  });

  it('removes every agenfk skill from ~/.agents/skills/', () => {
    const remaining = existsSync(uninstall.p('.agents', 'skills'))
      ? readdirSync(uninstall.p('.agents', 'skills')).filter((n) => n.startsWith('agenfk'))
      : [];
    expect(remaining).toHaveLength(0);
  });
});
