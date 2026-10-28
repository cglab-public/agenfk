/**
 * Airlock layer 2 (GH-294, L2-1): the AirlockRuntime interface and its one
 * implementation over the Sandbox Runtime (ASRT) library, tested with a fake
 * ASRT. The real one is exercised by the conformance suite (L2-3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  sandboxNoop,
  runSandboxProbe,
} from '../airlock/runtime';

// The launcher refuses Windows (AsrtRuntime.check, tested there), so these POSIX
// sandbox specs never run on it; their literal POSIX paths would not hold either.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

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

/** The dry run of the sandbox before the client starts (025f3000): exits as told. */
function fakeProbe(result: { status: number | null; stderr?: string; error?: Error } = { status: 0, stderr: '' }) {
  return vi.fn(async () => ({ stderr: '', ...result }));
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

describePosix('sandboxCommandLine', () => {
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
    const rt = new AsrtRuntime({ load, spawn: spawn as any, runProbe: fakeProbe(), platform: 'darwin' });
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
    const rt = new AsrtRuntime({ load, spawn: spawn as any, runProbe: fakeProbe(), platform: 'darwin' });
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

  describe('the sandbox is started once empty before the client (025f3000)', () => {
    const NO_USERNS = 'bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap>.\n';
    const NO_PROC = 'bwrap: Can\'t mount proc on /newroot/proc: Operation not permitted\n';

    it('runs the dry run inside the same initialized sandbox, in the session\'s directory, before spawning the client', async () => {
      const { manager, load } = fakeAsrt();
      const { spawn } = fakeSpawn();
      const probe = fakeProbe();
      const rt = new AsrtRuntime({ load, spawn: spawn as any, runProbe: probe, platform: 'linux' });
      await rt.launch(spec, { file: 'pi', args: [], cwd: '/work/repo' });
      expect(manager.initialize).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(1);
      const [file, args, options] = probe.mock.calls[0] as unknown as [string, string[], any];
      // The wrapped argv ASRT gave for the empty command, with its env and the session's cwd.
      expect(file).toBe('/bin/bash');
      expect(args[0]).toBe('-c');
      // A no-op by absolute path (never `true` from PATH) under the spec's own env; the client program is not in it.
      expect(args[1]).toMatch(/^WRAPPED .*('\/usr\/bin\/true'|'\/bin\/true'|'\/bin\/sh' '-c' ':')$/);
      expect(args[1]).not.toMatch(/'true'/);
      expect(args[1]).not.toMatch(/'pi'/);
      expect(options).toMatchObject({ cwd: '/work/repo', env: { FROM_ASRT: '1' } });
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(probe.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]);
    });

    it('no user namespaces: starts nothing, cleans up, and says why and what fixes it', async () => {
      const { manager, load } = fakeAsrt();
      const { spawn } = fakeSpawn();
      const rt = new AsrtRuntime({ load, spawn: spawn as any, runProbe: fakeProbe({ status: 1, stderr: NO_USERNS }), platform: 'linux' });
      const err = await rt.launch(spec, { file: 'pi', args: [], cwd: '/w' }).then(() => null, (e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(spawn).not.toHaveBeenCalled();
      expect(manager.reset).toHaveBeenCalled();
      expect(err!.message).toMatch(/nothing was launched/i);
      expect(err!.message).toMatch(/user namespaces/i);
      expect(err!.message).toContain('No permissions to create new namespace');
      // In a container seccomp alone only gets as far as the /proc refusal (measured), so both are named at once.
      expect(err!.message).toContain('--security-opt seccomp=unconfined --security-opt systempaths=unconfined');
    });

    it('no /proc mount: starts nothing and names the container setting that allows it', async () => {
      const { load } = fakeAsrt();
      const { spawn } = fakeSpawn();
      const rt = new AsrtRuntime({ load, spawn: spawn as any, runProbe: fakeProbe({ status: 1, stderr: NO_PROC }), platform: 'linux' });
      const err = await rt.launch(spec, { file: 'pi', args: [], cwd: '/w' }).then(() => null, (e) => e as Error);
      expect(spawn).not.toHaveBeenCalled();
      expect(err!.message).toMatch(/\/proc/);
      expect(err!.message).toContain("Can't mount proc");
      expect(err!.message).toContain('--security-opt systempaths=unconfined');
    });

    it('any other failure quotes the sandbox\'s first line; a dry run that cannot be run at all also refuses', async () => {
      const { load } = fakeAsrt();
      const { spawn } = fakeSpawn();
      const odd = new AsrtRuntime({ load, spawn: spawn as any, runProbe: fakeProbe({ status: 2, stderr: '\nsandbox-exec: something unexpected\nsecond line\n' }), platform: 'darwin' });
      const e1 = await odd.launch(spec, { file: 'pi', args: [], cwd: '/w' }).then(() => null, (e) => e as Error);
      expect(e1!.message).toContain('sandbox-exec: something unexpected');
      expect(e1!.message).not.toContain('second line');
      const timedOut = Object.assign(new Error('spawnSync /bin/bash ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const hung = new AsrtRuntime({ load: fakeAsrt().load, spawn: spawn as any, runProbe: fakeProbe({ status: null, error: timedOut }), platform: 'linux' });
      const e2 = await hung.launch(spec, { file: 'pi', args: [], cwd: '/w' }).then(() => null, (e) => e as Error);
      expect(e2).toBeInstanceOf(Error);
      expect(e2!.message).toMatch(/nothing was launched/i);
      expect(e2!.message).toContain('ETIMEDOUT');
      // A signal-killed dry run (status null, no error) is a failure too, never a pass.
      const killed = new AsrtRuntime({ load: fakeAsrt().load, spawn: spawn as any, runProbe: fakeProbe({ status: null }), platform: 'linux' });
      await expect(killed.launch(spec, { file: 'pi', args: [], cwd: '/w' })).rejects.toThrow(/nothing was launched/i);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('never falls back to the weaker sandbox that skips the fresh /proc', async () => {
      const { manager, load } = fakeAsrt();
      const rt = new AsrtRuntime({ load, spawn: fakeSpawn().spawn as any, runProbe: fakeProbe({ status: 1, stderr: NO_PROC }), platform: 'linux' });
      await rt.launch(spec, { file: 'pi', args: [], cwd: '/w' }).catch(() => undefined);
      expect(manager.initialize).toHaveBeenCalledTimes(1);
      for (const call of manager.initialize.mock.calls as unknown as unknown[][]) {
        expect(JSON.stringify(call[0])).not.toMatch(/"enableWeakerNestedSandbox":true/);
      }
    });
  });

  describe('the empty sandbox\'s no-op and how it is waited for (025f3000 review)', () => {
    it('the no-op is an absolute path, never looked up on PATH', () => {
      expect(sandboxNoop((p) => p === '/usr/bin/true')).toEqual({ file: '/usr/bin/true', args: [] });
      expect(sandboxNoop((p) => p === '/bin/true')).toEqual({ file: '/bin/true', args: [] });
      expect(sandboxNoop(() => false)).toEqual({ file: '/bin/sh', args: ['-c', ':'] });
    });

    describePosix('runSandboxProbe, on real processes', () => {
      const opts = { cwd: process.cwd(), env: process.env };

      it('gives the exit status and what the sandbox printed', async () => {
        const r = await runSandboxProbe('/bin/sh', ['-c', 'echo "bwrap: refused" >&2; exit 3'], { ...opts, timeoutMs: 10_000 });
        expect(r).toMatchObject({ status: 3, stderr: 'bwrap: refused\n' });
        expect(r.error).toBeUndefined();
        await expect(runSandboxProbe('/bin/sh', ['-c', ':'], { ...opts, timeoutMs: 10_000 })).resolves.toMatchObject({ status: 0 });
      });

      it('kills a sandbox that does not exit in time, what it started included, and reports it as a failure', async () => {
        const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
        let pids: number[] = [];
        try {
          const started = Date.now();
          // The shell and the child it waits on (dash does not exec it), both named on stderr.
          const r = await runSandboxProbe('/bin/sh', ['-c', 'sleep 20 & echo "$$ $!" >&2; wait'], { ...opts, timeoutMs: 500 });
          expect(Date.now() - started).toBeLessThan(5_000);
          expect(r.status).toBeNull();
          expect(r.error?.message).toMatch(/did not exit within/);
          pids = r.stderr.trim().split(/\s+/).map(Number);
          expect(pids).toHaveLength(2);
          for (let i = 0; i < 20 && pids.some(alive); i++) await new Promise((res) => setTimeout(res, 50));
          expect(pids.filter(alive)).toEqual([]);
        } finally {
          for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
        }
      });

      describe('a signal while it runs', () => {
        // The worker's own listeners are set aside so each case decides who else listens.
        let saved: Array<(...a: any[]) => void> = [];
        let kill: ReturnType<typeof vi.spyOn>;
        const reraised = () => kill.mock.calls.filter(([pid]) => pid === process.pid);
        beforeEach(() => {
          saved = process.listeners('SIGTERM') as any;
          process.removeAllListeners('SIGTERM');
          const real = process.kill.bind(process);
          // The re-raise at this process is recorded, not delivered; the probe's group is really killed.
          kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: any) => (pid === process.pid ? true : real(pid, sig))) as any);
        });
        afterEach(() => {
          kill.mockRestore();
          process.removeAllListeners('SIGTERM');
          for (const l of saved) process.on('SIGTERM', l);
        });

        it('with no one else listening: ends the sandbox start, then raises it again for its default action', async () => {
          const r = runSandboxProbe('/bin/sh', ['-c', 'sleep 20'], { ...opts, timeoutMs: 10_000 });
          const signalled = Date.now();
          process.emit('SIGTERM', 'SIGTERM');
          const result = await r;
          // The signal ended it, not the 10s timeout.
          expect(Date.now() - signalled).toBeLessThan(3_000);
          expect(result.status).toBeNull();
          expect(result.error?.message ?? '').not.toMatch(/did not exit within/);
          expect(kill).toHaveBeenCalledWith(expect.any(Number), 'SIGKILL');
          expect(reraised()).toEqual([[process.pid, 'SIGTERM']]);
        });

        it('with another listener: ends the sandbox start, leaves the signal to it, which runs once', async () => {
          const other = vi.fn();
          process.on('SIGTERM', other);
          const r = runSandboxProbe('/bin/sh', ['-c', 'sleep 20'], { ...opts, timeoutMs: 10_000 });
          const signalled = Date.now();
          process.emit('SIGTERM', 'SIGTERM');
          const result = await r;
          // The signal ended it, not the 10s timeout.
          expect(Date.now() - signalled).toBeLessThan(3_000);
          expect(result.status).toBeNull();
          expect(result.error?.message ?? '').not.toMatch(/did not exit within/);
          expect(kill).toHaveBeenCalledWith(expect.any(Number), 'SIGKILL');
          expect(reraised()).toEqual([]);
          expect(other).toHaveBeenCalledTimes(1);
        });
      });

      it('lets go of the signals it forwards once it is done', async () => {
        const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s as NodeJS.Signals));
        const r = runSandboxProbe('/bin/sh', ['-c', 'sleep 0.3'], { ...opts, timeoutMs: 10_000 });
        // While it runs, a Ctrl-C or a closed terminal reaches it through this process.
        expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s as NodeJS.Signals))).toEqual(before.map((n) => n + 1));
        await r;
        expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s as NodeJS.Signals))).toEqual(before);
      });

      it('a program that cannot be started is a failure, not a pass', async () => {
        const r = await runSandboxProbe('/nonexistent/sandbox-wrapper', [], { ...opts, timeoutMs: 10_000 });
        expect(r.status).toBeNull();
        expect(r.error).toBeInstanceOf(Error);
      });

      it('does not block this process while the sandbox starts (its proxy runs here)', async () => {
        // A timer due in 50ms fires on time while a 1s sandbox start runs; a synchronous wait would hold it ~1s.
        const scheduled = Date.now();
        const fired = new Promise<number>((res) => setTimeout(() => res(Date.now() - scheduled), 50));
        const r = runSandboxProbe('/bin/sh', ['-c', 'sleep 1'], { ...opts, timeoutMs: 10_000 });
        expect(await fired).toBeLessThan(600);
        await expect(r).resolves.toMatchObject({ status: 0 });
      });
    });
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

describePosix('AsrtRuntime: a command in its own process group (SX-2 review)', () => {
  it('a signal ends the command and everything it started; nothing outlives exec', async () => {
    const os = await import('os');
    const fsm = await import('fs');
    const pathm = await import('path');
    const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'pg-'));
    const pidFile = pathm.join(dir, 'pid');
    const manager = {
      initialize: async () => undefined,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      // no real sandbox here: the wrapper is the shell itself
      wrapWithSandboxArgv: async (line: string) => ({ argv: ['/bin/sh', '-c', line], env: process.env }),
      reset: async () => undefined,
    };
    const rt = new AsrtRuntime({ load: async () => ({ SandboxManager: manager }) as any, runProbe: async () => ({ status: 0, stderr: '' }), platform: process.platform as any });
    const launched = await rt.launch(
      { ...spec, env: {} },
      { file: '/bin/sh', args: ['-c', `sleep 600 & echo $! > ${pidFile}; wait`], cwd: dir, processGroup: true },
    );
    await vi.waitFor(() => expect(fsm.existsSync(pidFile) && fsm.readFileSync(pidFile, 'utf8').trim()).toBeTruthy(), { timeout: 5000 });
    const sleeper = Number(fsm.readFileSync(pidFile, 'utf8').trim());
    launched.kill('SIGTERM');
    await launched.exited;
    await vi.waitFor(() => { let alive = true; try { process.kill(sleeper, 0); } catch { alive = false; } expect(alive).toBe(false); }, { timeout: 5000 });
    await rt.dispose();
  });
});
