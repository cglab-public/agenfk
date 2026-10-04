/**
 * The agenfk hooks, end to end, the way Claude Code runs them (STORY af174cdd).
 *
 * The real installer writes into a sandbox HOME; every agenfk hook command it
 * registered in ~/.claude/settings.json is then run through a shell exactly as
 * Claude Code does - Git Bash on Windows (issue #192: an unquoted backslash
 * path there was "command not found", which Claude Code treats as non-blocking,
 * so the guard silently vanished), bash elsewhere.
 *
 * BUG 28a940a7 could only pin the command's SHAPE on POSIX; this runs it. Named
 * windows-*.test.ts, so the windows-compat CI job runs it on windows-latest and
 * the normal run on Linux.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { runInstall, cleanupHome, makeHome } from './helpers/runInstaller';
import { claudeHookCommands } from '../../../../scripts/install-helpers.mjs';

const isWin = process.platform === 'win32';

/** The shell Claude Code runs hooks with: Git Bash on Windows (never WSL's bash.exe), bash elsewhere. */
function hookShell(): string {
  if (!isWin) return 'bash';
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    (() => {
      try {
        const git = execFileSync('where', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
        return path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe');
      } catch { return undefined; }
    })(),
  ];
  const found = candidates.find((c): c is string => !!c && fs.existsSync(c));
  // Never a silent skip: without Git Bash this job cannot say whether the hooks run.
  if (!found) throw new Error(`Git Bash not found (looked in: ${candidates.filter(Boolean).join(', ')})`);
  return found;
}

/** A stand-in for the agenfk API: GET /items answers whatever `items` holds. */
function stubApi(items: () => unknown[]) {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/items')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items())); return; }
    res.writeHead(404); res.end('{}');
  });
  return server;
}

let home = '';
let project = '';
let shell = '';
let api: http.Server;
let apiUrl = '';
let items: unknown[] = [];
let commands: Record<string, string> = {};

beforeAll(async () => {
  shell = hookShell();
  home = makeHome('agenfk hooks e2e & co');
  // A whole install: `--only=<client>` is a scoped re-run that writes neither the CLI nor the hook bins.
  const r = runInstall(['--rules-scope=global'], home, undefined, isWin
    ? { ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
    : {});
  expect(r.status, r.stdout + r.stderr).toBe(0);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  for (const groups of Object.values<any[]>(settings.hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks ?? []) {
      const name = String(h.command).match(/(agenfk-[a-z-]+)/)?.[1];
      if (name) commands[name] = h.command;
    }
  }
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk hooks project-')));
  fs.mkdirSync(path.join(project, '.agenfk'));
  fs.writeFileSync(path.join(project, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'p-1' }));
  api = stubApi(() => items);
  await new Promise<void>(r2 => api.listen(0, '127.0.0.1', () => r2()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  if (api) await new Promise<void>(r => api.close(() => r()));
  if (home) cleanupHome(home);
  if (project) fs.rmSync(project, { recursive: true, force: true });
});

/**
 * Runs a registered hook command through the hook shell, Claude Code style: the
 * event as JSON on stdin. Asynchronously - the stub API answers from this very
 * process, and a spawnSync would hold its event loop until the hook gave up.
 */
function runHook(command: string, event: unknown): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', command], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENFK_API_URL: apiUrl,
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(event));
  });
}

describe('the hooks the installer registers for Claude Code', () => {
  it('registers every agenfk hook', () => {
    const expected = Object.keys(claudeHookCommands(path.join(home, '.local', 'bin'), { platform: process.platform }));
    expect(Object.keys(commands).sort()).toEqual([...expected].sort());
  });

  it('each one runs under the hook shell: found, started, and exits cleanly', async () => {
    for (const [name, command] of Object.entries(commands)) {
      const r = await runHook(command, { hook_event_name: 'PostToolUse', session_id: 's-1', tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: project });
      expect(r.status, `${name}: ${command}\n${r.stderr}`).toBe(0);
      expect(r.stderr, name).not.toMatch(/command not found|No such file or directory|cannot execute/i);
    }
  });

  it('the gatekeeper blocks an edit inside a project when no task is active', async () => {
    items = [{ id: 'i-1', status: 'TODO' }];
    const r = await runHook(commands['agenfk-gatekeeper'], { tool_name: 'Edit', tool_input: { file_path: path.join(project, 'src', 'a.ts') } });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'block' });
    expect(r.stdout).toMatch(/No task is actively being worked on/);
  });

  it('and lets it through once one is (so the block above came from the check, not a broken hook)', async () => {
    items = [{ id: 'i-1', status: 'IN_PROGRESS' }];
    const r = await runHook(commands['agenfk-gatekeeper'], { tool_name: 'Edit', tool_input: { file_path: path.join(project, 'src', 'a.ts') } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/"decision"\s*:\s*"block"/);
  });

  it('the enforcer blocks a direct read of the database', async () => {
    const r = await runHook(commands['agenfk-mcp-enforcer'], { tool_name: 'Bash', tool_input: { command: 'sqlite3 ~/.agenfk/db.sqlite .tables' } });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'block' });
  });
});
