/**
 * `agenfk skills install` syncs from ~/.agenfk-system/commands — the install dir.
 *
 * The install dir is an OVERLAY target: files deleted upstream survive in it (the
 * reported bug), so any sync step that enumerates it by `.md` alone will hand a
 * stale, repo-private command to every client. The installer's step 10 was one
 * such step; these CLI sync helpers were the other, and fixing only the installer
 * left this path re-installing the same command.
 *
 * The release commands cut releases of AgEnFK itself and live in the repo's own
 * .claude/commands/. They must never reach a user's global config.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { REPO_ROOT } from './helpers/runInstaller';

const bin = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
const distBuilt = existsSync(bin);

let home: string;
let res: ReturnType<typeof spawnSync>;

beforeAll(() => {
  if (!distBuilt) return; // dist not built; the first test fails loudly below
  home = mkdtempSync(path.join(os.tmpdir(), 'agenfk-cli-skills-'));
  const commandsDir = path.join(home, '.agenfk-system', 'commands');
  mkdirSync(commandsDir, { recursive: true });
  // A stale install dir: three repo-private commands plus one that really ships.
  for (const stale of ['agenfk-release', 'agenfk-release-beta', 'agenfk-release-hub']) {
    writeFileSync(path.join(commandsDir, `${stale}.md`), `---\ndescription: ${stale}\n---\nrepo-private\n`, 'utf8');
  }
  writeFileSync(path.join(commandsDir, 'agenfk.md'), '---\ndescription: real\n---\nbody\n', 'utf8');

  res = spawnSync(process.execPath, [bin, 'skills', 'install'], {
    encoding: 'utf8',
    timeout: 120_000,
    // The CLI's main block is guarded by `NODE_ENV !== 'test'`; vitest sets
    // NODE_ENV=test and spawnSync would inherit it, short-circuiting the CLI and
    // making every "not installed" assertion below pass vacuously.
    env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: 'production', VITEST: '' },
  });
});

afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

/** Every dest a sync step writes to, as (dir, ext). */
const DESTS: Array<[string, string]> = [
  ['.agents/skills', 'SKILL.md'],
  ['.claude/skills', 'SKILL.md'],
  ['.config/opencode/commands', '.md'],
  ['.gemini/commands', '.toml'],
];

describe('agenfk skills install never installs repo-private release commands', () => {
  it('ran and synced a command (guard: an empty run makes the rest vacuous)', () => {
    // Fails LOUDLY when the CLI is unbuilt. Returning quietly here would report
    // green while every other assertion in this file proved nothing — the exact
    // "green while nothing runs" mode this suite exists to prevent. CI runs
    // `npm run build` before `npm test`.
    expect(distBuilt, 'packages/cli/dist/index.js missing — run `npm run build` before `npm test`').toBe(true);
    expect(res.status, `CLI exited ${res.status}: ${res.stderr}`).toBe(0);
    expect(existsSync(path.join(home, '.agents', 'skills', 'agenfk', 'SKILL.md'))).toBe(true);
  });

  it.each(['agenfk-release', 'agenfk-release-beta', 'agenfk-release-hub'])(
    'does not install %s anywhere',
    (name) => {
      if (!distBuilt) return; // covered by the loud guard above
      const installed = DESTS
        .map(([dir, ext]) => path.join(home, dir, name, ext))
        .filter((p) => existsSync(p));
      expect(installed).toEqual([]);
    },
  );

  it('does not leave a flat Gemini TOML for a repo-private command', () => {
    if (!distBuilt) return; // covered by the loud guard above
    // syncCommandsToml writes FLAT `agenfk-release.toml` (not the nested form
    // install.mjs step 10c writes), so the flat shape must be checked too.
    expect(existsSync(path.join(home, '.gemini', 'commands', 'agenfk-release.toml'))).toBe(false);
    expect(existsSync(path.join(home, '.gemini', 'commands', 'agenfk-release-beta.toml'))).toBe(false);
    expect(existsSync(path.join(home, '.gemini', 'commands', 'agenfk-release-hub.toml'))).toBe(false);
  });

  it('still installs commands that are not repo-private', () => {
    if (!distBuilt) return; // covered by the loud guard above
    expect(existsSync(path.join(home, '.config', 'opencode', 'commands', 'agenfk.md'))).toBe(true);
    expect(existsSync(path.join(home, '.gemini', 'commands', 'agenfk.toml'))).toBe(true);
  });
});
