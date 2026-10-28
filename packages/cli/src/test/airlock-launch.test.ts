/**
 * Airlock layer 2 (GH-294, L2-2): `agenfk airlock pi|opencode` resolve the
 * effective policy and the session model, build the sandbox spec and launch the
 * client inside the runtime. Tested with a fake runtime: nothing is sandboxed
 * and no model session starts.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { Command } from 'commander';
import { runAirlockLaunch, AirlockLaunchError, findAgenfkDirs, type LaunchDeps } from '../airlock/launch';
import { registerAirlockCommands } from '../commands/airlock';
import type { AirlockRuntime, SandboxCommand, SandboxExit } from '../airlock/runtime';
import type { SandboxSpec } from '../airlock/spec';

// The launcher refuses Windows (AsrtRuntime.check, tested there), so these POSIX
// sandbox specs never run on it; their literal POSIX paths would not hold either.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

const HOME = '/home/u';
const CWD = '/work/repo';

function fakeRuntime(exit: SandboxExit = { code: 0, signal: null }, check: Awaited<ReturnType<AirlockRuntime['check']>> = { ok: true, warnings: [] }) {
  const launched = { pid: 99, kill: vi.fn(() => true), exited: Promise.resolve(exit) };
  const runtime = {
    id: 'fake',
    check: vi.fn(async () => check),
    launch: vi.fn(async (_spec: SandboxSpec, _cmd: SandboxCommand) => launched),
    dispose: vi.fn(async () => undefined),
  };
  return { runtime, launched };
}

function deps(over: Partial<LaunchDeps> = {}, files: Record<string, unknown> = {}): LaunchDeps & { warnings: string[] } {
  const warnings: string[] = [];
  const { runtime } = fakeRuntime();
  return {
    fetchPolicy: vi.fn(async () => ({ effective: { mode: 'enforce', hosts: { allow: ['api.github.com'], deny: [] } }, source: 'local', revision: 3, capabilities: ['sandboxed-commands'] })),
    runtime,
    // enforce launches need it to mark the sandbox's requests to the server (SX-1)
    reportToken: () => 'airlock-report-token-0123456789abcdef',
    startRelay: vi.fn(async () => ({ host: '127.0.0.1', port: 47001, close: vi.fn(async () => undefined) })),
    env: { OPENAI_API_KEY: 'sk-real' },
    home: HOME,
    cwd: CWD,
    tmpDir: '/tmp/t',
    apiUrl: 'http://localhost:3123',
    readJson: (p: string) => (p in files ? files[p] : null),
    exists: (p: string) => p in files,
    which: (f: string) => `/usr/local/bin/${f}`,
    runtimePackageDir: '/home/u/.agenfk-system/node_modules/@anthropic-ai/sandbox-runtime',
    installDirs: ['/home/u/.agenfk-system'],
    log: vi.fn(),
    warn: (m: string) => { warnings.push(m); },
    onSignal: vi.fn(() => () => undefined),
    listDir: () => [],
    realpath: (p: string) => p,
    isDirectory: () => false,
    platform: 'darwin',
    ensurePrivateDir: vi.fn(),
    ...over,
    warnings,
  } as LaunchDeps & { warnings: string[] };
}

const specOf = (d: LaunchDeps): SandboxSpec => (d.runtime.launch as any).mock.calls[0][0];
const cmdOf = (d: LaunchDeps): SandboxCommand => (d.runtime.launch as any).mock.calls[0][1];

describePosix('runAirlockLaunch: pi', () => {
  it('launches pi inside the sandbox with the effective policy, its inference host, the marker and the masked key', async () => {
    const d = deps();
    const code = await runAirlockLaunch('pi', ['--model', 'openai/gpt-5', '-p', 'hi'], { keyEnv: [] }, d);
    expect(code).toBe(0);
    const spec = specOf(d);
    // SX-1: the sandbox reaches the server only through the launcher's relay
    expect(spec.network.allow).toEqual(expect.arrayContaining(['api.github.com', 'api.openai.com', '127.0.0.1:47001', 'localhost:47001']));
    expect(spec.network.allow.some((h) => h.endsWith(':3123'))).toBe(false);
    expect(spec.env).toMatchObject({ AGENFK_AIRLOCK_SANDBOX: 'pi', NODE_USE_ENV_PROXY: '1', AGENFK_API_URL: 'http://127.0.0.1:47001' });
    expect(spec.maskedEnv).toEqual([{ name: 'OPENAI_API_KEY', injectHosts: ['api.openai.com'] }]);
    expect(spec.filesystem.allowWrite).toEqual(expect.arrayContaining([CWD, '/tmp/t', '/home/u/.pi/agent']));
    expect(spec.filesystem.denyWrite).toEqual(expect.arrayContaining([
      '/home/u/.agenfk', '/home/u/.agenfk-system', '/home/u/.agenfk-system/node_modules/@anthropic-ai/sandbox-runtime',
    ]));
    expect(cmdOf(d)).toEqual({ file: '/usr/local/bin/pi', args: ['--model', 'openai/gpt-5', '-p', 'hi'], cwd: CWD });
    expect(d.runtime.dispose).toHaveBeenCalled();
  });

  it('takes the model from pi settings and the endpoint and key variable from pi models.json', async () => {
    const d = deps({ env: { SPARK_KEY: 'real' } }, {
      [path.join(HOME, '.pi/agent/settings.json')]: { defaultProvider: 'spark', defaultModel: 'GLM' },
      [path.join(HOME, '.pi/agent/models.json')]: { providers: { spark: { baseUrl: 'https://spark.example.com/v1', apiKey: 'SPARK_KEY' } } },
    });
    await runAirlockLaunch('pi', [], { keyEnv: [] }, d);
    const spec = specOf(d);
    expect(spec.network.allow).toContain('spark.example.com');
    expect(spec.maskedEnv).toEqual([{ name: 'SPARK_KEY', injectHosts: ['spark.example.com'] }]);
  });

  it('a plain-http inference endpoint is allowed on its port, and its key cannot be masked (said so)', async () => {
    const d = deps({ env: { LOCAL_KEY: 'k' } }, {
      [path.join(HOME, '.pi/agent/models.json')]: { providers: { local: { baseUrl: 'http://127.0.0.1:8081/v1', apiKey: 'LOCAL_KEY' } } },
    });
    await runAirlockLaunch('pi', ['--provider', 'local', '--model', 'gemma'], { keyEnv: [] }, d);
    const spec = specOf(d);
    expect(spec.network.allow).toContain('127.0.0.1:8081');
    expect(spec.maskedEnv).toEqual([]);
    expect(d.warnings.join('\n')).toMatch(/LOCAL_KEY.*not masked/);
  });

  it('--key-env masks a variable the caller names, and refuses one that is not set', async () => {
    const d = deps({ env: { OPENAI_API_KEY: 'a', MY_KEY: 'b' } });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: ['MY_KEY'] }, d);
    expect(specOf(d).maskedEnv.map((m) => m.name).sort()).toEqual(['MY_KEY', 'OPENAI_API_KEY']);
    await expect(runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: ['NOPE'] }, deps()))
      .rejects.toThrow(/NOPE.*not set/);
  });

  it('says pi auth.json is not readable inside when no key variable is masked', async () => {
    const d = deps({ env: {} });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(d.warnings.join('\n')).toMatch(/auth\.json/);
  });

  it('what git reads its config from in the workspace is unwritable when .git is a directory (BUG 4639c6a4)', async () => {
    const d = deps();
    d.isDirectory = (p: string) => p === path.join(path.resolve(CWD), '.git');
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).filesystem.denyWrite).toEqual(expect.arrayContaining(['commondir', 'config.worktree', 'modules', 'worktrees'].map((n) => path.join(path.resolve(CWD), '.git', n))));
  });

  it('a workspace whose .git is a file (a linked worktree) adds none of them', async () => {
    const d = deps();
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).filesystem.denyWrite.filter((p: string) => p.startsWith(path.join(path.resolve(CWD), '.git')))).toEqual([]);
  });

  it('marks the project .agenfk directories above the workspace unwritable', async () => {
    const d = deps({}, { '/work/.agenfk': {} });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).filesystem.denyWrite).toContain('/work/.agenfk');
  });
});

describe('runAirlockLaunch: a server older than this launcher (BUG 1a7dd9d2)', () => {
  const olderServer = (mode: string) => vi.fn(async () => ({ effective: { mode, hosts: { allow: ['api.github.com'], deny: [] } }, source: 'local', revision: 3 }));

  it('enforce: a server that does not say it sandboxes a covered card\'s commands is refused, nothing launched', async () => {
    const d = deps({ fetchPolicy: olderServer('enforce') });
    await expect(runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d)).rejects.toThrow(/older than this agenfk.*agenfk restart/s);
    expect((d.runtime as any).launch).not.toHaveBeenCalled();
  });

  it('observe: it launches, with a warning saying the server\'s commands are not sandboxed', async () => {
    const d = deps({ fetchPolicy: olderServer('observe') });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(d.warnings.join('\n')).toMatch(/older than this agenfk/);
  });

  it('a server that says so launches as before', async () => {
    const d = deps();
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(d.warnings.join('\n')).not.toMatch(/older than this agenfk/);
  });
});

describe('runAirlockLaunch: hub and policy', () => {
  it('builds from the effective policy only: a local row under a hub policy widens nothing', async () => {
    const d = deps({
      fetchPolicy: vi.fn(async () => ({
        effective: { mode: 'enforce', hosts: { allow: ['hub-only.example.com'], deny: [] } },
        source: 'hub', revision: 9, hubManaged: true, capabilities: ['sandboxed-commands'],
        local: { policy: { mode: 'enforce', hosts: { allow: ['local-wide.example.com'], deny: [] } } },
      })),
    });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    const allow = specOf(d).network.allow;
    expect(allow).toContain('hub-only.example.com');
    expect(allow).not.toContain('local-wide.example.com');
  });

  it('refuses when the policy is off', async () => {
    const d = deps({ fetchPolicy: vi.fn(async () => ({ effective: { mode: 'off' }, source: 'local', revision: 1 })) });
    await expect(runAirlockLaunch('pi', [], { keyEnv: [] }, d)).rejects.toThrow(/policy is off/);
    expect(d.runtime.launch).not.toHaveBeenCalled();
  });

  it('refuses when the server cannot be reached (no policy, no sandbox)', async () => {
    const d = deps({ fetchPolicy: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    await expect(runAirlockLaunch('pi', [], { keyEnv: [] }, d)).rejects.toThrow(/AgEnFK server.*agenfk up/s);
    expect(d.runtime.launch).not.toHaveBeenCalled();
  });
});

describe('runAirlockLaunch: refusals', () => {
  it('passes on the runtime refusal (Windows, missing bwrap/socat) before anything else', async () => {
    const { runtime } = fakeRuntime(undefined, { ok: false, reason: 'Windows is not supported by the Airlock sandbox in this release.' });
    const d = deps({ runtime });
    await expect(runAirlockLaunch('pi', [], { keyEnv: [] }, d)).rejects.toThrow(/Windows is not supported/);
    expect(d.fetchPolicy).not.toHaveBeenCalled();
  });

  it('refuses when the client is not installed', async () => {
    const d = deps({ which: () => null });
    await expect(runAirlockLaunch('opencode', ['-m', 'openai/x'], { keyEnv: [] }, d)).rejects.toThrow(/opencode is not installed/);
  });

  it('refuses when it cannot tell which host serves the model', async () => {
    const d = deps();
    await expect(runAirlockLaunch('pi', ['--model', 'mystery/x'], { keyEnv: [] }, d)).rejects.toThrow(/inference host.*mystery/s);
  });

  it('refuses when the sandbox runtime sits where the sandboxed agent could rewrite it', async () => {
    const d = deps({ runtimePackageDir: '/work/repo/node_modules/@anthropic-ai/sandbox-runtime' });
    await expect(runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d)).rejects.toThrow(AirlockLaunchError);
    await expect(runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d)).rejects.toThrow(/sandbox runtime.*\/work\/repo/s);
    expect(d.runtime.launch).not.toHaveBeenCalled();
  });
});

describePosix('runAirlockLaunch: opencode', () => {
  it('launches opencode with its model from -m, its own state writable and its marker', async () => {
    const d = deps({ env: { ANTHROPIC_API_KEY: 'x' } });
    await runAirlockLaunch('opencode', ['-m', 'anthropic/claude-x'], { keyEnv: [] }, d);
    const spec = specOf(d);
    expect(spec.network.allow).toContain('api.anthropic.com');
    expect(spec.env.AGENFK_AIRLOCK_SANDBOX).toBe('opencode');
    expect(spec.filesystem.allowWrite).toContain('/home/u/.local/share/opencode');
    expect(spec.maskedEnv).toEqual([{ name: 'ANTHROPIC_API_KEY', injectHosts: ['api.anthropic.com'] }]);
  });

  it('takes the model and a custom endpoint from opencode.json', async () => {
    const d = deps({}, {
      [path.join(HOME, '.config/opencode/opencode.json')]: {
        model: 'corp/m1', provider: { corp: { options: { baseURL: 'https://llm.corp.example.com/v1' } } },
      },
    });
    await runAirlockLaunch('opencode', [], { keyEnv: [] }, d);
    expect(specOf(d).network.allow).toContain('llm.corp.example.com');
  });
});

describe('runAirlockLaunch: exit and signals', () => {
  it('returns the client exit code', async () => {
    const { runtime } = fakeRuntime({ code: 3, signal: null });
    expect(await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, deps({ runtime }))).toBe(3);
  });

  it('a client killed by a signal exits 128 + its number', async () => {
    const { runtime } = fakeRuntime({ code: null, signal: 'SIGTERM' });
    expect(await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, deps({ runtime }))).toBe(143);
  });

  it('forwards SIGINT, SIGTERM and SIGHUP to the sandboxed client, and stops forwarding after', async () => {
    const { runtime, launched } = fakeRuntime();
    const handlers = new Map<string, () => void>();
    const off = vi.fn();
    const d = deps({ runtime, onSignal: vi.fn((sig: NodeJS.Signals, h: () => void) => { handlers.set(sig, h); return off; }) });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect([...handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
    handlers.get('SIGTERM')!();
    expect(launched.kill).toHaveBeenCalledWith('SIGTERM');
    expect(off).toHaveBeenCalledTimes(3);
  });
});

describe('agenfk airlock pi|opencode (command wiring)', () => {
  it('hands every argument after the client name to the client, and --key-env to the launcher', async () => {
    const launch = vi.fn(async () => 5);
    const exit = vi.fn();
    const program = new Command();
    registerAirlockCommands(program, { launch, exit });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'pi', '--key-env', 'K', '--model', 'openai/x', '-p', 'hi there', '--help']);
    expect(launch).toHaveBeenCalledWith('pi', ['--model', 'openai/x', '-p', 'hi there', '--help'], { keyEnv: ['K'] });
    expect(exit).toHaveBeenCalledWith(5);
  });

  it('prints a launch refusal and exits 1', async () => {
    const launch = vi.fn(async () => { throw new AirlockLaunchError('The Airlock policy is off.'); });
    const exit = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = new Command();
    registerAirlockCommands(program, { launch, exit });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'opencode']);
    expect(err.mock.calls.flat().join(' ')).toMatch(/policy is off/);
    expect(exit).toHaveBeenCalledWith(1);
    err.mockRestore();
  });
});

/** A directory tree as listDir sees it: dir -> entries; a value of null is unreadable. */
function tree(dirs: Record<string, Array<[string, boolean] | [string, boolean, boolean]> | null>) {
  return (dir: string) => (dir in dirs ? (dirs[dir] === null ? null : dirs[dir]!.map(([name, isDir, isLink]) => ({ name, isDir, isLink: !!isLink }))) : []);
}

describePosix('nested .agenfk directories (review fix 3)', () => {
  const ws = '/work/repo';
  const listDir = tree({
    [ws]: [['a', true], ['node_modules', true], ['.git', true], ['f.txt', false]],
    [`${ws}/a`]: [['.agenfk', true], ['b', true]],
    [`${ws}/a/b`]: [['.agenfk', true]],
    [`${ws}/node_modules`]: [['pkg', true]],
    [`${ws}/node_modules/pkg`]: [['.agenfk', true]],
  });

  it('finds every .agenfk below the workspace, skipping node_modules and .git', () => {
    expect(findAgenfkDirs(ws, { listDir })).toEqual({ dirs: [`${ws}/a/.agenfk`, `${ws}/a/b/.agenfk`], complete: true });
  });

  it('reports an incomplete scan (an unreadable directory, or past the bound)', () => {
    expect(findAgenfkDirs(ws, { listDir: tree({ [ws]: [['x', true]], [`${ws}/x`]: null }) }).complete).toBe(false);
    expect(findAgenfkDirs(ws, { listDir }, 2).complete).toBe(false);
  });

  it('denies them as literal paths on every platform', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const d = deps({ listDir, platform });
      await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
      expect(specOf(d).filesystem.denyWrite).toEqual(expect.arrayContaining([`${ws}/a/.agenfk`, `${ws}/a/b/.agenfk`]));
    }
  });

  it('Linux: an incomplete scan refuses the launch (the runtime drops write globs there)', async () => {
    const d = deps({ listDir: tree({ [ws]: [['x', true]], [`${ws}/x`]: null }), platform: 'linux' });
    await expect(runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d)).rejects.toThrow(/\.agenfk/);
    expect(d.runtime.launch).not.toHaveBeenCalled();
  });

  it('macOS: an incomplete scan warns and relies on the glob deny', async () => {
    const d = deps({ listDir: tree({ [ws]: [['x', true]], [`${ws}/x`]: null }), platform: 'darwin' });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(d.runtime.launch).toHaveBeenCalled();
    expect(d.warnings.join('\n')).toMatch(/\.agenfk/);
  });
});

describe('a denied inference host (review fixes 1 and 2)', () => {
  it('refuses the launch with a clear error', async () => {
    const d = deps({ fetchPolicy: vi.fn(async () => ({ effective: { mode: 'enforce', hosts: { allow: [], deny: ['*.openai.com'] } }, source: 'hub', revision: 2, capabilities: ['sandboxed-commands'] })) });
    await expect(runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d)).rejects.toThrow(/inference host.*denied/s);
    expect(d.runtime.launch).not.toHaveBeenCalled();
  });
});

describePosix('symlinked .agenfk directories (second pass, fix 3)', () => {
  const ws = '/work/repo';
  const links: Record<string, string> = {
    [`${ws}/a/.agenfk`]: '/outside/secret-agenfk',
    [`${ws}/proj`]: '/elsewhere/proj',
    [`${ws}/loop`]: ws,
    [`${ws}/proj/loop2`]: ws,
  };
  const realpath = (p: string) => {
    for (const [link, target] of Object.entries(links)) {
      if (p === link || p.startsWith(`${link}/`)) return realpath(target + p.slice(link.length));
    }
    return p;
  };
  const listDir = tree({
    [ws]: [['a', true], ['proj', false, true], ['loop', false, true]],
    [`${ws}/a`]: [['.agenfk', false, true]],
    [`${ws}/proj`]: [['.agenfk', true], ['loop2', false, true]],
  });
  const isDirectory = () => true;

  it('denies a .agenfk symlink as the link and as its target', () => {
    const r = findAgenfkDirs(ws, { listDir, realpath, isDirectory });
    expect(r.dirs).toEqual(expect.arrayContaining([`${ws}/a/.agenfk`, '/outside/secret-agenfk']));
  });

  it('follows a directory symlink (both spellings of what it holds) and survives a cycle', () => {
    const r = findAgenfkDirs(ws, { listDir, realpath, isDirectory });
    expect(r.dirs).toEqual(expect.arrayContaining([`${ws}/proj/.agenfk`, '/elsewhere/proj/.agenfk']));
    expect(r.complete).toBe(true);
  });

  it('a link whose target cannot be resolved makes the scan incomplete (fail closed)', () => {
    const r = findAgenfkDirs(ws, { listDir: tree({ [ws]: [['dangling', false, true]] }), realpath: () => null, isDirectory });
    expect(r.complete).toBe(false);
  });

  it('the launcher denies both on Linux, and refuses Linux when a link cannot be resolved', async () => {
    const d = deps({ listDir, realpath, isDirectory, platform: 'linux' });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).filesystem.denyWrite).toEqual(expect.arrayContaining([`${ws}/a/.agenfk`, '/outside/secret-agenfk']));
    const bad = deps({ listDir: tree({ [ws]: [['dangling', false, true]] }), realpath: () => null, isDirectory, platform: 'linux' });
    await expect(runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, bad)).rejects.toThrow(/\.agenfk/);
  });
});

describe('Linux: the launcher tells the gate its own network namespace (second pass, fix 1)', () => {
  it('passes it into the sandbox, so a process still in it is never taken for confined', async () => {
    const d = deps({ platform: 'linux', hostNetns: 'net:[4026531840]' });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).env.AGENFK_AIRLOCK_HOST_NETNS).toBe('net:[4026531840]');
    const mac = deps({ platform: 'darwin', hostNetns: null });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, mac);
    expect(specOf(mac).env.AGENFK_AIRLOCK_HOST_NETNS).toBeUndefined();
  });
});

describe('PO-1: the launcher asks for its workspace\'s project', () => {
  it('the policy fetch names the project the workspace belongs to', async () => {
    const d = deps({ projectId: () => 'p-api' } as any);
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect((d.fetchPolicy as any).mock.calls[0][0]).toBe('p-api');
  });

  it('outside any project it asks for the org policy', async () => {
    const d = deps({ projectId: () => null } as any);
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect((d.fetchPolicy as any).mock.calls[0][0] ?? null).toBeNull();
  });
});

describe('PO-1 review: the launch marker is signed for the workspace\'s project', () => {
  it('the relay\'s marker carries the project the policy was fetched for', async () => {
    const { verifyAirlockSessionMarker, airlockMarkerProject } = await import('@agenfk/core');
    const d = deps({ projectId: () => 'p-api' } as any);
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    const marker = (d.startRelay as any).mock.calls[0][0].marker();
    expect(airlockMarkerProject(verifyAirlockSessionMarker('airlock-report-token-0123456789abcdef', marker)!)).toBe('p-api');
  });
});

describe('story review: the launcher records its project\'s root before its sandbox starts', () => {
  it('names the workspace\'s project and root before it asks for the policy', async () => {
    const order: string[] = [];
    const ensureProjectRoot = vi.fn(async () => { order.push('root'); });
    const d = deps({ projectId: () => 'p-api', projectRoot: () => '/work/api', ensureProjectRoot,
      fetchPolicy: vi.fn(async () => { order.push('policy'); return { effective: { mode: 'enforce', hosts: { allow: ['api.github.com'], deny: [] } }, source: 'local', revision: 3, capabilities: ['sandboxed-commands'] }; }) } as any);
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(ensureProjectRoot).toHaveBeenCalledWith('p-api', '/work/api');
    expect(order).toEqual(['root', 'policy']);
  });

  it('outside a project there is nothing to record', async () => {
    const ensureProjectRoot = vi.fn(async () => undefined);
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, deps({ projectId: () => null, projectRoot: () => null, ensureProjectRoot } as any));
    expect(ensureProjectRoot).not.toHaveBeenCalled();
  });

  it('a root it could not record is said, and the launch goes on (the server refuses what it cannot tell)', async () => {
    const d = deps({ projectId: () => 'p-api', projectRoot: () => '/work/api', ensureProjectRoot: vi.fn(async () => { throw new Error('boom'); }) } as any);
    expect(await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d)).toBe(0);
    expect(d.warnings.join('\n')).toMatch(/could not record.*boom/i);
  });
});

describe('ensureProjectRootVia', () => {
  it('sets the root only when the project has none, with the verify token', async () => {
    const { ensureProjectRootVia } = await import('../commands/airlock');
    const get = vi.fn(async () => ({ data: { id: 'p', projectRoot: null } }));
    const put = vi.fn(async () => ({ data: {} }));
    await ensureProjectRootVia('http://127.0.0.1:3000', () => 'tok', get as any, put as any)('p', '/work/api');
    expect(get).toHaveBeenCalledWith('http://127.0.0.1:3000/projects/p', expect.anything());
    expect(put).toHaveBeenCalledWith('http://127.0.0.1:3000/projects/p/project-root', { projectRoot: '/work/api' }, expect.objectContaining({ headers: { 'x-agenfk-internal': 'tok' } }));
    put.mockClear();
    get.mockResolvedValue({ data: { id: 'p', projectRoot: '/elsewhere' } } as never);
    await ensureProjectRootVia('http://127.0.0.1:3000', () => 'tok', get as any, put as any)('p', '/work/api');
    expect(put).not.toHaveBeenCalled();
  });
});

describe('story review 2: the root the launcher records is the main checkout\'s', () => {
  it('a project found in a linked worktree is recorded at the same place in the main checkout', async () => {
    const { mainCheckoutRoot } = await import('../commands/airlock');
    expect(mainCheckoutRoot('/wt/feat/packages/svc', { top: '/wt/feat', main: '/repo' })).toBe(path.join('/repo', 'packages', 'svc'));
    expect(mainCheckoutRoot('/repo/packages/svc', null)).toBe('/repo/packages/svc');
    // a project root above the worktree is not in it: left as it is
    expect(mainCheckoutRoot('/wt', { top: '/wt/feat', main: '/repo' })).toBe('/wt');
  });
});
