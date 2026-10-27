/**
 * Airlock layer 2 (GH-294, L2-1): the AirlockRuntime interface and its one
 * implementation over the Sandbox Runtime (ASRT) library, tested with a fake
 * ASRT. The real one is exercised by the conformance suite (L2-3).
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { normalizeAirlockPolicy } from '@agenfk/core';
import { buildSandboxSpec, type SandboxSession } from '../airlock/spec';
import {
  AsrtRuntime,
  ASRT_VERSION,
  toAsrtConfig,
  sandboxCommandLine,
} from '../airlock/runtime';

const session: SandboxSession = {
  client: 'pi',
  home: '/home/u',
  workspace: '/work/repo',
  tempDirs: ['/tmp/x'],
  inferenceHosts: ['api.openai.com'],
  serverPort: 3123,
  installDirs: ['/home/u/.agenfk-system'],
};
const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['api.github.com'], deny: ['10.0.0.0/8'] } }), session);

function fakeAsrt(over: Record<string, unknown> = {}) {
  const manager = {
    initialize: vi.fn(async () => undefined),
    checkDependencies: vi.fn(() => ({ errors: [] as string[], warnings: [] as string[] })),
    wrapWithSandboxArgv: vi.fn(async (cmd: string) => ({ argv: ['/bin/bash', '-c', `WRAPPED ${cmd}`], env: { FROM_ASRT: '1' } })),
    reset: vi.fn(async () => undefined),
    ...over,
  };
  return { manager, load: vi.fn(async () => ({ SandboxManager: manager })) };
}

function fakeSpawn(exit: { code: number | null; signal: string | null } = { code: 0, signal: null }) {
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(() => true) });
  const spawn = vi.fn(() => {
    setImmediate(() => child.emit('exit', exit.code, exit.signal));
    return child;
  });
  return { spawn, child };
}

describe('toAsrtConfig', () => {
  it('maps the spec onto ASRT settings', () => {
    const cfg = toAsrtConfig(spec);
    expect(cfg.network.allowedDomains).toEqual(spec.network.allow);
    expect(cfg.network.deniedDomains).toEqual(spec.network.deny);
    expect(cfg.network.deniedResolvedAddresses).toEqual(['10.0.0.0/8']);
    expect(cfg.filesystem).toEqual({
      denyRead: spec.filesystem.denyRead,
      allowWrite: spec.filesystem.allowWrite,
      denyWrite: spec.filesystem.denyWrite,
    });
    expect(cfg.allowPty).toBe(true);
    // Never opens the escape hatches the README warns about.
    expect(cfg.allowAppleEvents).toBeFalsy();
    expect(cfg.enableWeakerNetworkIsolation).toBeFalsy();
    expect(cfg.allowNestedUserNamespaces).toBeFalsy();
    expect(cfg.network.allowLocalBinding).toBeFalsy();
    expect(cfg.credentials).toBeUndefined();
    expect(cfg.network.tlsTerminate).toBeUndefined();
  });

  it('masks key env vars over TLS termination, injected only to their hosts', () => {
    const masked = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce' }), { ...session, maskedEnv: ['OPENAI_API_KEY'] });
    const cfg = toAsrtConfig(masked);
    expect(cfg.credentials).toEqual({ envVars: [{ name: 'OPENAI_API_KEY', mode: 'mask', injectHosts: ['api.openai.com'] }] });
    expect(cfg.network.tlsTerminate).toEqual({});
  });
});

describe('sandboxCommandLine', () => {
  it('runs the program with its arguments intact and the spec env set (a real shell parses it)', () => {
    const script = 'console.log(JSON.stringify([process.argv.slice(1), process.env.NO_PROXY, process.env.NODE_USE_ENV_PROXY, process.env.AGENFK_AIRLOCK_SANDBOX]))';
    const line = sandboxCommandLine(spec, { file: process.execPath, args: ['-e', script, 'a b', "it's", '$HOME', '`id`'], cwd: '/' });
    const out = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8', env: { ...process.env, NO_PROXY: 'localhost' } });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([['a b', "it's", '$HOME', '`id`'], '', '1', 'pi']);
  });
});

describe('AsrtRuntime', () => {
  it('pins the sandbox runtime exactly, and that is the version installed', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    expect(manifest.dependencies['@anthropic-ai/sandbox-runtime']).toBe(ASRT_VERSION);
    expect(ASRT_VERSION).toBe('0.0.81');
    const req = createRequire(path.resolve(__dirname, '../../package.json'));
    const pkgDir = AsrtRuntime.packageDir(req);
    expect(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version).toBe(ASRT_VERSION);
  });

  it('launch: initializes ASRT with the spec, wraps the command and spawns the wrapped argv, forwarding the exit', async () => {
    const { manager, load } = fakeAsrt();
    const { spawn } = fakeSpawn({ code: 7, signal: null });
    const rt = new AsrtRuntime({ load, spawn: spawn as any, platform: 'darwin' });
    const launched = await rt.launch(spec, { file: 'pi', args: ['--model', 'x'], cwd: '/work/repo' });
    expect(manager.initialize).toHaveBeenCalledWith(toAsrtConfig(spec));
    const line = sandboxCommandLine(spec, { file: 'pi', args: ['--model', 'x'], cwd: '/work/repo' });
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledWith(line, undefined, undefined, undefined, '/work/repo');
    expect(spawn).toHaveBeenCalledWith('/bin/bash', ['-c', `WRAPPED ${line}`], expect.objectContaining({
      cwd: '/work/repo', stdio: 'inherit', env: { FROM_ASRT: '1' },
    }));
    expect(launched.pid).toBe(4242);
    await expect(launched.exited).resolves.toEqual({ code: 7, signal: null });
    await rt.dispose();
    expect(manager.reset).toHaveBeenCalled();
  });

  it('launch: forwards a signal to the sandboxed process', async () => {
    const { load } = fakeAsrt();
    const { spawn, child } = fakeSpawn();
    const rt = new AsrtRuntime({ load, spawn: spawn as any, platform: 'darwin' });
    const launched = await rt.launch(spec, { file: 'pi', args: [], cwd: '/w' });
    launched.kill('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('launch fails closed: an ASRT that refuses the config starts nothing', async () => {
    const { manager, load } = fakeAsrt({ initialize: vi.fn(async () => { throw new Error('bad config'); }) });
    const { spawn } = fakeSpawn();
    const rt = new AsrtRuntime({ load, spawn: spawn as any, platform: 'darwin' });
    await expect(rt.launch(spec, { file: 'pi', args: [], cwd: '/w' })).rejects.toThrow(/bad config/);
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.reset).toHaveBeenCalled();
  });

  it('check: Windows is refused in this release without loading ASRT', async () => {
    const { load } = fakeAsrt();
    const rt = new AsrtRuntime({ load, platform: 'win32' });
    const r = await rt.check();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/Windows is not supported/);
    expect(load).not.toHaveBeenCalled();
  });

  it('check: Linux without bubblewrap/socat says what is missing', async () => {
    const { load } = fakeAsrt({ checkDependencies: vi.fn(() => ({ errors: ['bubblewrap (bwrap) not installed', 'socat not installed'], warnings: [] })) });
    const rt = new AsrtRuntime({ load, platform: 'linux' });
    const r = await rt.check();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/bwrap.*socat|socat.*bwrap/s);
  });

  it('launch refuses where check fails', async () => {
    const { load } = fakeAsrt({ checkDependencies: vi.fn(() => ({ errors: ['socat not installed'], warnings: [] })) });
    const { spawn } = fakeSpawn();
    const rt = new AsrtRuntime({ load, spawn: spawn as any, platform: 'linux' });
    await expect(rt.launch(spec, { file: 'pi', args: [], cwd: '/w' })).rejects.toThrow(/socat/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('check: macOS is supported', async () => {
    const { load } = fakeAsrt();
    await expect(new AsrtRuntime({ load, platform: 'darwin' }).check()).resolves.toMatchObject({ ok: true });
  });
});
