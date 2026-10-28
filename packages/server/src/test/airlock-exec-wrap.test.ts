/**
 * SX-3 (8dd7c7c0): which way the server runs a card's command. For a card whose
 * tree an Airlock sandbox touched (SX-1), while the policy enforces, the verify,
 * suite, capture and worktree-setup commands go through `agenfk airlock exec`,
 * inside the sandbox; any other card's run exactly as before. A covered card
 * where the sandbox cannot be used (Windows, no CLI to run it) is refused - its
 * command never runs unsandboxed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { airlockCommandFor, airlockArgvFor, airlockHooksOff, noHooksGitEnv, serverUrlFor, AIRLOCK_REFUSED_EXIT, type AirlockRunDeps } from '../airlock/execWrap';
import { runArgv } from '../commandChecks';
import { judgeCommandChecks } from '../commandChecks';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
let storage: SQLiteStorageProvider;
let tmp: string;
let cli: string;
let mode: string;

function deps(over: Partial<AirlockRunDeps> = {}): AirlockRunDeps {
  return {
    storage: () => storage,
    effectiveMode: async () => mode as any,
    cliPath: () => cli,
    apiUrl: () => 'http://127.0.0.1:47555',
    nodePath: process.execPath,
    platform: process.platform,
    ...over,
  };
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-wrap-')));
  storage = new SQLiteStorageProvider();
  await storage.init({ path: path.join(tmp, 'db.sqlite') });
  // a stand-in for the CLI: prints the arguments it was given
  cli = path.join(tmp, 'agenfk.js');
  fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write("API=" + process.env.AGENFK_API_URL);');
  mode = 'enforce';
  for (const [id, parentId] of [['s1', undefined], ['t1', 's1'], ['s2', undefined]] as const) {
    await storage.createItem({ id, projectId: 'p', type: parentId ? 'TASK' : 'STORY', title: id, status: 'TODO', parentId, createdAt: new Date(), updatedAt: new Date() } as any);
  }
  await storage.markAirlockCovered(['t1'], '2026-10-28T10:00:00.000Z');
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('airlockCommandFor', () => {
  it('a card nobody sandboxed runs its command unchanged', async () => {
    expect(await airlockCommandFor(deps(), 's2', 'npm test', '/w')).toEqual({ command: 'npm test', sandboxed: false });
    expect(await airlockCommandFor(deps(), null, 'npm test', '/w')).toEqual({ command: 'npm test', sandboxed: false });
  });

  it('a covered tree, in enforce mode, runs it through agenfk airlock exec - from any card of the tree', async () => {
    for (const id of ['s1', 't1']) {
      const r = await airlockCommandFor(deps(), id, 'npm test', '/w');
      expect(r.sandboxed, id).toBe(true);
      expect(r.command).toContain('airlock exec --no-process-group');
    }
  });

  it('observe or off: the command runs as before (the sandbox is for enforce mode)', async () => {
    for (mode of ['observe', 'off']) {
      expect(await airlockCommandFor(deps(), 't1', 'npm test', '/w')).toEqual({ command: 'npm test', sandboxed: false });
    }
  });

  it('a covered card where the sandbox cannot run is refused, never run unsandboxed', async () => {
    const win = await airlockCommandFor(deps({ platform: 'win32' }), 't1', 'npm test', '/w');
    expect(win.sandboxed).toBe(false);
    expect(win.refused).toMatch(/Windows/);
    const noCli = await airlockCommandFor(deps({ cliPath: () => path.join(tmp, 'missing.js') }), 't1', 'npm test', '/w');
    expect(noCli.refused).toMatch(/agenfk CLI/);
    expect(AIRLOCK_REFUSED_EXIT).toBe(125);
  });

  it('the policy cannot be read: a covered card is refused', async () => {
    const r = await airlockCommandFor(deps({ effectiveMode: async () => { throw new Error('db locked'); } }), 't1', 'npm test', '/w');
    expect(r.refused).toMatch(/policy/);
  });
});

describePosix('airlockCommandFor: the wrapped line, run by a shell', () => {
  it('hands exec the command, the cwd and the flags exactly, whatever quotes and operators they hold', async () => {
    const command = `printf '%s\\n' "a b" 'c; touch marker' && echo $HOME \`id\``;
    const cwd = path.join(tmp, "it's a dir");
    const r = await airlockCommandFor(deps(), 't1', command, cwd);
    const out = spawnSync('/bin/sh', ['-c', r.command], { encoding: 'utf8' });
    expect(JSON.parse(out.stdout)).toEqual(['airlock', 'exec', '--no-process-group', '--project-id', 'p', '--cwd', cwd, '--', command]);
    expect(fs.existsSync(path.join(tmp, 'marker'))).toBe(false);
  });

  it('a refused card\'s line prints why and exits 125', async () => {
    const r = await airlockCommandFor(deps({ cliPath: () => path.join(tmp, 'missing.js') }), 't1', 'npm test', '/w');
    const out = spawnSync('/bin/sh', ['-c', r.command], { encoding: 'utf8' });
    expect(out.status).toBe(AIRLOCK_REFUSED_EXIT);
    expect(out.stderr).toMatch(/Airlock/);
  });
});

describe('SX-3 review (Codex gpt-6.1-sol 01a18260)', () => {
  it('exec is pointed at THIS server: AGENFK_API_URL is set on the line, not rediscovered', async () => {
    if (process.platform === 'win32') return;
    const r = await airlockCommandFor(deps(), 't1', 'npm test', '/w');
    const out = spawnSync('/bin/sh', ['-c', r.command], { encoding: 'utf8', env: { ...process.env, AGENFK_API_URL: 'http://127.0.0.1:1' } });
    expect(out.stderr).toContain('API=http://127.0.0.1:47555');
  });

  it('a refusal on Windows is a cmd.exe line', async () => {
    const r = await airlockCommandFor(deps({ platform: 'win32' }), 't1', 'npm test', 'C:\\w');
    expect(r.command).toMatch(/^echo .*1>&2 & exit \/b 125$/);
    expect(r.command).not.toContain('printf');
  });

  it('a flow command check (an argv) on a covered card runs through exec as one quoted line', async () => {
    if (process.platform === 'win32') return;
    const r = await airlockArgvFor(deps(), 't1', ['npm', 'run', 'lint', '--', "it's"], '/w');
    expect(r.argv[0]).toBe('/bin/sh');
    const out = spawnSync(r.argv[0], r.argv.slice(1), { encoding: 'utf8' });
    // every word quoted: the shell exec hands it to reads it back as exactly this argv
    const line = "'npm' 'run' 'lint' '--' 'it'\\''s'";
    expect(JSON.parse(out.stdout)).toEqual(['airlock', 'exec', '--no-process-group', '--project-id', 'p', '--cwd', '/w', '--', line]);
    expect(spawnSync('/bin/sh', ['-c', `printf '%s\\n' ${line}`], { encoding: 'utf8' }).stdout).toBe("npm\nrun\nlint\n--\nit's\n");
    expect((await airlockArgvFor(deps(), 's2', ['npm', 'run', 'lint'], '/w'))).toEqual({ argv: ['npm', 'run', 'lint'] });
    expect((await airlockArgvFor(deps({ platform: 'win32' }), 't1', ['npm', 'run', 'lint'], '/w')).refused).toMatch(/Windows/);
  });

  it('judgeCommandChecks: a covered card\'s check is refused without running when the sandbox cannot be used', async () => {
    const check = { id: 'command-check:lint', applicable: true, params: { argv: JSON.stringify(['node', '-e', 'require("fs").writeFileSync("ran","x")']) } } as any;
    const root = tmp;
    const out = await judgeCommandChecks([check], {
      root, approvals: [], timeoutMs: 5000,
      airlock: (argv: string[], cwd: string) => airlockArgvFor(deps({ platform: 'win32' }), 't1', argv, cwd),
    } as any);
    expect(out['command-check:lint']).toMatchObject({ outcome: 'fail' });
    expect(out['command-check:lint'].detail).toMatch(/Airlock/);
    expect(fs.existsSync(path.join(root, 'ran'))).toBe(false);
  });

  it('judgeCommandChecks: a covered card\'s check runs the wrapped line', async () => {
    if (process.platform === 'win32') return;
    const check = { id: 'command-check:lint', applicable: true, params: { argv: JSON.stringify(['npm', 'run', 'lint']) } } as any;
    const out = await judgeCommandChecks([check], { root: tmp, approvals: [], timeoutMs: 5000, airlock: (argv: string[], cwd: string) => airlockArgvFor(deps(), 't1', argv, cwd) } as any);
    expect(out['command-check:lint'].detail).toContain('airlock');
  });

  it('git hooks are off for a covered card in enforce mode, on for anyone else', async () => {
    expect(await airlockHooksOff(deps(), 't1')).toBe(true);
    expect(await airlockHooksOff(deps(), 's2')).toBe(false);
    mode = 'observe';
    expect(await airlockHooksOff(deps(), 't1')).toBe(false);
    expect(await airlockHooksOff(deps({ effectiveMode: async () => { throw new Error('x'); } }), 't1')).toBe(true);
  });

  it('noHooksGitEnv: a commit with it runs no hook, and keeps the configuration already in the environment', () => {
    if (process.platform === 'win32') return;
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const git = (args: string[], env?: NodeJS.ProcessEnv) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: env ?? process.env });
    git(['init', '-q']);
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/HOOK_RAN"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(['add', 'a.txt']);
    const env = noHooksGitEnv({ ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Kept Name', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_EMAIL: 'a@b' });
    const r = git(['commit', '-qm', 'x'], env);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(repo, 'HOOK_RAN'))).toBe(false);
    expect(git(['log', '-1', '--format=%an']).stdout.trim()).toBe('Kept Name');
  });
});

describe('SX-3 review pass 2', () => {
  it('the hooks path points nowhere a sandboxed command could write a hook into', () => {
    const env = noHooksGitEnv({});
    const target = env.GIT_CONFIG_VALUE_0!;
    if (process.platform === 'win32') {
      expect(target).toContain(path.join('.agenfk', 'airlock'));
    } else {
      expect(target).toBe('/dev/null');
      expect(target.startsWith(os.tmpdir())).toBe(false);
    }
  });

  it('a flow check run in its own group: a timeout ends what it started too', async () => {
    if (process.platform === 'win32') return;
    const pidFile = path.join(tmp, 'check-sleeper.pid');
    const started = Date.now();
    const r = await runArgv(['/bin/sh', '-c', `sleep 600 & echo $! > ${pidFile}; wait`], tmp, 800, { processGroup: true });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
    const sleeper = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await vi.waitFor(() => { let alive = true; try { process.kill(sleeper, 0); } catch { alive = false; } expect(alive).toBe(false); }, { timeout: 5000 });
  }, 20000);

  it('runArgv in a group still reports the exit code and output', async () => {
    if (process.platform === 'win32') return;
    expect(await runArgv(['/bin/sh', '-c', 'echo hi; exit 3'], tmp, 5000, { processGroup: true })).toMatchObject({ exitCode: 3, output: 'hi' });
    expect(await runArgv(['/bin/sh', '-c', 'echo ok'], tmp, 5000, { processGroup: true })).toMatchObject({ exitCode: 0, output: 'ok' });
    expect((await runArgv(['/nope/missing'], tmp, 5000, { processGroup: true })).notFound).toBe(true);
  });

  it('a wrapped flow check asks for the group', async () => {
    if (process.platform === 'win32') return;
    expect((await airlockArgvFor(deps(), 't1', ['npm', 'test'], '/w')).processGroup).toBe(true);
    expect((await airlockArgvFor(deps(), 's2', ['npm', 'test'], '/w')).processGroup).toBeUndefined();
  });

  it('the server URL for exec brackets an IPv6 bind address', () => {
    expect(serverUrlFor('::1', 3000)).toBe('http://[::1]:3000');
    expect(serverUrlFor('127.0.0.1', 3000)).toBe('http://127.0.0.1:3000');
    expect(serverUrlFor('0.0.0.0', 3000)).toBe('http://127.0.0.1:3000');
    expect(serverUrlFor('::', 3000)).toBe('http://[::1]:3000');
    expect(serverUrlFor('localhost', 3000)).toBe('http://localhost:3000');
    expect(serverUrlFor('127.0.0.1', null)).toBeNull();
  });
});

describe('SX-3 review pass 3', () => {
  it('a grouped check that exits while a child still holds its output reports its own exit, at once, and the child is ended', async () => {
    if (process.platform === 'win32') return;
    const pidFile = path.join(tmp, 'orphan.pid');
    const started = Date.now();
    const r = await runArgv(['/bin/sh', '-c', `sleep 600 & echo $! > ${pidFile}; echo done; exit 0`], tmp, 10000, { processGroup: true });
    expect(r).toMatchObject({ exitCode: 0 });
    expect(r.timedOut).toBeFalsy();
    expect(r.output).toContain('done');
    expect(Date.now() - started).toBeLessThan(5000);
    const sleeper = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await vi.waitFor(() => { let alive = true; try { process.kill(sleeper, 0); } catch { alive = false; } expect(alive).toBe(false); }, { timeout: 5000 });
  }, 20000);
});

describe('ea94c023: the desktop server runs exec with Electron as Node', () => {
  it('the line sets the given variables before the launcher', async () => {
    if (process.platform === 'win32') return;
    const r = await airlockCommandFor(deps({ lineEnv: { ELECTRON_RUN_AS_NODE: '1' } }), 't1', 'npm test', '/w');
    expect(r.command.startsWith("AGENFK_API_URL='http://127.0.0.1:47555' ELECTRON_RUN_AS_NODE='1' ")).toBe(true);
  });
});

describe('PO-1: exec is told the card\'s project', () => {
  it('the line names the card\'s project for exec\'s policy fetch', async () => {
    if (process.platform === 'win32') return;
    const r = await airlockCommandFor(deps(), 't1', 'npm test', '/w');
    const out = spawnSync('/bin/sh', ['-c', r.command], { encoding: 'utf8' });
    expect(JSON.parse(out.stdout)).toEqual(['airlock', 'exec', '--no-process-group', '--project-id', 'p', '--cwd', '/w', '--', 'npm test']);
  });
});
