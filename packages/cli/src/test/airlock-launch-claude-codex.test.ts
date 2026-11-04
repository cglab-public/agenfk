/**
 * GH-356: `agenfk airlock claude|codex` launch Claude Code and Codex in the Airlock machine. There
 * is no launch gate for them (a session outside Airlock is untouched). Logins are host-held by
 * default - the guest gets a stand-in the host swaps for the real token, from a TokenSource - or,
 * opted into with --login mount, the machine's own copy of the login file. Tested with a fake
 * runtime, as airlock-launch.test.ts is: nothing is sandboxed and no model session starts.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { Command } from 'commander';
import { runAirlockLaunch, type LaunchDeps } from '../airlock/launch';
import { registerAirlockCommands, clientArgsOf } from '../commands/airlock';
import type { SandboxCommand } from '../airlock/runtime';
import type { SandboxSpec } from '../airlock/spec';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const HOME = '/home/u';
const CWD = '/work/repo';
const HOOK = `node "${HOME}/.agenfk/bin/agenfk-airlock-hook.mjs"`;

/** A token source that has the person connected, or answers with the typed error it is given. */
function tokenSource(err?: { code: 'not_connected' | 'at_limit' | 'revoked'; resetAt?: number }) {
  return {
    get: vi.fn(async () => {
      if (err) throw Object.assign(new Error(err.code), err);
      return { accessToken: 'real-token-not-in-guest', expiresAt: Date.now() + 3_600_000 };
    }),
    invalidate: vi.fn(async () => undefined),
  };
}

function deps(over: Partial<LaunchDeps> = {}, files: Record<string, unknown> = {}): LaunchDeps & { warnings: string[] } {
  const warnings: string[] = [];
  const launched = { pid: 99, kill: vi.fn(() => true), exited: Promise.resolve({ code: 0, signal: null }) };
  return {
    fetchPolicy: vi.fn(async () => ({ effective: { mode: 'enforce', hosts: { allow: ['api.github.com'], deny: [] } }, source: 'local', revision: 3, capabilities: ['sandboxed-commands', 'machine-image'] })),
    runtime: {
      id: 'fake',
      check: vi.fn(async () => ({ ok: true as const, warnings: [] })),
      launch: vi.fn(async (_spec: SandboxSpec, _cmd: SandboxCommand) => launched),
      dispose: vi.fn(async () => undefined),
    },
    reportToken: () => 'airlock-report-token-0123456789abcdef',
    startRelay: vi.fn(async () => ({ host: '127.0.0.1', port: 47001, close: vi.fn(async () => undefined) })),
    env: {},
    home: HOME,
    cwd: CWD,
    tmpDir: '/tmp/t',
    apiUrl: 'http://localhost:3123',
    readJson: (p: string) => (p in files && typeof files[p] !== 'string' ? files[p] : null),
    readText: (p: string) => (typeof files[p] === 'string' ? files[p] as string : null),
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
    tokenSource: tokenSource(),
    ...over,
    warnings,
  } as LaunchDeps & { warnings: string[] };
}

const specOf = (d: LaunchDeps): SandboxSpec => (d.runtime.launch as any).mock.calls[0][0];
const cmdOf = (d: LaunchDeps): SandboxCommand => (d.runtime.launch as any).mock.calls[0][1];
const settingsOf = (c: SandboxCommand) => JSON.parse(c.args[c.args.indexOf('--settings') + 1]);

describePosix('agenfk airlock claude (GH-356)', () => {
  it('launches the image\'s claude with the per-call hook, its marker, its state and its model, the user\'s arguments after ours', async () => {
    const d = deps();
    expect(await runAirlockLaunch('claude', ['--model', 'claude-opus-5-5', '-p', 'hi'], { keyEnv: [] }, d)).toBe(0);
    const cmd = cmdOf(d);
    expect(cmd.file).toBe('claude');
    expect(cmd.args.slice(0, 2)[0]).toBe('--settings');
    expect(cmd.args.slice(2)).toEqual(['--model', 'claude-opus-5-5', '-p', 'hi']);
    expect(settingsOf(cmd).hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: HOOK }] }]);
    const spec = specOf(d);
    expect(spec.env).toMatchObject({ AGENFK_AIRLOCK_SANDBOX: 'claude', AGENFK_AIRLOCK_MODEL: 'anthropic/claude-opus-5-5', CLAUDE_CONFIG_DIR: '/home/u/.claude' });
    expect(spec.filesystem.allowWrite).toContain('/home/u/.claude');
    expect(spec.network.allow).toEqual(expect.arrayContaining(['api.anthropic.com', 'api.github.com']));
  });

  it('tells the machine the folder claude starts in, so its project config there is held too (review)', async () => {
    const d = deps({ cwd: '/work/repo/packages/app' });
    await runAirlockLaunch('claude', [], { keyEnv: [] }, d);
    expect(specOf(d).launchDir).toBe('/work/repo/packages/app');
  });

  it('takes the model from ANTHROPIC_MODEL, then settings.json, and launches without one (Claude\'s own default)', async () => {
    const fromEnv = deps({ env: { ANTHROPIC_MODEL: 'claude-sonnet-5-5' } }, { [path.join(HOME, '.claude/settings.json')]: { model: 'opus' } });
    await runAirlockLaunch('claude', [], { keyEnv: [] }, fromEnv);
    expect(specOf(fromEnv).env.AGENFK_AIRLOCK_MODEL).toBe('anthropic/claude-sonnet-5-5');
    const fromSettings = deps({}, { [path.join(HOME, '.claude/settings.json')]: { model: 'opus' } });
    await runAirlockLaunch('claude', [], { keyEnv: [] }, fromSettings);
    expect(specOf(fromSettings).env.AGENFK_AIRLOCK_MODEL).toBe('anthropic/opus');
    const none = deps();
    await runAirlockLaunch('claude', [], { keyEnv: [] }, none);
    expect(specOf(none).env.AGENFK_AIRLOCK_MODEL).toBe('anthropic/');
  });

  describe('host-held login (the default)', () => {
    it('asks the token source for the person\'s login before launching; the guest gets a stand-in the host swaps on the way to api.anthropic.com', async () => {
      const d = deps();
      await runAirlockLaunch('claude', [], { keyEnv: [] }, d);
      expect(d.tokenSource!.get).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }));
      const spec = specOf(d);
      expect(spec.tokenEnv).toEqual([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', provider: 'anthropic', subject: 'local', injectHosts: ['api.anthropic.com'] }]);
      expect(spec.filesystem.machineOwn).toEqual([{ path: '/home/u/.claude/.credentials.json', seed: false }]);
      // The real token is never in what the runtime is handed for the guest.
      expect(JSON.stringify(spec)).not.toContain('real-token-not-in-guest');
      expect(JSON.stringify(cmdOf(d))).not.toContain('real-token-not-in-guest');
    });

    it('a person not connected is refused before anything runs, saying how to connect', async () => {
      const d = deps({ tokenSource: tokenSource({ code: 'not_connected' }) });
      await expect(runAirlockLaunch('claude', [], { keyEnv: [] }, d)).rejects.toThrow(/not connected[\s\S]*claude[\s\S]*(login|--login mount)/i);
      expect(d.runtime.launch).not.toHaveBeenCalled();
    });

    it('an account at its limit is refused with when it resets', async () => {
      const resetAt = Date.UTC(2026, 10, 4, 18, 0, 0);
      const d = deps({ tokenSource: tokenSource({ code: 'at_limit', resetAt }) });
      await expect(runAirlockLaunch('claude', [], { keyEnv: [] }, d)).rejects.toThrow(/limit[\s\S]*2026-11-04T18:00:00/);
      expect(d.runtime.launch).not.toHaveBeenCalled();
    });

    it('an API key in the environment is masked as a key, as for the other clients, and no login is asked for', async () => {
      const d = deps({ env: { ANTHROPIC_API_KEY: 'sk-ant-real' } });
      await runAirlockLaunch('claude', [], { keyEnv: [] }, d);
      expect(d.tokenSource!.get).not.toHaveBeenCalled();
      const spec = specOf(d);
      expect(spec.maskedEnv).toEqual([{ name: 'ANTHROPIC_API_KEY', injectHosts: ['api.anthropic.com'] }]);
      expect(spec.tokenEnv ?? []).toEqual([]);
    });

    it('a setup-token in CLAUDE_CODE_OAUTH_TOKEN is masked as it is: the host already holds it', async () => {
      const d = deps({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-real' } });
      await runAirlockLaunch('claude', [], { keyEnv: [] }, d);
      expect(d.tokenSource!.get).not.toHaveBeenCalled();
      expect(specOf(d).maskedEnv).toEqual([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', injectHosts: ['api.anthropic.com'] }]);
    });
  });

  describe('--login mount', () => {
    it('gives the machine its own copy of the login file and allows the login hosts; no token source is asked', async () => {
      const d = deps();
      await runAirlockLaunch('claude', [], { keyEnv: [], login: 'mount' }, d);
      expect(d.tokenSource!.get).not.toHaveBeenCalled();
      // And it needs none.
      const without = deps({ tokenSource: undefined });
      await runAirlockLaunch('claude', [], { keyEnv: [], login: 'mount' }, without);
      expect(without.runtime.launch).toHaveBeenCalled();
      // A key given alongside is injected toward the inference host only, never a login host.
      const keyed = deps({ env: { ANTHROPIC_API_KEY: 'sk-ant-real' } });
      await runAirlockLaunch('claude', [], { keyEnv: [], login: 'mount' }, keyed);
      expect(specOf(keyed).maskedEnv).toEqual([{ name: 'ANTHROPIC_API_KEY', injectHosts: ['api.anthropic.com'] }]);
      const spec = specOf(d);
      expect(spec.filesystem.machineOwn).toEqual([{ path: '/home/u/.claude/.credentials.json', seed: true }]);
      expect(spec.network.allow).toEqual(expect.arrayContaining(['claude.ai', 'console.anthropic.com', 'platform.claude.com']));
      // No key is ever injected toward a login host.
      for (const m of spec.maskedEnv) expect(m.injectHosts).toEqual(['api.anthropic.com']);
    });

    it('with no login file on the host (a Mac keeps it in the Keychain), says to log in once inside with /login', async () => {
      const d = deps();
      await runAirlockLaunch('claude', [], { keyEnv: [], login: 'mount' }, d);
      expect(d.warnings.join('\n')).toMatch(/\/login/);
    });
  });

  it('ANTHROPIC_BASE_URL is the inference host: keys go there, not to api.anthropic.com, and the guest\'s claude is told it', async () => {
    const d = deps({ env: { ANTHROPIC_BASE_URL: 'https://gw.example.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'gw-real', ANTHROPIC_MODEL: 'claude-x' } });
    await runAirlockLaunch('claude', [], { keyEnv: [] }, d);
    const spec = specOf(d);
    expect(spec.network.allow).toContain('gw.example.com');
    expect(spec.network.allow).not.toContain('api.anthropic.com');
    expect(spec.maskedEnv).toEqual([{ name: 'ANTHROPIC_AUTH_TOKEN', injectHosts: ['gw.example.com'] }]);
    // Review: without these the guest's claude would go to its default endpoint, with another model.
    expect(spec.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gw.example.com/anthropic', ANTHROPIC_MODEL: 'claude-x' });
    expect(JSON.stringify(spec.env)).not.toContain('gw-real');
  });

  it('a host-held login goes through ANTHROPIC_BASE_URL too, over https only: plain http is refused', async () => {
    const tls = deps({ env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' } });
    await runAirlockLaunch('claude', [], { keyEnv: [] }, tls);
    expect(specOf(tls).tokenEnv).toEqual([expect.objectContaining({ name: 'CLAUDE_CODE_OAUTH_TOKEN', injectHosts: ['gw.example.com'] })]);
    const plain = deps({ env: { ANTHROPIC_BASE_URL: 'http://gw.example.com' } });
    await expect(runAirlockLaunch('claude', [], { keyEnv: [] }, plain)).rejects.toThrow(/plain http[\s\S]*over TLS only/);
    expect(plain.runtime.launch).not.toHaveBeenCalled();
  });

  it('records whose login a stand-in is for, so two people never share a machine\'s token route', async () => {
    const d = deps({ env: { AGENFK_AIRLOCK_SUBJECT: 'dana@acme.test' } });
    await runAirlockLaunch('claude', [], { keyEnv: [] }, d);
    expect(specOf(d).tokenEnv).toEqual([expect.objectContaining({ subject: 'dana@acme.test' })]);
    expect(d.tokenSource!.get).toHaveBeenCalledWith(expect.objectContaining({ subject: 'dana@acme.test' }));
  });

  it.each([['CLAUDE_CODE_USE_BEDROCK'], ['CLAUDE_CODE_USE_VERTEX']])('%s is refused: its cloud credentials cannot be held by the host', async (v) => {
    const d = deps({ env: { [v]: '1' } });
    await expect(runAirlockLaunch('claude', [], { keyEnv: [] }, d)).rejects.toThrow(new RegExp(v));
    expect(d.runtime.launch).not.toHaveBeenCalled();
  });
});

describePosix('agenfk airlock codex (GH-356)', () => {
  const CONFIG = path.join(HOME, '.codex/config.toml');
  const AUTH = path.join(HOME, '.codex/auth.json');

  it('launches the image\'s codex with its arguments after ours, its marker and its model from -m', async () => {
    const d = deps({ env: { OPENAI_API_KEY: 'sk-real' } });
    await runAirlockLaunch('codex', ['-m', 'gpt-6', 'exec', 'hi'], { keyEnv: [] }, d);
    // Decision 2026-11-04: codex skips an untrusted hook silently; in the machine hooks.json is
    // read-only, so the Airlock hook runs without the trust step.
    expect(cmdOf(d)).toEqual({ file: 'codex', args: ['--dangerously-bypass-hook-trust', '-m', 'gpt-6', 'exec', 'hi'], cwd: CWD });
    const spec = specOf(d);
    expect(spec.env).toMatchObject({ AGENFK_AIRLOCK_SANDBOX: 'codex', AGENFK_AIRLOCK_MODEL: 'openai/gpt-6' });
    expect(spec.network.allow).toContain('api.openai.com');
    expect(spec.maskedEnv).toEqual([{ name: 'OPENAI_API_KEY', injectHosts: ['api.openai.com'] }]);
    expect(spec.filesystem.allowWrite).toContain('/home/u/.codex');
  });

  it('masks CODEX_API_KEY too', async () => {
    const d = deps({ env: { CODEX_API_KEY: 'sk-real' } });
    await runAirlockLaunch('codex', [], { keyEnv: [] }, d);
    expect(specOf(d).maskedEnv).toEqual([{ name: 'CODEX_API_KEY', injectHosts: ['api.openai.com'] }]);
  });

  it('reads the model and a custom provider from config.toml: its base_url is the inference host, its env_key the masked key', async () => {
    const d = deps({ env: { SPARK_KEY: 'real' } }, {
      [CONFIG]: [
        'model = "glm-5.3"',
        'model_provider = "spark"',
        '',
        '[model_providers.spark]',
        'name = "Spark"',
        'base_url = "https://spark.example.com/v1"',
        'env_key = "SPARK_KEY"',
      ].join('\n'),
    });
    await runAirlockLaunch('codex', [], { keyEnv: [] }, d);
    const spec = specOf(d);
    expect(spec.env.AGENFK_AIRLOCK_MODEL).toBe('spark/glm-5.3');
    expect(spec.network.allow).toContain('spark.example.com');
    expect(spec.maskedEnv).toEqual([{ name: 'SPARK_KEY', injectHosts: ['spark.example.com'] }]);
  });

  it('a profile (-p / --profile, or profile = in config.toml) chooses the model and provider', async () => {
    const toml = [
      'model = "gpt-6"', 'profile = "default-off"',
      '[profiles.work]', 'model = "glm-5.3"', 'model_provider = "spark"',
      '[model_providers."spark"]', "base_url = 'https://spark.example.com/v1'", 'env_key = "SPARK_KEY"',
    ].join('\n');
    for (const args of [['--profile', 'work'], ['-p', 'work'], ['--profile=work']]) {
      const d = deps({ env: { SPARK_KEY: 'real' } }, { [CONFIG]: toml });
      await runAirlockLaunch('codex', args, { keyEnv: [] }, d);
      expect(specOf(d).env.AGENFK_AIRLOCK_MODEL, args.join(' ')).toBe('spark/glm-5.3');
    }
    const fromConfig = deps({ env: { SPARK_KEY: 'real' } }, { [CONFIG]: toml.replace('profile = "default-off"', 'profile = "work"') });
    await runAirlockLaunch('codex', [], { keyEnv: [] }, fromConfig);
    expect(specOf(fromConfig).env.AGENFK_AIRLOCK_MODEL).toBe('spark/glm-5.3');
  });

  it('reads past multi-line strings (Codex\'s instructions), not discarding the file for them', async () => {
    const d = deps({ env: { SPARK_KEY: 'real' } }, {
      [CONFIG]: ['developer_instructions = """', 'be terse', '[not.a.table]', '"""', 'model = "glm-5.3"', 'model_provider = "spark"',
        '[model_providers.spark]', 'base_url = "https://spark.example.com/v1"', 'env_key = "SPARK_KEY"'].join('\n'),
    });
    await runAirlockLaunch('codex', [], { keyEnv: [] }, d);
    expect(specOf(d).env.AGENFK_AIRLOCK_MODEL).toBe('spark/glm-5.3');
    expect(d.warnings.join('\n')).not.toMatch(/config\.toml/);
  });

  it('-c model=... and -c model_provider=... override config.toml, as codex reads them', async () => {
    const d = deps({ env: { SPARK_KEY: 'real' } }, {
      [CONFIG]: 'model = "gpt-6"\n[model_providers.spark]\nbase_url = "https://spark.example.com/v1"\nenv_key = "SPARK_KEY"\n',
    });
    await runAirlockLaunch('codex', ['-c', 'model_provider="spark"', '--config', 'model=glm-5.3'], { keyEnv: [] }, d);
    expect(specOf(d).env.AGENFK_AIRLOCK_MODEL).toBe('spark/glm-5.3');
  });

  it('-c model_providers.<id>.base_url / env_key override config.toml\'s, as codex reads them (review)', async () => {
    const d = deps({ env: { NEW_KEY: 'real' } }, {
      [CONFIG]: 'model_provider = "spark"\n[model_providers.spark]\nbase_url = "https://spark.example.com/v1"\nenv_key = "SPARK_KEY"\n',
    });
    await runAirlockLaunch('codex', ['-c', 'model_providers.spark.base_url="https://new.example/v1"', '-c', 'model_providers.spark.env_key=NEW_KEY'], { keyEnv: [] }, d);
    const spec = specOf(d);
    expect(spec.network.allow).toContain('new.example');
    expect(spec.network.allow).not.toContain('spark.example.com');
    expect(spec.maskedEnv).toEqual([{ name: 'NEW_KEY', injectHosts: ['new.example'] }]);
  });

  it('CODEX_HOME is where its config is read, and the guest is told it', async () => {
    const d = deps({ env: { CODEX_HOME: '/home/u/cx', OPENAI_API_KEY: 'k' } }, { '/home/u/cx/config.toml': 'model = "gpt-6-mini"\n' });
    await runAirlockLaunch('codex', [], { keyEnv: [] }, d);
    const spec = specOf(d);
    expect(spec.env).toMatchObject({ CODEX_HOME: '/home/u/cx', AGENFK_AIRLOCK_MODEL: 'openai/gpt-6-mini' });
    expect(spec.filesystem.allowWrite).toContain('/home/u/cx');
  });

  it('an unreadable or malformed config.toml launches on the built-in default, and says so', async () => {
    const d = deps({ env: { OPENAI_API_KEY: 'k' } }, { [CONFIG]: 'model = "unterminated\n[[[' });
    await runAirlockLaunch('codex', [], { keyEnv: [] }, d);
    expect(specOf(d).network.allow).toContain('api.openai.com');
    expect(d.warnings.join('\n')).toMatch(/config\.toml/);
  });

  it('--login mount with a ChatGPT login: the machine gets its own auth.json, inference goes to chatgpt.com and refreshes to auth.openai.com', async () => {
    const d = deps({}, { [AUTH]: { tokens: { access_token: 'x', refresh_token: 'y', id_token: 'z' } } });
    await runAirlockLaunch('codex', [], { keyEnv: [], login: 'mount' }, d);
    const spec = specOf(d);
    expect(spec.filesystem.machineOwn).toEqual([{ path: '/home/u/.codex/auth.json', seed: true }]);
    expect(spec.network.allow).toEqual(expect.arrayContaining(['chatgpt.com', 'auth.openai.com']));
    expect(d.tokenSource!.get).not.toHaveBeenCalled();
  });

  it('a ChatGPT login without --login mount is refused, saying how to launch (host-held Codex is a later story)', async () => {
    const d = deps({}, { [AUTH]: { tokens: { access_token: 'x', refresh_token: 'y', id_token: 'z' } } });
    await expect(runAirlockLaunch('codex', [], { keyEnv: [] }, d)).rejects.toThrow(/ChatGPT login[\s\S]*--login mount[\s\S]*OPENAI_API_KEY/);
    expect(d.runtime.launch).not.toHaveBeenCalled();
    expect(d.tokenSource!.get).not.toHaveBeenCalled();
  });

  it('no key and no login at all is refused, naming both ways in', async () => {
    const d = deps();
    await expect(runAirlockLaunch('codex', [], { keyEnv: [] }, d)).rejects.toThrow(/OPENAI_API_KEY[\s\S]*--login mount/);
  });

  it('warns when ~/.codex/hooks.json has no Airlock hook: the sandbox still holds, but calls are not judged one by one', async () => {
    const without = deps({ env: { OPENAI_API_KEY: 'k' } });
    await runAirlockLaunch('codex', [], { keyEnv: [] }, without);
    expect(without.warnings.join('\n')).toMatch(/hooks\.json[\s\S]*agenfk upgrade/);
    const withHook = deps({ env: { OPENAI_API_KEY: 'k' } }, {
      [path.join(HOME, '.codex/hooks.json')]: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: HOOK }] }] } },
    });
    await runAirlockLaunch('codex', [], { keyEnv: [] }, withHook);
    expect(withHook.warnings.join('\n')).not.toMatch(/hooks\.json/);
  });

  it('--login mount needs no token source; --login with anything else is refused', async () => {
    const d = deps();
    await expect(runAirlockLaunch('codex', [], { keyEnv: [], login: 'sideways' as any }, d)).rejects.toThrow(/--login/);
    expect(d.runtime.launch).not.toHaveBeenCalled();
  });
});

describePosix('--login applies to claude and codex only', () => {
  it.each(['pi', 'opencode'] as const)('%s refuses --login: its logins are its own', async (client) => {
    const d = deps({ env: { OPENAI_API_KEY: 'k' } });
    await expect(runAirlockLaunch(client, client === 'pi' ? ['--model', 'openai/x'] : ['-m', 'openai/x'], { keyEnv: [], login: 'mount' }, d)).rejects.toThrow(/--login/);
  });
});

describe('agenfk airlock claude|codex (command wiring, GH-356)', () => {
  it.each(['claude', 'codex'] as const)('registers %s and hands it every argument after its name verbatim', async (client) => {
    const launch = vi.fn(async () => 0);
    const program = new Command();
    program.exitOverride();
    registerAirlockCommands(program, { launch, exit: vi.fn() });
    const args = ['--help', '--model', 'x', '--', '-p', 'a -- b'];
    await program.parseAsync(['node', 'agenfk', 'airlock', client, ...args]);
    expect(launch).toHaveBeenCalledWith(client, args, { keyEnv: [] });
  });

  it('takes --login before the client\'s name', () => {
    expect(clientArgsOf(['node', 'agenfk', 'airlock', '--login', 'mount', 'codex', '-m', 'x'], 'codex')).toEqual({ keyEnv: [], login: 'mount', args: ['-m', 'x'] });
    expect(clientArgsOf(['node', 'agenfk', 'airlock', '--login=host-held', 'claude'], 'claude')).toEqual({ keyEnv: [], login: 'host-held', args: [] });
  });
});
