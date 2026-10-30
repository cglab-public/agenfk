/**
 * SX-2 (8dd7c7c0): `agenfk airlock exec`, which the AgEnFK server spawns to run a
 * verify or suite command for a card an Airlock sandbox touched. It runs the
 * command inside the sandbox built from the effective policy for a COMMAND, not a
 * client: the workspace writable, credential stores and the report token
 * unreadable, AgEnFK's own files unwritable, egress only to the policy's allow
 * list, loopback allowed so test servers work (user decision 2026-10-28). It fails
 * closed: when the policy cannot be read or the sandbox cannot start, the command
 * never runs and the exit is 125.
 *
 * Tested with a fake runtime: nothing is sandboxed here (the conformance suite
 * runs the real one).
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { HOME_CREDENTIAL_STORES, normalizeAirlockPolicy } from '@agenfk/core';
import { runAirlockExec, scopedCommandEnv, EXEC_CANNOT_SANDBOX, type ExecDeps } from '../airlock/exec';
import type { SandboxCommand, SandboxExit } from '../airlock/runtime';
import type { SandboxSpec } from '../airlock/spec';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const HOME = '/home/u';
const CWD = '/work/repo';
/** What a server of this version says it does. */
const CAPS = ['sandboxed-commands', 'machine-image'];

function deps(over: Partial<ExecDeps> = {}, exit: SandboxExit = { code: 0, signal: null }): ExecDeps & { errors: string[] } {
  const errors: string[] = [];
  return {
    // a whole policy, as the server serves one (exec refuses a partial answer)
    fetchPolicy: vi.fn(async () => ({ effective: normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['registry.npmjs.org', 'localhost'], deny: [] } }), source: 'local', revision: 3, capabilities: CAPS })),
    runtime: {
      id: 'fake',
      check: vi.fn(async () => ({ ok: true as const, warnings: [] })),
      launch: vi.fn(async (_s: SandboxSpec, _c: SandboxCommand) => ({ pid: 7, kill: vi.fn(() => true), exited: Promise.resolve(exit) })),
      dispose: vi.fn(async () => undefined),
    },
    home: HOME,
    tmpDir: '/tmp/t',
    installDirs: ['/home/u/.agenfk-system'],
    runtimePackageDir: '/home/u/.agenfk/smolvm/1.32.4',
    directServerPort: 3000,
    listDir: () => [],
    realpath: (p: string) => p,
    isDirectory: () => false,
    exists: () => false,
    platform: 'darwin',
    ensurePrivateDir: vi.fn(),
    onSignal: vi.fn(() => () => undefined),
    error: (m: string) => { errors.push(m); },
    agenfkVersion: () => '2.1.0',
    env: {},
    ...over,
    errors,
  } as ExecDeps & { errors: string[] };
}

const specOf = (d: ExecDeps): SandboxSpec => (d.runtime.launch as any).mock.calls[0][0];
const cmdOf = (d: ExecDeps): SandboxCommand => (d.runtime.launch as any).mock.calls[0][1];

describePosix('runAirlockExec', () => {
  it('runs the command with sh in the workspace, inside the sandbox, and gives back its exit code', async () => {
    const d = deps({}, { code: 3, signal: null });
    expect(await runAirlockExec('npm test -- --run', { cwd: CWD }, d)).toBe(3);
    expect(cmdOf(d)).toEqual({ file: '/bin/sh', args: ['-c', 'npm test -- --run'], cwd: CWD, processGroup: true });
    expect(d.runtime.dispose).toHaveBeenCalled();
  });

  it('a command\'s sandbox keeps what git reads its config from unwritable too (BUG 4639c6a4)', async () => {
    const d = deps();
    (d as any).isDirectory = (p: string) => p === path.join(CWD, '.git');
    await runAirlockExec('true', { cwd: CWD }, d);
    expect(specOf(d).filesystem.denyWrite).toEqual(expect.arrayContaining(['commondir', 'config.worktree', 'modules', 'worktrees'].map((n) => path.join(CWD, '.git', n))));
  });

  // BUG 38d7231e (user decision 2026-10-28): tools that hardcode /tmp work in the sandbox too.
  it('a command\'s sandbox has the shared /tmp writable, by its real path', async () => {
    const d = deps({ realpath: (p: string) => (p === '/tmp' ? '/private/tmp' : p) });
    await runAirlockExec('true', { cwd: CWD }, d);
    expect(specOf(d).filesystem.allowWrite).toEqual(expect.arrayContaining(['/tmp/t', '/private/tmp']));
  });

  it('a command killed by a signal exits 128 + its number', async () => {
    const d = deps({}, { code: null, signal: 'SIGTERM' });
    expect(await runAirlockExec('sleep 99', { cwd: CWD }, d)).toBe(128 + 15);
  });

  it('the sandbox for a command: workspace writable, credentials and the report token unreadable, AgEnFK files unwritable', async () => {
    const d = deps();
    await runAirlockExec('true', { cwd: CWD }, d);
    const spec = specOf(d);
    expect(spec.filesystem.allowWrite).toContain(CWD);
    expect(spec.filesystem.denyRead).toEqual(expect.arrayContaining([...HOME_CREDENTIAL_STORES.map((p) => path.join(HOME, p)), path.join(HOME, '.agenfk', 'airlock')]));
    expect(spec.filesystem.denyWrite).toEqual(expect.arrayContaining([path.join(HOME, '.agenfk'), path.join(CWD, '.agenfk')]));
    // no client's state is writable: it is a command, not pi or OpenCode
    expect(spec.filesystem.allowWrite).not.toContain(path.join(HOME, '.pi', 'agent'));
  });

  it('egress is the policy\'s allow list only: no AgEnFK server entry, no inference host, loopback-without-a-port left out', async () => {
    const d = deps();
    await runAirlockExec('true', { cwd: CWD }, d);
    const spec = specOf(d);
    expect(spec.network.allow).toEqual(['registry.npmjs.org']);
    expect(spec.env.AGENFK_API_URL).toBeUndefined();
  });

  it('loopback is the command\'s own: binding allowed, and loopback goes direct rather than through the proxy', async () => {
    const d = deps();
    await runAirlockExec('true', { cwd: CWD }, d);
    const spec = specOf(d);
    expect(spec.allowLocalBinding).toBe(true);
    expect(spec.env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(spec.env.no_proxy).toBe('localhost,127.0.0.1,::1');
    expect(spec.env.AGENFK_AIRLOCK_SANDBOX).toBe('command');
  });

  it('a policy that cannot be read: the command never runs, exit 125 with the reason', async () => {
    const d = deps({ fetchPolicy: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) });
    expect(await runAirlockExec('true', { cwd: CWD }, d)).toBe(EXEC_CANNOT_SANDBOX);
    expect(EXEC_CANNOT_SANDBOX).toBe(125);
    expect(d.runtime.launch).not.toHaveBeenCalled();
    expect(d.errors.join('\n')).toMatch(/Airlock.*policy.*ECONNREFUSED/s);
  });

  it('a sandbox that cannot start: the command never runs, exit 125 with the reason', async () => {
    const d = deps({ runtime: { ...deps().runtime, launch: vi.fn(async () => { throw new Error('The Airlock sandbox could not start here'); }) } as any });
    expect(await runAirlockExec('true', { cwd: CWD }, d)).toBe(EXEC_CANNOT_SANDBOX);
    expect(d.errors.join('\n')).toMatch(/could not start/);
  });

  it('it sandboxes whatever the mode says: the server asks only when it must', async () => {
    const d = deps({ fetchPolicy: vi.fn(async () => ({ effective: normalizeAirlockPolicy({ mode: 'observe' }), source: 'local', revision: 1, capabilities: CAPS })) });
    await runAirlockExec('true', { cwd: CWD }, d);
    expect(d.runtime.launch).toHaveBeenCalled();
  });

  it('a signal to exec reaches the sandboxed command', async () => {
    let handler: (() => void) | null = null;
    const kill = vi.fn(() => true);
    let release: (e: SandboxExit) => void = () => {};
    const d = deps({
      onSignal: vi.fn((sig: string, h: () => void) => { if (sig === 'SIGTERM') handler = h; return () => {}; }) as any,
      runtime: { ...deps().runtime, launch: vi.fn(async () => ({ pid: 7, kill, exited: new Promise<SandboxExit>((r) => { release = r; }) })) } as any,
    });
    const run = runAirlockExec('sleep 9', { cwd: CWD }, d);
    await vi.waitFor(() => expect(handler).not.toBeNull());
    handler!();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    release({ code: null, signal: 'SIGTERM' });
    expect(await run).toBe(143);
  });
});

describe('scopedCommandEnv', () => {
  it('keeps what a suite needs and drops what looks like a secret', () => {
    const env = scopedCommandEnv({
      PATH: '/usr/bin', HOME: '/home/u', NODE_ENV: 'test', CI: '1', LANG: 'en_US.UTF-8', TMPDIR: '/tmp', FORCE_COLOR: '1',
      GITHUB_TOKEN: 'x', NPM_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', AWS_ACCESS_KEY_ID: 'x', AWS_SESSION_TOKEN: 'x',
      OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', DB_PASSWORD: 'x', MY_SECRET: 'x', GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
      NPM_CONFIG__AUTH: 'x', AGENFK_VERIFY_TOKEN: 'x', SSH_AUTH_SOCK: '/tmp/ssh', PRIVATE_KEY: 'x',
    });
    expect(Object.keys(env).sort()).toEqual(['CI', 'FORCE_COLOR', 'HOME', 'LANG', 'NODE_ENV', 'PATH', 'TMPDIR']);
  });

  it('never keeps an undefined value', () => {
    expect(scopedCommandEnv({ PATH: '/usr/bin', EMPTY: undefined })).toEqual({ PATH: '/usr/bin' });
  });
});

describe('agenfk airlock exec (command wiring)', () => {
  it('hands the command after -- and --cwd to exec, and exits with its code', async () => {
    const { Command } = await import('commander');
    const { registerAirlockCommands } = await import('../commands/airlock');
    const exec = vi.fn(async () => 4);
    const exit = vi.fn();
    const program = new Command();
    registerAirlockCommands(program, { launch: async () => 0, exec, exit });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'exec', '--cwd', '/work/repo', '--', 'npm test -- --run']);
    expect(exec).toHaveBeenCalledWith('npm test -- --run', { cwd: '/work/repo', processGroup: true, projectId: undefined });
    expect(exit).toHaveBeenCalledWith(4);
  });

  it('without a command it refuses with 125: there is nothing to sandbox', async () => {
    const { Command } = await import('commander');
    const { registerAirlockCommands } = await import('../commands/airlock');
    const exec = vi.fn(async () => 0);
    const exit = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = new Command();
    registerAirlockCommands(program, { launch: async () => 0, exec, exit });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'exec', '--cwd', '/work/repo']);
    expect(exec).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(125);
    err.mockRestore();
  });
});

describe('SX-2 review (Codex gpt-6.1-sol 01a18251)', () => {
  it('the environment is an allowlist: names a suite needs, and nothing secret by name or by value', () => {
    const env = scopedCommandEnv({
      PATH: '/usr/bin', HOME: '/home/u', USER: 'u', SHELL: '/bin/zsh', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', TERM: 'xterm',
      NODE_ENV: 'test', NODE_OPTIONS: '--max-old-space-size=4096', VITEST_POOL: 'forks', npm_lifecycle_event: 'test',
      GH_PAT: 'ghp_x', DATABASE_URL: 'postgres://user:password@db/app', 'NPM_CONFIG_//registry.npmjs.org/:_authToken': 'npm_x',
      NODE_AUTH_TOKEN: 'x', SOME_PROJECT_VAR: 'hello', PGPASSFILE: '/x', KUBECONFIG: '/k',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'NODE_ENV', 'NODE_OPTIONS', 'PATH', 'SHELL', 'TERM', 'TZ', 'USER', 'VITEST_POOL', 'npm_lifecycle_event']);
  });

  it('an allowed name whose value carries credentials is still dropped', () => {
    expect(scopedCommandEnv({ NODE_OPTIONS: '--require https://u:p@evil.example/x.js', PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
  });

  it('a policy answer that is not a whole policy: the command never runs, 125', async () => {
    const noIoc = (({ iocHosts: _i, ...rest }) => rest)(normalizeAirlockPolicy({ mode: 'enforce' }));
    for (const answer of [
      {}, null, { effective: null }, { effective: { mode: 'enforce' } },
      { effective: { mode: 'bogus', hosts: { allow: [], deny: [] }, rules: {} } },
      // pass 2: an answer with no IOC list would lose its denies to the default
      { effective: noIoc },
      { effective: { ...noIoc, iocHosts: { revision: '1' } } },
    ]) {
      const d = deps({ fetchPolicy: vi.fn(async () => answer as any) });
      expect(await runAirlockExec('true', { cwd: CWD }, d), JSON.stringify(answer)).toBe(EXEC_CANNOT_SANDBOX);
      expect(d.runtime.launch).not.toHaveBeenCalled();
    }
  });

  it('the command runs in a process group of its own', async () => {
    const d = deps();
    await runAirlockExec('true', { cwd: CWD }, d);
    expect(cmdOf(d)).toMatchObject({ processGroup: true });
  });

  it('exec takes the command as ONE argument, verbatim; several are refused (their quoting would be lost)', async () => {
    const { Command } = await import('commander');
    const { registerAirlockCommands } = await import('../commands/airlock');
    const exec = vi.fn(async () => 0);
    const exit = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = new Command();
    registerAirlockCommands(program, { launch: async () => 0, exec, exit });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'exec', '--cwd', '/w', '--', "printf '%s\\n' 'a; touch marker'"]);
    expect(exec).toHaveBeenCalledWith("printf '%s\\n' 'a; touch marker'", { cwd: '/w', processGroup: true, projectId: undefined });
    const program2 = new Command();
    registerAirlockCommands(program2, { launch: async () => 0, exec, exit });
    await program2.parseAsync(['node', 'agenfk', 'airlock', 'exec', '--cwd', '/w', '--', 'printf', '%s', 'a; touch marker']);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenLastCalledWith(125);
    err.mockRestore();
  });
});

describe('SX-2 review pass 2', () => {
  it('exec asks the server it was pointed at, captured before the environment is scoped', async () => {
    const { defaultExecDeps } = await import('../commands/airlock');
    const get = vi.fn(async (_url: string) => ({ data: { effective: normalizeAirlockPolicy({ mode: 'enforce' }) } }));
    const d = defaultExecDeps('http://127.0.0.1:47999', get as any);
    expect(d.directServerPort).toBe(47999);
    await d.fetchPolicy();
    expect(get.mock.calls[0][0]).toBe('http://127.0.0.1:47999/airlock/policy');
  });
});

describe('exec --no-process-group (SX-3)', () => {
  it('keeps the command in exec\'s own group, so a caller that kills exec\'s group kills it too', async () => {
    const d = deps();
    await runAirlockExec('true', { cwd: CWD, processGroup: false }, d);
    expect(cmdOf(d)).toMatchObject({ processGroup: false });
  });

  it('is parsed from the command line', async () => {
    const { Command } = await import('commander');
    const { registerAirlockCommands } = await import('../commands/airlock');
    const exec = vi.fn(async () => 0);
    const program = new Command();
    registerAirlockCommands(program, { launch: async () => 0, exec, exit: vi.fn() });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'exec', '--no-process-group', '--cwd', '/w', '--', 'npm test']);
    expect(exec).toHaveBeenCalledWith('npm test', { cwd: '/w', processGroup: false, projectId: undefined });
  });
});

describe('SX-3 review: a command cannot read the verify token', () => {
  it('~/.agenfk/verify-token is unreadable in a command\'s sandbox (the agent\'s own clients keep it)', async () => {
    const d = deps();
    await runAirlockExec('true', { cwd: CWD }, d);
    expect(specOf(d).filesystem.denyRead).toContain(path.join(HOME, '.agenfk', 'verify-token'));
  });
});

describe('PO-1: exec asks for the card\'s project', () => {
  it('--project-id reaches the policy fetch', async () => {
    const d = deps();
    await runAirlockExec('true', { cwd: CWD, projectId: 'p-api' }, d);
    expect((d.fetchPolicy as any).mock.calls[0][0]).toBe('p-api');
  });

  it('is parsed from the command line', async () => {
    const { Command } = await import('commander');
    const { registerAirlockCommands } = await import('../commands/airlock');
    const exec = vi.fn(async () => 0);
    const program = new Command();
    registerAirlockCommands(program, { launch: async () => 0, exec, exit: vi.fn() });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'exec', '--project-id', 'p-api', '--cwd', '/w', '--', 'npm test']);
    expect(exec).toHaveBeenCalledWith('npm test', { cwd: '/w', processGroup: true, projectId: 'p-api' });
  });

  it('defaultExecDeps asks the server for that project', async () => {
    const { defaultExecDeps } = await import('../commands/airlock');
    const get = vi.fn(async (_url: string) => ({ data: { effective: normalizeAirlockPolicy({ mode: 'enforce' }) } }));
    await defaultExecDeps('http://127.0.0.1:47999', get as any).fetchPolicy('p api');
    expect(get.mock.calls[0][0]).toBe('http://127.0.0.1:47999/airlock/policy?projectId=p%20api');
  });
});

/**
 * CGLAB-696 task 5: the command runs in the workspace's machine, made from the image the
 * session's is (the policy's, else the AgEnFK base image of this version), with the
 * environment a toolchain reads there - never the host's paths, which mean nothing in the guest.
 */
describePosix('a command in the workspace machine (CGLAB-696 task 5)', () => {
  const withPolicy = (policy: Record<string, unknown>, capabilities: string[] = CAPS) =>
    vi.fn(async () => ({ effective: normalizeAirlockPolicy({ mode: 'enforce', ...policy }), source: 'local', revision: 1, capabilities }));

  it('is a command\'s spec, so the runtime runs it as one', async () => {
    const d = deps();
    await runAirlockExec('true', { cwd: CWD }, d);
    expect(specOf(d).purpose).toBe('command');
  });

  it('runs in the image the policy names', async () => {
    const d = deps({ fetchPolicy: withPolicy({ machineImage: 'ghcr.io/acme/airlock:7' }) });
    await runAirlockExec('true', { cwd: CWD }, d);
    expect(specOf(d).machineImage).toBe('ghcr.io/acme/airlock:7');
  });

  it('runs in the AgEnFK base image of this version when the policy names none', async () => {
    const d = deps({ agenfkVersion: () => '2.1.0-beta.6' });
    await runAirlockExec('true', { cwd: CWD }, d);
    expect(specOf(d).machineImage).toBe('ghcr.io/cglab-public/agenfk-airlock-base:2.1.0-beta.6');
  });

  it('a server that does not deliver the machine image: the command never runs, 125 with the reason', async () => {
    const d = deps({ fetchPolicy: withPolicy({}, ['sandboxed-commands']) });
    expect(await runAirlockExec('true', { cwd: CWD }, d)).toBe(EXEC_CANNOT_SANDBOX);
    expect(d.runtime.launch).not.toHaveBeenCalled();
    expect(d.errors.join('\n')).toMatch(/older than this agenfk.*machine image/s);
  });

  it('gets what a toolchain reads in the guest, and none of the host\'s paths or secrets', async () => {
    const d = deps({
      env: {
        CI: '1', NODE_ENV: 'test', LANG: 'en_US.UTF-8', TZ: 'UTC', FORCE_COLOR: '0', VITEST_POOL_ID: '1', LC_ALL: 'C',
        PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/u', TMPDIR: '/var/folders/x', NODE_PATH: '/Users/u/lib',
        SHELL: '/bin/zsh', PWD: '/Users/u', JAVA_HOME: '/Library/Java', XDG_CONFIG_HOME: '/Users/u/.config',
        GH_TOKEN: 'ghp_fake', OPENAI_API_KEY: 'sk-fake',
      },
    });
    await runAirlockExec('true', { cwd: CWD }, d);
    const env = specOf(d).env;
    expect(env).toMatchObject({ CI: '1', NODE_ENV: 'test', LANG: 'en_US.UTF-8', TZ: 'UTC', FORCE_COLOR: '0', VITEST_POOL_ID: '1', LC_ALL: 'C' });
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'NODE_PATH', 'SHELL', 'PWD', 'JAVA_HOME', 'XDG_CONFIG_HOME', 'GH_TOKEN', 'OPENAI_API_KEY']) {
      expect(env, k).not.toHaveProperty(k);
    }
  });

  it('a value naming a host path stays out too: a host preload in NODE_OPTIONS, npm\'s package.json (review 01a18ca1)', async () => {
    const d = deps({
      env: {
        NODE_OPTIONS: '--require=/opt/host/instrumentation.js', npm_package_json: '/Users/u/app/package.json',
        npm_lifecycle_script: 'vitest run', npm_package_name: 'app', TZ: 'America/Sao_Paulo',
      },
    });
    await runAirlockExec('true', { cwd: CWD }, d);
    const env = specOf(d).env;
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('npm_package_json');
    expect(env).toMatchObject({ npm_lifecycle_script: 'vitest run', npm_package_name: 'app', TZ: 'America/Sao_Paulo' });
  });

  it('a quoted host path stays out as well (review 01a18ca1, pass 2)', async () => {
    for (const NODE_OPTIONS of ['--require="/opt/host/x.js"', "--require='/opt/host/x.js'", '-r "/opt/host/x.js"']) {
      const d = deps({ env: { NODE_OPTIONS } });
      await runAirlockExec('true', { cwd: CWD }, d);
      expect(specOf(d).env, NODE_OPTIONS).not.toHaveProperty('NODE_OPTIONS');
    }
  });

  it('NODE_OPTIONS without a path is kept: a heap size means the same in the guest', async () => {
    const d = deps({ env: { NODE_OPTIONS: '--max-old-space-size=4096' } });
    await runAirlockExec('true', { cwd: CWD }, d);
    expect(specOf(d).env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
  });

  it('the environment never overrides what the spec sets: the sandbox marker stays the command\'s', async () => {
    const d = deps({ env: { AGENFK_AIRLOCK_SANDBOX: 'pi', NO_PROXY: '*' } as any });
    await runAirlockExec('true', { cwd: CWD }, d);
    expect(specOf(d).env.AGENFK_AIRLOCK_SANDBOX).toBe('command');
    expect(specOf(d).env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
  });

  it('defaultExecDeps reads the version and the scoped environment', async () => {
    const { defaultExecDeps } = await import('../commands/airlock');
    const d = defaultExecDeps('http://127.0.0.1:47999', vi.fn() as any);
    expect(d.agenfkVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.env).toBe(process.env);
  });
});
