/**
 * CGLAB-696 task 6: smolvm is Airlock's only runtime. The launcher and exec run sessions and
 * commands in SmolvmRuntime, on the smolvm AgEnFK installs (smolvmInstall.ts), with the egress
 * decider of each machine as a detached process; the Sandbox Runtime (ASRT) is gone. `agenfk
 * airlock install` installs smolvm, `agenfk airlock reset` deletes a workspace's machine.
 */
import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SmolvmRuntime, SMOLVM_VERSION } from '../airlock/smolvm';
import { smolvmBinary, smolvmDir } from '../airlock/smolvmInstall';
import { startEgressHelper } from '../airlock/egress';
import { registerAirlockCommands, defaultLaunchDeps, defaultExecDeps, smolvmPathFor } from '../commands/airlock';

describe('the runtime the launcher and exec use', () => {
  it('the launcher runs sessions in SmolvmRuntime', () => {
    const d = defaultLaunchDeps();
    expect(d.runtime).toBeInstanceOf(SmolvmRuntime);
    expect(d.runtime.id).toBe(`smolvm@${SMOLVM_VERSION}`);
  });

  it('exec runs commands in SmolvmRuntime', () => {
    expect(defaultExecDeps('http://127.0.0.1:47999', vi.fn() as any).runtime).toBeInstanceOf(SmolvmRuntime);
  });

  it('runs the smolvm AgEnFK installed, not one on PATH', () => {
    for (const rt of [defaultLaunchDeps().runtime, defaultExecDeps('http://127.0.0.1:47999', vi.fn() as any).runtime] as SmolvmRuntime[]) {
      expect((rt as any).d.smolvmPath).toBe(smolvmBinary(os.homedir()));
    }
  });

  it('the desktop app\'s helper runs the smolvm bundled beside it; anything else the one AgEnFK installed', () => {
    const bundled = path.join('/app', 'airlock', 'smolvm', 'smolvm');
    expect(smolvmPathFor(path.join('/app', 'airlock', 'dist'), '/home/u', (p) => p === bundled)).toBe(bundled);
    expect(smolvmPathFor(path.join('/x', 'cli', 'dist', 'commands'), '/home/u', () => false)).toBe(smolvmBinary('/home/u'));
  });

  it('keeps the installed smolvm unwritable from inside: it is the runtime\'s package', () => {
    expect(defaultLaunchDeps().runtimePackageDir).toBe(smolvmDir(fs.realpathSync(os.homedir())));
  });
});

describe('the Sandbox Runtime (ASRT) is gone', () => {
  it('is no dependency of the CLI', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })).not.toContain('@anthropic-ai/sandbox-runtime');
  });

  it('has no runtime left', async () => {
    const runtime = await import('../airlock/runtime');
    expect(Object.keys(runtime)).not.toContain('AsrtRuntime');
    expect(Object.keys(runtime)).not.toContain('toAsrtConfig');
  });
});

describe('the egress decider, started as its own process', () => {
  const spawnStub = () => {
    const calls: Array<{ file: string; args: string[]; options: any }> = [];
    const spawn = vi.fn((file: string, args: string[], options: any) => {
      calls.push({ file, args, options });
      return Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() });
    });
    return { spawn, calls };
  };

  it('runs egressMain.js beside it with this Node, detached', async () => {
    const s = spawnStub();
    expect(await startEgressHelper('m', '/cfg.json', { spawn: s.spawn as any, electron: undefined })).toBe(4242);
    expect(s.calls[0].file).toBe(process.execPath);
    expect(s.calls[0].args).toEqual([expect.stringMatching(/egressMain\.js$/), '/cfg.json']);
    expect(s.calls[0].options).toMatchObject({ detached: true });
  });

  it('under Electron (the desktop app\'s exec helper) runs it as Node, not as the app', async () => {
    const s = spawnStub();
    await startEgressHelper('m', '/cfg.json', { spawn: s.spawn as any, electron: '33.0.0' });
    expect(s.calls[0].options.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('agenfk airlock install / reset', () => {
  const program = (over: Record<string, unknown>) => {
    const p = new Command();
    p.exitOverride();
    const exit = vi.fn();
    registerAirlockCommands(p, { launch: async () => 0, exec: async () => 0, exit, ...over } as any);
    return { p, exit };
  };

  it('install installs smolvm and exits with its code', async () => {
    const install = vi.fn(async () => 0);
    const { p, exit } = program({ install });
    await p.parseAsync(['node', 'agenfk', 'airlock', 'install']);
    expect(install).toHaveBeenCalledWith({ ifEnabled: false });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('install --if-enabled only installs where Airlock is in use', async () => {
    const install = vi.fn(async () => 0);
    const { p } = program({ install });
    await p.parseAsync(['node', 'agenfk', 'airlock', 'install', '--if-enabled']);
    expect(install).toHaveBeenCalledWith({ ifEnabled: true });
  });

  it('reset deletes the machine of the folder it is run in, or of --cwd, and exits with its code', async () => {
    const reset = vi.fn(async () => 1);
    const { p, exit } = program({ reset });
    await p.parseAsync(['node', 'agenfk', 'airlock', 'reset', '--cwd', '/work/repo']);
    expect(reset).toHaveBeenCalledWith(path.resolve('/work/repo'));
    expect(exit).toHaveBeenCalledWith(1);
    // A fresh program: commander keeps an option's value from one parse to the next.
    await program({ reset }).p.parseAsync(['node', 'agenfk', 'airlock', 'reset']);
    expect(reset).toHaveBeenLastCalledWith(process.cwd());
  });
});
