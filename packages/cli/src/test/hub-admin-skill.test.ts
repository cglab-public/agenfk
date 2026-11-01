/**
 * `agenfk hub skill install` (CGLAB-702, user 2026-11-01): a skill that teaches every coding agent to
 * administer the hub with `agenfk hub admin`. Installed where every agent looks (~/.agents/skills, which
 * pi, Codex, OpenCode, Cursor and Gemini read) and where Claude Code looks (~/.claude/skills), or into a
 * repository with --project. Its command reference is made from this CLI's own `hub admin` commands, so
 * it names exactly the commands the installed version has.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { REPO_ROOT } from './helpers/runInstaller';
import { registerHubCommands } from '../commands/hub';
import { hubAdminSkill, installHubAdminSkill, HUB_ADMIN_SKILL } from '../hubAdmin/skill';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-admin-skill-')) };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});

const skillFiles = (root: string) => [
  path.join(root, '.agents', 'skills', HUB_ADMIN_SKILL, 'SKILL.md'),
  path.join(root, '.claude', 'skills', HUB_ADMIN_SKILL, 'SKILL.md'),
];

function program(): { cli: Command; admin: Command } {
  const cli = new Command().exitOverride();
  registerHubCommands(cli);
  const hub = cli.commands.find(c => c.name() === 'hub')!;
  return { cli, admin: hub.commands.find(c => c.name() === 'admin')! };
}

/** Every runnable `hub admin` command, by its words after `admin`. */
function leaves(cmd: Command, words: string[] = []): Array<{ words: string[]; cmd: Command }> {
  if (cmd.commands.length === 0) return [{ words, cmd }];
  return cmd.commands.flatMap(c => leaves(c, [...words, c.name()]));
}

let logs: string[];
beforeEach(() => {
  fs.rmSync(path.join(sandboxHome, '.agents'), { recursive: true, force: true });
  fs.rmSync(path.join(sandboxHome, '.claude'), { recursive: true, force: true });
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the hub admin skill', () => {
  it('is a skill every agent loads: its name and what it is for, in the frontmatter', () => {
    const text = hubAdminSkill(program().admin);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(front).not.toBeNull();
    expect(front![1]).toMatch(/^name: agenfk-hub-admin$/m);
    expect(front![1]).toMatch(/^description: .*hub.*/im);
  });

  it('names every `agenfk hub admin` command this CLI has, with what it does', () => {
    const { admin } = program();
    const text = hubAdminSkill(admin);
    const all = leaves(admin);
    expect(all.length).toBeGreaterThan(50);
    for (const { words, cmd } of all) {
      expect(text, words.join(' ')).toContain(`agenfk hub admin ${words.join(' ')}`);
      if (cmd.description()) expect(text, words.join(' ')).toContain(cmd.description());
    }
  });

  it('lists each command\'s arguments and options', () => {
    const { admin } = program();
    const text = hubAdminSkill(admin);
    const withOptions = leaves(admin).filter(l => l.cmd.options.length > 0);
    expect(withOptions.length).toBeGreaterThan(0);
    for (const { words, cmd } of withOptions) {
      for (const o of cmd.options) expect(text, `${words.join(' ')} ${o.flags}`).toContain(o.flags);
    }
    const withArgs = leaves(admin).filter(l => l.cmd.registeredArguments.length > 0);
    expect(withArgs.length).toBeGreaterThan(0);
    for (const { words, cmd } of withArgs) {
      const usage = cmd.registeredArguments.map(a => { const n = `${a.name()}${a.variadic ? '...' : ''}`; return a.required ? `<${n}>` : `[${n}]`; }).join(' ');
      expect(text, words.join(' ')).toContain(`agenfk hub admin ${words.join(' ')} ${usage}`);
    }
    // Codex review 01a197c7: several values stay several.
    expect(text).toContain('agenfk hub admin airlock learning accept <hosts...>');
  });

  // Codex review 01a197c7: a required option is part of the usage, not one option among the rest.
  it('puts a command\'s required options in its usage', () => {
    const { admin } = program();
    const text = hubAdminSkill(admin);
    const required = leaves(admin).filter(l => l.cmd.options.some(o => o.mandatory));
    expect(required.length).toBeGreaterThan(0);
    for (const { words, cmd } of required) {
      const line = text.split('\n').find(l => l.startsWith(`- \`agenfk hub admin ${words.join(' ')} `) || l.startsWith(`- \`agenfk hub admin ${words.join(' ')}\``))!;
      for (const o of cmd.options.filter(x => x.mandatory)) expect(line, `${words.join(' ')} ${o.flags}`).toContain(o.flags);
    }
    expect(text).toMatch(/agenfk hub admin users invite <email> --role <role>/);
  });

  // Codex review 01a197c7: the generated reference alone names login, --yes, --json and stdin, so the
  // guide's own instructions are what is checked: a person approves the sign-in, and the agent asks first.
  it('tells the agent that a person approves the sign-in, and to confirm a destructive change with the user', () => {
    const text = hubAdminSkill(program().admin);
    const guide = text.slice(0, text.indexOf('## Commands'));
    expect(guide).toMatch(/A person must approve it/);
    expect(guide).toMatch(/Never try to approve it yourself/);
    expect(guide).toMatch(/Confirm each with the user before running it/);
    expect(guide).toMatch(/only from stdin/);
  });
});

describe('agenfk hub skill install | uninstall', () => {
  it('installs it for every agent and for Claude Code, in the home folder', async () => {
    await program().cli.parseAsync(['node', 'agenfk', 'hub', 'skill', 'install']);
    const [universal, claude] = skillFiles(sandboxHome);
    expect(fs.readFileSync(universal, 'utf8')).toBe(hubAdminSkill(program().admin));
    expect(fs.readFileSync(claude, 'utf8')).toBe(fs.readFileSync(universal, 'utf8'));
    expect(logs.join('\n')).toContain(universal);
  });

  it('installs it into a repository', () => {
    const repo = fs.mkdtempSync(path.join(sandboxHome, 'repo-'));
    const written = installHubAdminSkill(program().admin, repo);
    expect(written).toEqual(skillFiles(repo));
    for (const f of skillFiles(repo)) expect(fs.existsSync(f)).toBe(true);
    for (const f of skillFiles(sandboxHome)) expect(fs.existsSync(f)).toBe(false);
  });

  it('a second install replaces the first', async () => {
    const [universal] = skillFiles(sandboxHome);
    fs.mkdirSync(path.dirname(universal), { recursive: true });
    fs.writeFileSync(universal, 'old\n');
    await program().cli.parseAsync(['node', 'agenfk', 'hub', 'skill', 'install']);
    expect(fs.readFileSync(universal, 'utf8')).toBe(hubAdminSkill(program().admin));
  });

  it('uninstall removes it and nothing else', async () => {
    await program().cli.parseAsync(['node', 'agenfk', 'hub', 'skill', 'install']);
    const other = path.join(sandboxHome, '.agents', 'skills', 'agenfk-flow', 'SKILL.md');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'mine\n');
    await program().cli.parseAsync(['node', 'agenfk', 'hub', 'skill', 'uninstall']);
    for (const f of skillFiles(sandboxHome)) expect(fs.existsSync(path.dirname(f))).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('mine\n');
  });
});

// Codex review 01a197c7: the workflow skills' installer cleans up every agenfk* skill it did not install
// (the other scope, and ~/.claude/skills). It must leave this one, which has its own install.
describe('the workflow skills\' installer keeps the hub admin skill', () => {
  const bin = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
  const run = (home: string, args: string[], cwd: string) => spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8', timeout: 120_000, cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: 'production', VITEST: '' },
  });

  it.each(['skills install', 'skills install --project', 'skills uninstall'])('agenfk %s', (line) => {
    const args = line.split(' ');
    expect(fs.existsSync(bin), 'packages/cli/dist/index.js missing: run `npm run build` first').toBe(true);
    const home = fs.mkdtempSync(path.join(sandboxHome, 'home-'));
    const repo = fs.mkdtempSync(path.join(sandboxHome, 'repo-'));
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    installHubAdminSkill(program().admin, home);
    const r = run(home, args, repo);
    expect(r.status, r.stderr).toBe(0);
    for (const f of skillFiles(home)) expect(fs.existsSync(f), f).toBe(true);
  });
});
