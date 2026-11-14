import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `agenfk hub skill install | uninstall` (CGLAB-702, user 2026-11-01): a skill that teaches every
 * coding agent to administer the hub with `agenfk hub admin`. Its command reference is made from this
 * CLI's own `hub admin` commands, so it names exactly what the installed version has; install it again
 * after an upgrade to pick up new commands.
 */
export const HUB_ADMIN_SKILL = 'agenfk-hub-admin';

/** Where agents find skills under a root: every agent's universal dir (pi, Codex, OpenCode, Cursor, Gemini), and Claude Code's. */
const skillDirs = (root: string) => [
  path.join(root, '.agents', 'skills', HUB_ADMIN_SKILL),
  path.join(root, '.claude', 'skills', HUB_ADMIN_SKILL),
];

const GUIDE = `---
name: ${HUB_ADMIN_SKILL}
description: Administer the AgEnFK hub from the command line with \`agenfk hub admin\` - users, identities, installations, API keys, invites, flows, upgrades, Airlock policy, repos, models, org settings, federation, JIRA, events, audit and every board chart. Use when asked to look at, change or report on anything on the hub's admin pages.
---

# Administering the AgEnFK hub

\`agenfk hub admin <area> <verb>\` does from the command line what the hub's admin pages do.

## Signing in

1. Run \`agenfk hub admin login\` (add \`--url <hub>\` when this machine is not joined to that hub).
   It prints a code and a URL. **A person must approve it** in the browser, signed in to the hub as an
   admin: tell the user the code and URL and wait. Never try to approve it yourself.
2. The session lasts 12 hours. \`agenfk hub admin whoami\` says who you are signed in as;
   \`agenfk hub admin logout\` ends the session.
3. A command refused for an expired or missing session: ask the user to run the login again.

## Conventions

- Add \`--json\` to a command that offers it (its options below say so), and read that rather than the
  table. Exports (\`audit export\`, \`airlock dataset export\`) write their own format instead.
- Destructive or fleet-wide changes (deleting, revoking, dispatching, upgrading the fleet) need \`--yes\`.
  **Confirm each with the user before running it**, naming what it changes.
- Secrets (passwords, keys, tokens) are read only from stdin: pipe them in, never put them in arguments.
- Flows and policies go through files: write one out with \`--out <file>\` (\`flows get\`, \`airlock policy show\`),
  edit it, and save it back from the file (\`flows update\`, \`airlock policy set\`).
- Configuration changes made here are audited on the hub with source \`cli\` (signing out and
  recomputing rollups are not).
- \`agenfk hub admin <area> --help\` shows an area's commands; \`<area> <verb> --help\` one command's options.
  This reference was made from the CLI that installed it: after an upgrade, \`agenfk hub skill install\` again.

## Commands
`;

function usageOf(words: string[], cmd: Command): string {
  const args = cmd.registeredArguments.map(a => {
    const name = `${a.name()}${a.variadic ? '...' : ''}`;
    return a.required ? `<${name}>` : `[${name}]`;
  });
  // A required option is part of how the command is run.
  const required = cmd.options.filter(o => o.mandatory).map(o => o.flags.split(/,\s*/).pop()!);
  return ['agenfk hub admin', ...words, ...args, ...required].join(' ');
}

function leavesOf(cmd: Command, words: string[] = []): Array<{ words: string[]; cmd: Command }> {
  if (cmd.commands.length === 0) return words.length ? [{ words, cmd }] : [];
  return cmd.commands.flatMap(c => leavesOf(c, [...words, c.name()]));
}

/** The skill's text, its reference made from the `hub admin` command it is given. */
export function hubAdminSkill(admin: Command): string {
  const lines: string[] = [GUIDE];
  let area = '';
  for (const { words, cmd } of leavesOf(admin)) {
    const top = words.length > 1 ? words[0] : 'session';
    if (top !== area) {
      area = top;
      lines.push('', `### ${area}`, '');
    }
    lines.push(`- \`${usageOf(words, cmd)}\`${cmd.description() ? ` - ${cmd.description()}` : ''}`);
    for (const o of cmd.options) lines.push(`  - \`${o.flags}\`${o.mandatory ? ' (required)' : ''}${o.description ? `: ${o.description}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Writes the skill under `root` (a home folder or a repository) for every agent; returns the files written. */
export function installHubAdminSkill(admin: Command, root: string): string[] {
  const text = hubAdminSkill(admin);
  return skillDirs(root).map(dir => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, text);
    return file;
  });
}

/** Removes the skill under `root`; returns the dirs removed. */
export function uninstallHubAdminSkill(root: string): string[] {
  return skillDirs(root).filter(dir => fs.existsSync(dir)).map(dir => {
    fs.rmSync(dir, { recursive: true, force: true });
    return dir;
  });
}

function rootOf(project: boolean | undefined): string {
  if (!project) return os.homedir();
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
  } catch {
    console.error(chalk.red('--project needs a git repository: run it inside one.'));
    process.exit(1);
  }
}

export function registerHubSkillCommands(hub: Command, admin: Command): void {
  const skill = hub.command('skill').description('The skill that teaches coding agents to administer the hub with `agenfk hub admin`');
  skill
    .command('install')
    .description('Install the hub admin skill for every coding agent (home folder, or this repository with --project)')
    .option('-p, --project', 'Install into the current repository instead of the home folder')
    .action((opts: { project?: boolean }) => {
      const files = installHubAdminSkill(admin, rootOf(opts.project));
      console.log(chalk.green('Hub admin skill installed:'));
      for (const f of files) console.log(`  ${chalk.green('✓')} ${f}`);
    });
  skill
    .command('uninstall')
    .description('Remove the hub admin skill (home folder, or this repository with --project)')
    .option('-p, --project', 'Remove it from the current repository instead of the home folder')
    .action((opts: { project?: boolean }) => {
      const removed = uninstallHubAdminSkill(rootOf(opts.project));
      console.log(removed.length ? chalk.green(`Hub admin skill removed: ${removed.join(', ')}`) : chalk.gray('The hub admin skill was not installed there.'));
    });
}
