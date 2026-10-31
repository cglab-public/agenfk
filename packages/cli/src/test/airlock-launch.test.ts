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
import { registerAirlockCommands, clientArgsOf } from '../commands/airlock';
import type { AirlockRuntime, SandboxCommand, SandboxExit } from '../airlock/runtime';
import type { SandboxSpec } from '../airlock/spec';

// The launcher refuses Windows (SmolvmRuntime.check, tested in airlock-smolvm-runtime.test.ts), so these POSIX
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
    fetchPolicy: vi.fn(async () => ({ effective: { mode: 'enforce', hosts: { allow: ['api.github.com'], deny: [] } }, source: 'local', revision: 3, capabilities: ['sandboxed-commands', 'machine-image'] })),
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
    runtimePackageDir: '/home/u/.agenfk/smolvm/1.32.4',
    installDirs: ['/home/u/.agenfk-system'],
    log: vi.fn(),
    warn: (m: string) => { warnings.push(m); },
    onSignal: vi.fn(() => () => undefined),
    listDir: () => [],
    realpath: (p: string) => p,
    isDirectory: () => false,
    platform: 'darwin',
    ensurePrivateDir: vi.fn(),
    agenfkVersion: () => '2.1.0-test.1',
    ...over,
    warnings,
  } as LaunchDeps & { warnings: string[] };
}

const specOf = (d: LaunchDeps): SandboxSpec => (d.runtime.launch as any).mock.calls[0][0];
const cmdOf = (d: LaunchDeps): SandboxCommand => (d.runtime.launch as any).mock.calls[0][1];

describePosix('runAirlockLaunch: the machine image (CGLAB-696)', () => {
  const REPO_FILE = '/work/repo/.agenfk/airlock.json';
  const withImage = (machineImage?: string) => vi.fn(async () => ({
    effective: { mode: 'enforce', hosts: { allow: [], deny: [] }, ...(machineImage ? { machineImage } : {}) },
    source: 'hub', revision: 3, capabilities: ['sandboxed-commands', 'machine-image'],
  }));

  it('runs the AgEnFK base image of this version when nothing names another, and says so', async () => {
    const d = deps({ fetchPolicy: withImage() });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).machineImage).toBe('ghcr.io/cglab-public/agenfk-airlock-base:2.1.0-test.1');
    expect((d.log as any).mock.calls.flat().join('\n')).toMatch(/image ghcr\.io\/cglab-public\/agenfk-airlock-base:2\.1\.0-test\.1 \(AgEnFK base\)/);
  });

  it('never runs an image the repository names: .agenfk/airlock.json is not read (the image is root in the machine)', async () => {
    const d = deps({ fetchPolicy: withImage(), projectRoot: () => '/work/repo' }, { [REPO_FILE]: { image: 'ghcr.io/acme/app-airlock:3' } });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).machineImage).toBe('ghcr.io/cglab-public/agenfk-airlock-base:2.1.0-test.1');
  });

  it('runs the policy\'s image', async () => {
    const d = deps({ fetchPolicy: withImage('ghcr.io/acme/org-airlock:1') });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).machineImage).toBe('ghcr.io/acme/org-airlock:1');
    expect((d.log as any).mock.calls.flat().join('\n')).toMatch(/image ghcr\.io\/acme\/org-airlock:1 \(the policy's\)/);
  });

  it('refuses an enforce launch through a server that drops the policy\'s machine image (review 8)', async () => {
    const d = deps({ fetchPolicy: vi.fn(async () => ({ effective: { mode: 'enforce', hosts: { allow: [], deny: [] } }, source: 'hub', revision: 3, capabilities: ['sandboxed-commands'] })) });
    await expect(runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d)).rejects.toThrow(/machine image[\s\S]*agenfk restart/);
    expect(d.runtime.launch).not.toHaveBeenCalled();
  });

  it('observes through such a server, and says the policy\'s image may not be the one running', async () => {
    const d = deps({ fetchPolicy: vi.fn(async () => ({ effective: { mode: 'observe', hosts: { allow: [], deny: [] } }, source: 'hub', revision: 3, capabilities: ['sandboxed-commands'] })) });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(d.runtime.launch).toHaveBeenCalled();
    expect(d.warnings.join('\n')).toMatch(/machine image/);
  });

});

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
      '/home/u/.agenfk', '/home/u/.agenfk-system', '/home/u/.agenfk/smolvm/1.32.4',
    ]));
    // By name: the guest's own pi (review 01a18d3a) - a host path names nothing in the machine.
    expect(cmdOf(d)).toEqual({ file: 'pi', args: ['--model', 'openai/gpt-5', '-p', 'hi'], cwd: CWD });
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
    // ...and reaches the session as the warning says (story review 3): by name, never by value in the spec
    expect(spec.plainEnv).toEqual(['LOCAL_KEY']);
    expect(JSON.stringify(spec)).not.toContain('"k"');
  });

  it('a TLS endpoint\'s key is masked and not passed through as well', async () => {
    const d = deps({ env: { SPARK_KEY: 's' } }, {
      [path.join(HOME, '.pi/agent/models.json')]: { providers: { spark: { baseUrl: 'https://spark.example.com/v1', apiKey: 'SPARK_KEY' } } },
    });
    await runAirlockLaunch('pi', ['--provider', 'spark', '--model', 'm'], { keyEnv: [] }, d);
    expect(specOf(d).plainEnv ?? []).toEqual([]);
  });

  it('--key-env masks a variable the caller names, and refuses one that is not set', async () => {
    const d = deps({ env: { OPENAI_API_KEY: 'a', MY_KEY: 'b' } });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: ['MY_KEY'] }, d);
    expect(specOf(d).maskedEnv.map((m) => m.name).sort()).toEqual(['MY_KEY', 'OPENAI_API_KEY']);
    await expect(runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: ['NOPE'] }, deps()))
      .rejects.toThrow(/NOPE.*not set/);
  });

  it('a pi agent dir the user set (PI_CODING_AGENT_DIR) is the one read, writable - and its auth.json is denied', async () => {
    const custom = '/home/u/pi-alt';
    const d = deps({ env: { PI_CODING_AGENT_DIR: custom } }, {
      [path.join(custom, 'settings.json')]: { defaultProvider: 'spark', defaultModel: 'GLM' },
      [path.join(custom, 'models.json')]: { providers: { spark: { baseUrl: 'https://spark.example.com/v1', apiKey: 'literal-key' } } },
    });
    await runAirlockLaunch('pi', [], { keyEnv: [] }, d);
    const spec = specOf(d);
    expect(spec.network.allow).toContain('spark.example.com');
    expect(spec.filesystem.denyRead).toEqual(expect.arrayContaining([path.join(custom, 'auth.json'), '/home/u/.pi/agent/auth.json']));
    expect(spec.filesystem.allowWrite).toContain(custom);
    expect(spec.filesystem.denyWrite).toContain(path.join(custom, 'extensions'));
    // The machine does not see the host's env: pi is told the dir, by its resolved path.
    expect(spec.env.PI_CODING_AGENT_DIR).toBe(custom);
  });

  // Review C5: pi expands ~ and accepts a file:// URL there; so does the launcher.
  it('a PI_CODING_AGENT_DIR spelled with ~ or as a file:// URL is the dir pi reads', async () => {
    for (const spelled of ['~/pi-alt', 'file:///home/u/pi-alt']) {
      const d = deps({ env: { OPENAI_API_KEY: 'k', PI_CODING_AGENT_DIR: spelled } });
      await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
      expect(specOf(d).filesystem.allowWrite, spelled).toContain('/home/u/pi-alt');
      expect(specOf(d).env.PI_CODING_AGENT_DIR, spelled).toBe('/home/u/pi-alt');
    }
  });

  // BUG 38d7231e (user decision 2026-10-28): pi packages that hardcode /tmp (pi-patty-bg-tasks
  // logs to /tmp/pi-bg) failed with EPERM on macOS, where only os.tmpdir() was writable.
  it('the shared /tmp is writable, by its real path', async () => {
    const d = deps({ realpath: (p: string) => (p === '/tmp' ? '/private/tmp' : p) });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).filesystem.allowWrite).toEqual(expect.arrayContaining(['/tmp/t', '/private/tmp']));
  });

  it('says pi auth.json is not readable inside when no key variable is masked', async () => {
    const d = deps({ env: {} });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(d.warnings.join('\n')).toMatch(/auth\.json/);
  });

  it.each(['home-read-only', 'home-read-write'])('does not warn about auth.json when the policy opens the home folder (%s), and the spec mounts it', async (homeAccess) => {
    const d = deps({
      env: {},
      fetchPolicy: vi.fn(async () => ({ effective: { mode: 'enforce', hosts: { allow: [], deny: [] }, homeAccess }, source: 'hub', revision: 3, capabilities: ['sandboxed-commands', 'machine-image'] })) as any,
    });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(d.warnings.join('\n')).not.toMatch(/auth\.json/);
    expect(specOf(d).filesystem.homeMount).toBe(homeAccess === 'home-read-only' ? 'ro' : 'rw');
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
        source: 'hub', revision: 9, hubManaged: true, capabilities: ['sandboxed-commands', 'machine-image'],
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

  it('runs the client the machine\'s image has: the host needs no install of its own (review 01a18d3a)', async () => {
    const d = deps();
    await runAirlockLaunch('opencode', ['-m', 'openai/x'], { keyEnv: [] }, d);
    expect(cmdOf(d).file).toBe('opencode');
  });

  it('refuses when it cannot tell which host serves the model', async () => {
    const d = deps();
    await expect(runAirlockLaunch('pi', ['--model', 'mystery/x'], { keyEnv: [] }, d)).rejects.toThrow(/inference host.*mystery/s);
  });

  it('refuses when the sandbox runtime sits where the sandboxed agent could rewrite it', async () => {
    const d = deps({ runtimePackageDir: '/work/repo/.tools/smolvm' });
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

  it('opencode is not given a pi agent dir', async () => {
    const d = deps({ env: { ANTHROPIC_API_KEY: 'x' } });
    await runAirlockLaunch('opencode', ['-m', 'anthropic/claude-x'], { keyEnv: [] }, d);
    expect(specOf(d).env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(specOf(d).filesystem.allowWrite).not.toContain('/home/u/.pi/agent');
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
  it('takes --key-env before the client name and hands the client its arguments', async () => {
    const launch = vi.fn(async () => 5);
    const exit = vi.fn();
    const program = new Command();
    registerAirlockCommands(program, { launch, exit });
    await program.parseAsync(['node', 'agenfk', 'airlock', '--key-env', 'K', '--key-env', 'L', 'pi', '--model', 'openai/x', '-p', 'hi there']);
    expect(launch).toHaveBeenCalledWith('pi', ['--model', 'openai/x', '-p', 'hi there'], { keyEnv: ['K', 'L'] });
    expect(exit).toHaveBeenCalledWith(5);
  });

  it.each(['pi', 'opencode'] as const)('hands every argument after "%s" to it verbatim: --help, --key-env and -- included', async (client) => {
    const launch = vi.fn(async () => 0);
    const exit = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerAirlockCommands(program, { launch, exit });
    const args = ['--help', '-h', '--key-env', 'K', '--', '--model', 'x', '--', '-p', 'a -- b'];
    await program.parseAsync(['node', 'agenfk', 'airlock', client, ...args]);
    expect(launch).toHaveBeenCalledWith(client, args, { keyEnv: [] });
  });

  // Codex review 01a193dc-3bc3: with agenfk's own root options registered, as the real CLI has them.
  it.each([['--key-env'], ['-V'], ['--toon'], ['--help'], ['-h'], ['--'], ['--version']])('hands a lone %s after the client\'s name to the client', async (arg) => {
    const launch = vi.fn(async () => 0);
    const exit = vi.fn();
    const program = new Command();
    program.exitOverride().version('9.9.9', '-V').option('--toon').configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerAirlockCommands(program, { launch, exit });
    await program.parseAsync(['node', 'agenfk', 'airlock', '--key-env', 'K', 'pi', arg]);
    expect(launch).toHaveBeenCalledWith('pi', [arg], { keyEnv: ['K'] });
  });

  it('hands the client its arguments when agenfk\'s own flags come before airlock (review 01a193dc-3bc3, second pass)', async () => {
    const launch = vi.fn(async () => 0);
    const program = new Command();
    program.exitOverride().version('9.9.9', '-V').option('--toon').configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerAirlockCommands(program, { launch, exit: vi.fn() });
    await program.parseAsync(['node', 'agenfk', '--toon', 'airlock', '--key-env', 'K', 'pi', '-V', '--key-env']);
    expect(launch).toHaveBeenCalledWith('pi', ['-V', '--key-env'], { keyEnv: ['K'] });
    expect(program.opts().toon).toBe(true);
  });

  it('leaves every other agenfk command to commander: root options still work after them', async () => {
    const launch = vi.fn(async () => 0);
    const program = new Command();
    let toon: unknown;
    program.option('--toon');
    program.command('list').action(() => { toon = program.opts().toon; });
    registerAirlockCommands(program, { launch, exit: vi.fn() });
    await program.parseAsync(['node', 'agenfk', 'list', '--toon']);
    expect(toon).toBe(true);
    expect(launch).not.toHaveBeenCalled();
  });

  it('reads --key-env=NAME too, and refuses an unknown launcher option before the client\'s name', () => {
    expect(clientArgsOf(['node', 'agenfk', 'airlock', '--key-env=K', 'opencode', '-m', 'x'], 'opencode')).toEqual({ keyEnv: ['K'], args: ['-m', 'x'] });
    expect(() => clientArgsOf(['node', 'agenfk', 'airlock', '--model', 'x', 'pi'], 'pi')).toThrow(/--model: not an option of agenfk airlock pi/);
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
    const d = deps({ fetchPolicy: vi.fn(async () => ({ effective: { mode: 'enforce', hosts: { allow: [], deny: ['*.openai.com'] } }, source: 'hub', revision: 2, capabilities: ['sandboxed-commands', 'machine-image'] })) });
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
      fetchPolicy: vi.fn(async () => { order.push('policy'); return { effective: { mode: 'enforce', hosts: { allow: ['api.github.com'], deny: [] } }, source: 'local', revision: 3, capabilities: ['sandboxed-commands', 'machine-image'] }; }) } as any);
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

/** CGLAB-696 task 6: a launch installs the smolvm it runs on first, when it is missing. */
describePosix('runAirlockLaunch: the runtime installed first (CGLAB-696 task 6)', () => {
  it('ensures the runtime before checking it', async () => {
    const order: string[] = [];
    const { runtime } = fakeRuntime();
    runtime.check.mockImplementation(async () => { order.push('check'); return { ok: true, warnings: [] }; });
    const d = deps({ runtime, ensureRuntime: vi.fn(async () => { order.push('ensure'); }) });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(order).toEqual(['ensure', 'check']);
  });

  it('a runtime it cannot install: nothing is launched, and the reason is said', async () => {
    const d = deps({ ensureRuntime: vi.fn(async () => { throw new Error('the download\'s sha256 is wrong'); }) });
    await expect(runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d)).rejects.toThrow(/sha256 is wrong/);
    expect(d.runtime.launch).not.toHaveBeenCalled();
  });
});

/** CGLAB-696 task 7: the machine is the repository's - a launch from a subdirectory uses the repository top. */
describePosix('runAirlockLaunch: launched from a subdirectory (CGLAB-696 task 7)', () => {
  it('uses the repository top as the workspace, and runs the client in the subdirectory', async () => {
    const d = deps({ cwd: '/work/repo/packages/a', isDirectory: (p: string) => p === '/work/repo/.git' }, { '/work/repo/.git': {}, '/work/repo/.git/HEAD': {}, '/work/repo/.git/objects': {}, '/work/repo/.git/refs': {} });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).workspace).toBe('/work/repo');
    expect(specOf(d).filesystem.allowWrite).toContain('/work/repo');
    expect(cmdOf(d).cwd).toBe('/work/repo/packages/a');
  });

  it('a linked worktree\'s top is its own folder (its .git is a file)', async () => {
    const d = deps({ cwd: '/work/wt/src' }, { '/work/wt/.git': 'gitdir: /work/repo/.git/worktrees/wt' });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).workspace).toBe('/work/wt');
  });

  it('an empty .git above is no repository: the workspace is not widened to it (review 01a18d52)', async () => {
    const d = deps({ cwd: '/work/notes', isDirectory: (p: string) => p === '/work/.git' }, { '/work/.git': {} });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).workspace).toBe('/work/notes');
  });

  it('a .git above with only a HEAD is no repository either (review 01a18d52, pass 2)', async () => {
    const d = deps({ cwd: '/work/notes', isDirectory: (p: string) => p === '/work/.git' }, { '/work/.git': {}, '/work/.git/HEAD': {} });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).workspace).toBe('/work/notes');
  });

  it('outside a repository the folder it is launched from is the workspace', async () => {
    const d = deps({ cwd: '/work/notes' });
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).workspace).toBe('/work/notes');
  });
});

/** CGLAB-696 story review: pi runs on its own agent dir in the machine; no staged copy (each launch's would keep sessions from sharing it). */
describePosix('runAirlockLaunch: pi\'s agent dir in the machine (CGLAB-696 story review)', () => {
  it('is pi\'s own: nothing is staged, PI_CODING_AGENT_DIR is not repointed', async () => {
    const d = deps();
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(specOf(d).filesystem.allowWrite.some((p) => p.includes('agenfk-airlock-pi'))).toBe(false);
    expect(specOf(d).env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(specOf(d).filesystem.allowWrite).toContain('/home/u/.pi/agent');
  });
});

/** Story review 2 (LIFE-2): the policy is followed while the session runs, not only read at launch. */
describe('runAirlockLaunch: a policy changed while the session runs (story review 2)', () => {
  const view = (hosts: { allow: string[]; deny: string[] }, mode = 'enforce', revision = 3) =>
    ({ effective: { mode, hosts }, source: 'local', revision, capabilities: ['sandboxed-commands', 'machine-image'] });
  /** A runtime whose session runs until told to end, and that can take a new network. */
  /** The machine's update as the runtime does it: the fetch (`next`) inside it, its spec applied. */
  const machineUpdate = (applied: SandboxSpec[]) => vi.fn(async (_workspace: string, next: () => Promise<SandboxSpec | null>) => {
    const spec = await next();
    if (spec) applied.push(spec);
    return spec ? 'applied' : 'unchanged';
  });
  function liveRuntime() {
    let end: (e: SandboxExit) => void = () => undefined;
    const launched = { pid: 99, kill: vi.fn((_s: NodeJS.Signals) => { end({ code: null, signal: 'SIGTERM' }); return true; }), exited: new Promise<SandboxExit>((r) => { end = r; }) };
    const applied: SandboxSpec[] = [];
    const runtime = {
      id: 'fake', check: vi.fn(async () => ({ ok: true, warnings: [] })),
      launch: vi.fn(async () => launched), dispose: vi.fn(async () => undefined),
      updateNetwork: machineUpdate(applied),
    };
    return { runtime, launched, applied, end: (e: SandboxExit) => end(e) };
  }

  it('fetches the policy inside the machine\'s update, which applies what it fetched (fourth pass)', async () => {
    const live = liveRuntime();
    let inside = false;
    const views = [view({ allow: ['api.github.com'], deny: [] }), view({ allow: ['api.github.com'], deny: ['evil.example'] }, 'enforce', 5)];
    let n = 0;
    const fetchedInside: boolean[] = [];
    const update = live.runtime.updateNetwork.getMockImplementation()!;
    live.runtime.updateNetwork.mockImplementation(async (w: string, next: () => Promise<SandboxSpec | null>) => { inside = true; try { return await update(w, next); } finally { inside = false; } });
    const d = deps({ runtime: live.runtime as any, policyPollMs: 10, fetchPolicy: vi.fn(async () => { if (n > 0) fetchedInside.push(inside); return views[Math.min(n++, views.length - 1)]; }) } as any);
    const done = runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    await vi.waitFor(() => expect(live.applied.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(live.applied.at(-1)!.network.deny).toContain('evil.example');
    expect(live.runtime.updateNetwork.mock.calls.at(-1)![0]).toBe(path.resolve(CWD));
    expect(fetchedInside.length).toBeGreaterThan(0);
    expect(fetchedInside.every(Boolean)).toBe(true);
    live.end({ code: 0, signal: null });
    await done;
    const calls = (d.fetchPolicy as any).mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect((d.fetchPolicy as any).mock.calls.length).toBe(calls);
  });

  it('ends the session when the policy comes to deny its inference host: the machine is held to it first, and a session that ignores SIGTERM is killed', async () => {
    let end: (e: SandboxExit) => void = () => undefined;
    const signals: string[] = [];
    const launched = { pid: 99, exited: new Promise<SandboxExit>((r) => { end = r; }), kill: vi.fn((s: NodeJS.Signals) => { signals.push(s); if (s === 'SIGKILL') end({ code: null, signal: 'SIGKILL' }); return true; }) };
    const applied: SandboxSpec[] = [];
    const runtime = { id: 'fake', check: vi.fn(async () => ({ ok: true, warnings: [] })), launch: vi.fn(async () => launched), dispose: vi.fn(async () => undefined), updateNetwork: machineUpdate(applied) };
    let n = 0;
    const d = deps({ runtime: runtime as any, policyPollMs: 10, killGraceMs: 50, fetchPolicy: vi.fn(async () => (n++ === 0 ? view({ allow: ['api.github.com'], deny: [] }) : view({ allow: ['api.github.com'], deny: ['api.openai.com'] }, 'enforce', 4))) } as any);
    const code = await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(applied[0].network.deny).toContain('api.openai.com');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(code).not.toBe(0);
    expect(d.warnings.join('\n')).toMatch(/api\.openai\.com/);
  });

  // Codex reviews 01a193dc-3bc3 / -38d2: mounts cannot be taken back from a running session.
  it.each([
    ['home-read-write', undefined], ['home-read-write', 'home-read-only'], ['home-read-only', undefined],
  ])('ends the session when the home access narrows from %s to %s', async (from, to) => {
    const live = liveRuntime();
    const at = (homeAccess: string | undefined, revision: number) => ({ ...view({ allow: [], deny: [] }, 'enforce', revision), effective: { mode: 'enforce', hosts: { allow: [], deny: [] }, ...(homeAccess ? { homeAccess } : {}) } });
    let n = 0;
    const d = deps({ runtime: live.runtime as any, policyPollMs: 10, killGraceMs: 50, fetchPolicy: vi.fn(async () => (n++ === 0 ? at(from, 3) : at(to, 4))) } as any);
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(live.launched.kill).toHaveBeenCalledWith('SIGTERM');
    expect(d.warnings.join('\n')).toMatch(/home access/);
  });

  it('keeps the session when the home access widens: it takes effect from the next launch', async () => {
    const live = liveRuntime();
    const at = (homeAccess: string | undefined, revision: number) => ({ ...view({ allow: [], deny: [] }, 'enforce', revision), effective: { mode: 'enforce', hosts: { allow: [], deny: [] }, ...(homeAccess ? { homeAccess } : {}) } });
    let n = 0;
    const d = deps({ runtime: live.runtime as any, policyPollMs: 10, fetchPolicy: vi.fn(async () => (n++ === 0 ? at(undefined, 3) : at('home-read-write', 4))) } as any);
    const done = runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    await vi.waitFor(() => expect((d.fetchPolicy as any).mock.calls.length).toBeGreaterThan(3), { timeout: 2000 });
    expect(live.launched.kill).not.toHaveBeenCalled();
    live.end({ code: 0, signal: null });
    await done;
  });

  it('ends the session when its machine cannot follow the policy (started by an older AgEnFK)', async () => {
    const live = liveRuntime();
    live.runtime.updateNetwork.mockImplementation(async () => { throw Object.assign(new Error('the machine was started by an older AgEnFK'), { cannotFollow: true }); });
    let n = 0;
    const d = deps({ runtime: live.runtime as any, policyPollMs: 10, killGraceMs: 50, fetchPolicy: vi.fn(async () => (n++ === 0 ? view({ allow: ['api.github.com'], deny: [] }) : view({ allow: ['api.github.com'], deny: ['evil.example'] }, 'enforce', 4))) } as any);
    await runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    expect(live.launched.kill).toHaveBeenCalled();
    expect(d.warnings.join('\n')).toMatch(/older AgEnFK/);
  });

  it('keeps the session as it is when the server cannot be asked, or turns the policy off', async () => {
    const live = liveRuntime();
    let n = 0;
    const d = deps({ runtime: live.runtime as any, policyPollMs: 10, fetchPolicy: vi.fn(async () => {
      n++;
      if (n === 1) return view({ allow: ['api.github.com'], deny: [] });
      if (n % 2 === 0) throw new Error('ECONNREFUSED');
      return view({ allow: [], deny: [] }, 'off', 9);
    }) } as any);
    const done = runAirlockLaunch('pi', ['--model', 'openai/x'], { keyEnv: [] }, d);
    await vi.waitFor(() => expect(n).toBeGreaterThan(4), { timeout: 2000 });
    expect(live.applied).toEqual([]);
    expect(live.launched.kill).not.toHaveBeenCalled();
    live.end({ code: 0, signal: null });
    await done;
  });
});
