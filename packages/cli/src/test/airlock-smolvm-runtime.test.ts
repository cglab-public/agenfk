/**
 * CGLAB-696 task 1: the smolvm Airlock runtime. One persistent machine per
 * workspace (the folder Airlock is launched from), started for a session and
 * stopped when the last one leaves. The guest sees only what is mounted: the
 * workspace and the client's state, at their host paths; what the spec keeps
 * unwritable inside them is bound read-only in the guest, and what it keeps
 * unreadable is hidden. Tested with a fake smolvm CLI; the last block runs the
 * real one where it is installed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeAirlockPolicy } from '@agenfk/core';
import { buildSandboxSpec, type SandboxSession, type SandboxSpec } from '../airlock/spec';
import type { ProxyDecision } from '../airlock/runtime';
import { allowListArgs, GATEWAY, networkKey, type Route } from '../airlock/egress';
import {
  SmolvmRuntime,
  SMOLVM_VERSION,
  machineNameOf,
  guestPlanOf,
  guestSetupScript,
  runAirlockReset,
  platformBindLines,
  platformInstallOf,
  PLATFORM_INSTALL_SCRIPT,
  INSTALL_TIMEOUT,
  LOCK_TIMEOUT_MS,
  GUEST_PLATFORM_ROOT,
  COMMAND_IN_NAMESPACE,
  WATCHDOG,
  DNS_RESOLVER_ADDRESS,
  DNS_UNPROTECTED_MARK,
  resolverDenyOf,
  guestDnsScript,
  type EgressBroker,
  type SmolvmResult,
} from '../airlock/smolvm';

const IMAGE = 'ghcr.io/cglab-public/agenfk-airlock-base:test';

type Machine = { state: 'running' | 'stopped'; labels: Record<string, string>; image: string };

const flag = (args: string[], ...names: string[]): string | undefined => {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i >= 0) return args[i + 1];
  }
  return undefined;
};

/** The smolvm CLI, as far as the runtime uses it: machines, mounts, exec, version. */
function fakeSmolvm(init: { machines?: Record<string, Machine>; version?: string; startFails?: string; missing?: boolean; stopTakesMs?: number; stopFails?: string; execFails?: (args: string[]) => string | null; execStdout?: (args: string[]) => string } = {}) {
  const machines = new Map<string, Machine>(Object.entries(init.machines ?? {}));
  const mounts = new Map<string, Array<{ source: string; target: string; readOnly: boolean }>>();
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const ok = (stdout = ''): SmolvmResult => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr: string): SmolvmResult => ({ code: 1, stdout: '', stderr });
  const run = vi.fn(async (args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<SmolvmResult> => {
    if (init.missing) throw Object.assign(new Error('spawn smolvm ENOENT'), { code: 'ENOENT' });
    calls.push({ args, env: opts.env });
    if (args[0] === '--version') return ok(`smolvm ${init.version ?? SMOLVM_VERSION}\n`);
    expect(args[0]).toBe('machine');
    const name = flag(args, '--name', '-n') as string;
    const m = machines.get(name);
    switch (args[1]) {
      case 'ls':
        return ok(JSON.stringify([...machines].map(([n, v]) => ({ name: n, state: v.state, labels: v.labels, image: v.image }))));
      case 'create': {
        const labels: Record<string, string> = {};
        args.forEach((a, i) => {
          if (a === '--label') {
            const [k, ...v] = args[i + 1].split('=');
            labels[k] = v.join('=');
          }
        });
        machines.set(name, { state: 'stopped', labels, image: flag(args, '-I', '--image') as string });
        return ok();
      }
      case 'delete':
        if (!m) return fail('vm not found');
        machines.delete(name);
        return ok();
      case 'start':
        if (init.startFails) return fail(init.startFails);
        if (!m) return fail('vm not found');
        m.state = 'running';
        return ok();
      case 'stop':
        // A real stop takes a while: long enough for another session to join meanwhile.
        if (init.stopTakesMs) await new Promise((r) => setTimeout(r, init.stopTakesMs));
        if (init.stopFails) return fail(init.stopFails);
        if (m) m.state = 'stopped';
        mounts.delete(name);
        return ok();
      case 'mount':
        if (args[2] === 'ls') return ok(JSON.stringify(mounts.get(name) ?? []));
        if (args[2] === 'add') {
          const [source, target, ro] = (flag(args, '-v', '--volume') as string).split(':');
          const list = mounts.get(name) ?? [];
          if (list.some((x) => x.target === target)) return fail(`${target} already has an attached mount`);
          list.push({ source, target, readOnly: ro === 'ro' });
          mounts.set(name, list);
          return ok();
        }
        return fail('unknown mount verb');
      case 'cp':
        return ok();
      case 'exec': {
        const failed = init.execFails?.(args);
        return failed ? fail(failed) : ok(init.execStdout?.(args) ?? '');
      }
      case 'update':
        if (!m) return fail('vm not found');
        if (m.state === 'running') return fail('machine must be stopped');
        return ok();
      default:
        return fail(`unknown verb ${args[1]}`);
    }
  });
  const verbs = () => calls.filter((c) => c.args[0] === 'machine').map((c) => c.args[1]);
  const execs = () => calls.filter((c) => c.args[1] === 'exec').map((c) => c.args);
  return { run, calls, machines, mounts, verbs, execs };
}

function fakeEgress(): EgressBroker & { ensure: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; watch: ReturnType<typeof vi.fn>; addRoute: ReturnType<typeof vi.fn>; emit(d: ProxyDecision): void; unwatched: number; routes: Route[] } {
  const listeners = new Set<(d: ProxyDecision) => void>();
  // Short: route sockets are Unix socket paths.
  const sockets = fs.mkdtempSync(path.join('/tmp', 'agenfk-rs-'));
  let n = 0;
  const broker = {
    unwatched: 0,
    routes: [] as Route[],
    routeSocket: vi.fn(() => path.join(sockets, `${n++}.sock`)),
    addRoute: vi.fn((_machine: string, route: Route) => {
      broker.routes.push(route);
      return () => { broker.routes = broker.routes.filter((r) => r !== route); };
    }),
    ensure: vi.fn(async () => ({ address: '127.0.0.1:47001', token: 'a'.repeat(64) })),
    stop: vi.fn(async () => undefined),
    watch: vi.fn((_machine: string, fn: (d: ProxyDecision) => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); broker.unwatched++; };
    }),
    emit: (d: ProxyDecision) => { for (const l of listeners) l(d); },
  };
  return broker;
}

/** The host side of `smolvm machine exec` for the session: exits when told to. */
function fakeSpawn() {
  const children: Array<EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn>; finish(code: number | null, signal?: string | null): void }> = [];
  const spawn = vi.fn((_file: string, _args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 5000 + children.length,
      kill: vi.fn(() => true),
      finish(code: number | null, signal: string | null = null) { child.emit('exit', code, signal); },
    });
    children.push(child);
    return child;
  });
  return { spawn, children };
}

let root: string;
let home: string;
let workspace: string;
let agentDir: string;
let stagedDir: string;
let stateDir: string;
let tmpDir: string;

function session(over: Partial<SandboxSession> = {}): SandboxSession {
  return {
    client: 'pi',
    home,
    workspace,
    tempDirs: [tmpDir],
    inferenceHosts: ['api.openai.com'],
    serverPort: 3123,
    installDirs: [path.join(home, '.agenfk-system')],
    gitDir: path.join(workspace, '.git'),
    piAgentDir: agentDir,
    ...over,
  };
}
const specOf = (over: Partial<SandboxSession> = {}): SandboxSpec =>
  buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['api.github.com'] } }), session(over));

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-smolvm-')));
  home = path.join(root, 'home');
  workspace = path.join(root, 'work', 'repo');
  agentDir = path.join(home, '.pi', 'agent');
  tmpDir = path.join(root, 'tmp');
  stagedDir = path.join(tmpDir, 'agenfk-airlock-pi-x');
  stateDir = path.join(root, 'state');
  for (const d of [
    path.join(workspace, '.agenfk'), path.join(workspace, '.git', 'hooks'), path.join(workspace, 'packages', 'a', '.agenfk'),
    path.join(workspace, 'node_modules', 'dep', '.agenfk'),
    path.join(agentDir, 'extensions'), path.join(agentDir, 'sessions'), stagedDir, path.join(home, '.ssh'),
  ]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(agentDir, 'auth.json'), '{"fake":"not-a-key"}\n');
  fs.writeFileSync(path.join(home, '.ssh', 'id_fake'), 'fake\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function runtime({ smolvm: givenSmolvm, egress: givenEgress, ...over }: Record<string, unknown> = {}) {
  const smolvm = (givenSmolvm as ReturnType<typeof fakeSmolvm>) ?? fakeSmolvm();
  const egress = (givenEgress as ReturnType<typeof fakeEgress>) ?? fakeEgress();
  const sp = fakeSpawn();
  const watchdog = { stopped: 0, start: vi.fn((_args: string[]) => ({ stop: () => { watchdog.stopped++; } })) };
  const rt = new SmolvmRuntime({
    image: IMAGE,
    smolvm: smolvm.run,
    spawn: sp.spawn as any,
    platform: 'darwin',
    arch: 'arm64',
    kvmAccessible: () => false,
    stateDir,
    egress,
    uid: 503,
    gid: 20,
    isTTY: false,
    hostEnv: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'sk-fake-not-real', PATH: '/host/bin' },
    pidAlive: (pid: number) => pid === process.pid,
    startWatchdog: watchdog.start,
    ...over,
  });
  return { rt, smolvm, egress, sp, watchdog };
}

const cmd = () => ({ file: 'pi', args: ['--approve'], cwd: workspace });
/** Another session in the machine, alive (this process). */
function liveSession(name: string, id = 'other', network: SandboxSpec['network'] = specOf().network) {
  const sessions = path.join(stateDir, 'machines', name, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify({ pid: process.pid }));
  // The network policy and file protections the machine was started under, as the session that started it records them.
  fs.writeFileSync(path.join(stateDir, 'machines', name, 'network.json'), networkKey(network));
  const plan = guestPlanOf(specOf(), workspace);
  fs.writeFileSync(path.join(stateDir, 'machines', name, 'protections.json'), JSON.stringify({ pinned: plan.pinned, writable: plan.writable, readOnly: plan.readOnly, hidden: plan.hidden }));
  fs.writeFileSync(path.join(stateDir, 'machines', name, 'injection.json'), JSON.stringify(specOf().maskedEnv.map((m) => [m.name, [...m.injectHosts].sort()]).sort()));
}
/** The mounts this session's plan makes, as `mount ls` lists them. */
const sameMounts = () => guestPlanOf(specOf(), workspace).mounts.map((m) => ({ source: m.host, target: m.guest, readOnly: false }));
const running = (name: string): Machine => ({ state: 'running', image: IMAGE, labels: { 'agenfk.workspace': workspace, 'agenfk.image': IMAGE } });
/** Let the launch's queued smolvm calls run. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('SmolvmRuntime.check', () => {
  it('refuses to run sessions as root: root in the guest undoes every protection (story review)', async () => {
    const r = await runtime({ uid: 0 }).rt.check();
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/root/);
  });

  it('a missing smolvm: says how AgEnFK installs it (CGLAB-696 task 6)', async () => {
    const r = await runtime({ smolvm: fakeSmolvm({ missing: true }) }).rt.check();
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/agenfk airlock install/);
  });

  it('refuses Windows, and says why', async () => {
    const r = await runtime({ platform: 'win32' }).rt.check();
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/Windows/);
  });

  it('refuses an Intel Mac: smolvm needs Apple Silicon', async () => {
    const r = await runtime({ arch: 'x64' }).rt.check();
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/Apple Silicon/);
  });

  it('refuses Linux without a usable /dev/kvm, and says how to get one', async () => {
    const r = await runtime({ platform: 'linux', arch: 'x64', kvmAccessible: () => false }).rt.check();
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/\/dev\/kvm/);
    expect((r as { reason: string }).reason).toMatch(/kvm group|virtuali[sz]ation/i);
  });

  it('accepts Linux with /dev/kvm', async () => {
    expect(await runtime({ platform: 'linux', arch: 'x64', kvmAccessible: () => true }).rt.check()).toEqual({ ok: true, warnings: [] });
  });

  it('accepts Apple Silicon with the pinned smolvm', async () => {
    expect(await runtime().rt.check()).toEqual({ ok: true, warnings: [] });
  });

  it('refuses when smolvm is not installed, and says how to install it', async () => {
    const r = await runtime({ smolvm: fakeSmolvm({ missing: true }) }).rt.check();
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/smolvm/);
    expect((r as { reason: string }).reason).toMatch(/install/i);
  });

  it('refuses another smolvm version, naming both', async () => {
    const r = await runtime({ smolvm: fakeSmolvm({ version: '1.31.0' }) }).rt.check();
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('1.31.0');
    expect((r as { reason: string }).reason).toContain(SMOLVM_VERSION);
  });

  it('names itself after smolvm and its version', () => {
    expect(runtime().rt.id).toBe(`smolvm@${SMOLVM_VERSION}`);
  });
});

describe('machineNameOf', () => {
  it('is one name per workspace folder, stable, and a valid machine name', () => {
    expect(machineNameOf('/work/a')).toBe(machineNameOf('/work/a'));
    expect(machineNameOf('/work/a')).not.toBe(machineNameOf('/work/b'));
    expect(machineNameOf('/work/a')).toMatch(/^agenfk-[0-9a-f]{16}$/);
  });
});

describe('the machine of a workspace', () => {
  it('is created on the first launch from the image, with mediated networking, labelled with its workspace and image', async () => {
    const { rt, smolvm, sp } = runtime();
    const launched = rt.launch(specOf(), cmd());
    await launched;
    const name = machineNameOf(workspace);
    const create = smolvm.calls.find((c) => c.args[1] === 'create')!.args;
    expect(flag(create, '--name', '-n')).toBe(name);
    expect(flag(create, '-I', '--image')).toBe(IMAGE);
    expect(create).toContain('--net');
    expect(flag(create, '--net-backend')).toBe('virtio-net');
    expect(create).toContain('--trust-host-certs');
    expect(create).toContain(`agenfk.workspace=${workspace}`);
    expect(create).toContain(`agenfk.image=${IMAGE}`);
    // An inert workload, not the image's own command: nothing runs as root before the protections.
    expect(create.slice(-2)).toEqual(['--', 'true']);
    // Never smolvm's own escape hatches.
    for (const f of ['--allow-system-mounts', '--ssh-agent', '--docker-socket', '--nested', '--use-host-proxy']) expect(create).not.toContain(f);
    expect(sp.spawn).toHaveBeenCalledTimes(1);
  });

  it('is started behind the egress interceptor, whose token goes in the environment and never on the command line', async () => {
    const { rt, smolvm, egress } = runtime();
    await rt.launch(specOf(), cmd());
    const start = smolvm.calls.find((c) => c.args[1] === 'start')!;
    expect(start.args).toContain('--mediated-egress');
    expect(flag(start.args, '--egress-interceptor')).toBe('127.0.0.1:47001');
    expect(start.env?.SMOLVM_INTERCEPTOR_TOKEN).toBe('a'.repeat(64));
    expect(start.args.join(' ')).not.toContain('a'.repeat(64));
    expect(egress.ensure).toHaveBeenCalledWith(machineNameOf(workspace), expect.objectContaining({ network: expect.any(Object) }));
  });

  it('is given the policy\'s allow list before it starts, from an empty one', async () => {
    const { rt, smolvm } = runtime();
    const spec = specOf();
    await rt.launch(spec, cmd());
    const update = smolvm.calls.find((c) => c.args[1] === 'update')!.args;
    expect(update).toEqual(['machine', 'update', '--name', machineNameOf(workspace), ...allowListArgs(spec.network)]);
    const v = smolvm.verbs();
    expect(v.indexOf('update')).toBeLessThan(v.indexOf('start'));
  });

  it('is reused when it exists with the same image: started, not created again', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: { state: 'stopped', image: IMAGE, labels: { 'agenfk.workspace': workspace, 'agenfk.image': IMAGE } } } });
    await runtime({ smolvm }).rt.launch(specOf(), cmd());
    expect(smolvm.verbs()).not.toContain('create');
    expect(smolvm.verbs()).not.toContain('delete');
    expect(smolvm.verbs()).toContain('start');
  });

  it('is made again when the base image changed', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: { state: 'stopped', image: 'old', labels: { 'agenfk.workspace': workspace, 'agenfk.image': 'old' } } } });
    await runtime({ smolvm }).rt.launch(specOf(), cmd());
    const v = smolvm.verbs();
    expect(v.indexOf('delete')).toBeGreaterThanOrEqual(0);
    expect(v.indexOf('delete')).toBeLessThan(v.indexOf('create'));
    expect(smolvm.machines.get(name)?.labels['agenfk.image']).toBe(IMAGE);
  });

  it('is refused when a machine of that name belongs to another workspace: nothing is started', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: { state: 'stopped', image: IMAGE, labels: { 'agenfk.workspace': '/somewhere/else', 'agenfk.image': IMAGE } } } });
    const { rt, sp } = runtime({ smolvm });
    await expect(rt.launch(specOf(), cmd())).rejects.toThrow(/\/somewhere\/else/);
    expect(smolvm.verbs()).not.toContain('start');
    expect(smolvm.verbs()).not.toContain('delete');
    // Not this workspace's machine: the failed launch's cleanup leaves it alone.
    expect(smolvm.verbs()).not.toContain('stop');
    expect(sp.spawn).not.toHaveBeenCalled();
  });

  it('is joined, not started again, while another session runs it', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: { state: 'running', image: IMAGE, labels: { 'agenfk.workspace': workspace, 'agenfk.image': IMAGE } } } });
    const egress = fakeEgress();
    smolvm.mounts.set(name, sameMounts());
    liveSession(name);
    const { rt, sp } = runtime({ smolvm, egress });
    await rt.launch(specOf(), cmd());
    expect(smolvm.verbs()).not.toContain('start');
    expect(egress.ensure).not.toHaveBeenCalled();
    expect(sp.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses a launch smolvm cannot start, with what smolvm said; nothing runs and nothing is left registered', async () => {
    const smolvm = fakeSmolvm({ startFails: 'Error: hypervisor refused' });
    const egress = fakeEgress();
    const { rt, sp } = runtime({ smolvm, egress });
    await expect(rt.launch(specOf(), cmd())).rejects.toThrow(/hypervisor refused/);
    expect(sp.spawn).not.toHaveBeenCalled();
    expect(egress.stop).toHaveBeenCalled();
    const sessions = path.join(stateDir, 'machines', machineNameOf(workspace), 'sessions');
    expect(fs.existsSync(sessions) ? fs.readdirSync(sessions) : []).toEqual([]);
  });
});

describe('guestPlanOf: what the guest sees', () => {
  const plan = (over: Partial<SandboxSession> = {}) => guestPlanOf(specOf(over), workspace);

  it('mounts the workspace and the client state read-write at their host paths, and no host temp dir', () => {
    const p = plan();
    const targets = p.mounts.map((m) => m.host);
    expect(targets).toContain(workspace);
    expect(targets).toContain(agentDir);
    expect(p.mounts.every((m) => m.guest === m.host && !m.readOnly)).toBe(true);
    // The guest has its own /tmp: the host's temp dirs are not shared.
    expect(targets).not.toContain(tmpDir);
    expect(targets.some((t) => t === '/tmp' || t === '/private/tmp')).toBe(false);
  });

  it('mounts a pi agent dir on its own though it sits in a host temp dir', () => {
    expect(plan({ piAgentDir: stagedDir }).mounts.map((m) => m.host)).toContain(stagedDir);
  });

  it('mounts a write root inside another one once, through the outer one', () => {
    const inner = path.join(workspace, 'sub');
    fs.mkdirSync(inner);
    const p = guestPlanOf({ ...specOf(), filesystem: { ...specOf().filesystem, allowWrite: [...specOf().filesystem.allowWrite, inner] } }, workspace);
    expect(p.mounts.map((m) => m.host)).not.toContain(inner);
  });

  it('never mounts the home dir or its credential stores', () => {
    const targets = plan().mounts.map((m) => m.host);
    expect(targets).not.toContain(home);
    expect(targets.some((t) => t.startsWith(path.join(home, '.ssh')))).toBe(false);
  });

  it('binds read-only what the spec keeps unwritable inside a mount: the project .agenfk, git hooks and config, pi extensions', () => {
    const ro = plan().readOnly;
    expect(ro).toContain(path.join(workspace, '.agenfk'));
    expect(ro).toContain(path.join(workspace, '.git', 'hooks'));
    expect(ro).toContain(path.join(workspace, '.git', 'config'));
    expect(ro).toContain(path.join(agentDir, 'extensions'));
  });

  it('finds the .agenfk directories below the workspace (the spec writes them as a glob), but not inside node_modules', () => {
    const ro = plan().readOnly;
    expect(ro).toContain(path.join(workspace, 'packages', 'a', '.agenfk'));
    expect(ro).not.toContain(path.join(workspace, 'node_modules', 'dep', '.agenfk'));
    expect(ro.some((p) => p.includes('*'))).toBe(false);
  });

  it('does not list protections outside every mount: nothing there is visible to bind', () => {
    const ro = plan().readOnly;
    expect(ro).not.toContain(path.join(home, '.agenfk'));
    expect(ro).not.toContain(path.join(home, '.agenfk-system'));
  });

  it('hides what the spec keeps unreadable inside a mount: pi\'s auth.json', () => {
    expect(plan().hidden).toEqual([{ path: path.join(agentDir, 'auth.json'), kind: 'file' }]);
  });

  it('holds the git paths that do not exist yet with placeholders git accepts, so none can be planted', () => {
    const ph = plan().placeholders;
    const git = path.join(workspace, '.git');
    expect(ph).toContainEqual({ path: path.join(git, 'commondir'), kind: 'file', content: '.\n' });
    expect(ph).toContainEqual({ path: path.join(git, 'config.worktree'), kind: 'file', content: '' });
    expect(ph).toContainEqual({ path: path.join(git, 'modules'), kind: 'dir' });
    expect(ph).toContainEqual({ path: path.join(git, 'worktrees'), kind: 'dir' });
    // Each placeholder is bound read-only too.
    for (const p of ph) expect(plan().readOnly).toContain(p.path);
  });

  it('leaves a git path that exists alone: no placeholder over a real worktrees dir', () => {
    fs.mkdirSync(path.join(workspace, '.git', 'worktrees'));
    expect(plan().placeholders.map((p) => p.path)).not.toContain(path.join(workspace, '.git', 'worktrees'));
    expect(plan().readOnly).toContain(path.join(workspace, '.git', 'worktrees'));
  });
});

describe('a session in the machine', () => {
  it('joins a machine holding exactly its own mounts without mounting anything again', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name);
    await runtime({ smolvm }).rt.launch(specOf(), cmd());
    expect(smolvm.calls.filter((c) => c.args[1] === 'mount' && c.args[2] === 'add')).toEqual([]);
  });

  it('attaches the mounts a machine it starts does not hold yet', async () => {
    const { rt, smolvm } = runtime();
    await rt.launch(specOf(), cmd());
    const added = smolvm.calls.filter((c) => c.args[1] === 'mount' && c.args[2] === 'add').map((c) => flag(c.args, '-v', '--volume'));
    expect(added.sort()).toEqual(sameMounts().map((m) => `${m.source}:${m.target}`).sort());
  });

  it('applies the protections as root in the guest before the session starts', async () => {
    const { rt, smolvm, sp } = runtime();
    await rt.launch(specOf(), cmd());
    const setup = smolvm.calls.find((c) => c.args[1] === 'exec' && flag(c.args, '-u', '--user') === 'root');
    expect(setup).toBeTruthy();
    const script = setup!.args.join(' ');
    expect(script).toContain(path.join(workspace, '.git', 'hooks'));
    expect(script).toContain(path.join(agentDir, 'auth.json'));
    expect(script).toMatch(/remount,bind,ro/);
    // The setup ran before the session was spawned.
    expect(smolvm.run.mock.invocationCallOrder[smolvm.calls.indexOf(setup!)]).toBeLessThan(sp.spawn.mock.invocationCallOrder[0]);
  });

  it('creates the git placeholders on the host for the session and removes them when it ends', async () => {
    const { rt, sp } = runtime();
    const commondir = path.join(workspace, '.git', 'commondir');
    const launched = await rt.launch(specOf(), cmd());
    expect(fs.readFileSync(commondir, 'utf8')).toBe('.\n');
    expect(fs.statSync(path.join(workspace, '.git', 'worktrees')).isDirectory()).toBe(true);
    sp.children[0].finish(0);
    await launched.exited;
    expect(fs.existsSync(commondir)).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.git', 'worktrees'))).toBe(false);
  });

  it('runs the command as the host user, in its folder, with the spec\'s env and nothing else of the host\'s but the terminal\'s', async () => {
    const { rt, sp } = runtime();
    const spec = specOf();
    await rt.launch(spec, cmd());
    const [file, args] = sp.spawn.mock.calls[0] as unknown as [string, string[]];
    expect(file).toMatch(/smolvm$/);
    expect(args.slice(0, 2)).toEqual(['machine', 'exec']);
    expect(flag(args, '--name')).toBe(machineNameOf(workspace));
    expect(flag(args, '-u', '--user')).toBe('503:20');
    expect(flag(args, '-w', '--workdir')).toBe(workspace);
    expect(args).toContain('-i');
    const env = args.flatMap((a, i) => (args[i - 1] === '-e' ? [a] : []));
    for (const [k, v] of Object.entries(spec.env)) expect(env).toContain(`${k}=${v}`);
    expect(env).toContain(`HOME=${home}`);
    expect(env).toContain('TMPDIR=/tmp');
    expect(env).toContain('TERM=xterm-256color');
    expect(env).toContain('LANG=en_US.UTF-8');
    expect(env.some((e) => e.startsWith('OPENAI_API_KEY='))).toBe(false);
    expect(env.some((e) => e.startsWith('PATH='))).toBe(false);
    const tail = args.slice(args.indexOf('--') + 1);
    expect(tail[0]).toBe('setsid');
    expect(tail.slice(-2)).toEqual(['pi', '--approve']);
  });

  it('gives the session a terminal only when there is one', async () => {
    const noTty = runtime();
    const first = await noTty.rt.launch(specOf(), cmd());
    expect((noTty.sp.spawn.mock.calls[0] as unknown as [string, string[]])[1]).not.toContain('-t');
    noTty.sp.children[0].finish(0);
    await first.exited;
    const tty = runtime({ isTTY: true });
    await tty.rt.launch(specOf(), cmd());
    const args = (tty.sp.spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toContain('-t');
    // The session leader takes the terminal, so Ctrl-C reaches the agent.
    expect(args.slice(args.indexOf('--') + 1).slice(0, 2)).toEqual(['setsid', '-c']);
  });

  it('exits with the command\'s exit code', async () => {
    const { rt, sp } = runtime();
    const launched = await rt.launch(specOf(), cmd());
    sp.children[0].finish(7);
    expect(await launched.exited).toEqual({ code: 7, signal: null });
  });

  it('signals the command\'s process group inside the guest: signalling the host side alone leaves it running', async () => {
    const { rt, smolvm } = runtime();
    const launched = await rt.launch(specOf(), cmd());
    expect(launched.kill('SIGTERM')).toBe(true);
    await settle();
    const kill = smolvm.execs().find((a) => a.join(' ').includes('kill -TERM'));
    expect(kill).toBeTruthy();
    expect(flag(kill!, '-u', '--user')).toBe('503:20');
  });

  it('ends what the command left running, then stops the machine and its interceptor when the last session leaves', async () => {
    const { rt, smolvm, sp, egress } = runtime();
    const launched = await rt.launch(specOf(), cmd());
    sp.children[0].finish(0);
    await launched.exited;
    expect(smolvm.execs().some((a) => a.join(' ').includes('kill -KILL'))).toBe(true);
    expect(smolvm.verbs()).toContain('stop');
    expect(egress.stop).toHaveBeenCalledWith(machineNameOf(workspace));
  });

  it('keeps the machine running while another session is in it', async () => {
    const smolvm = fakeSmolvm();
    const egress = fakeEgress();
    const a = runtime({ smolvm, egress });
    const b = runtime({ smolvm, egress, pidAlive: () => true });
    const first = await a.rt.launch(specOf(), cmd());
    const second = await b.rt.launch(specOf(), cmd());
    a.sp.children[0].finish(0);
    await first.exited;
    expect(smolvm.verbs()).not.toContain('stop');
    b.sp.children[0].finish(0);
    await second.exited;
    expect(smolvm.verbs()).toContain('stop');
  });

  it('does not count a session whose process is gone', async () => {
    const sessions = path.join(stateDir, 'machines', machineNameOf(workspace), 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'stale.json'), JSON.stringify({ pid: 999999 }));
    const { rt, smolvm, sp } = runtime();
    const launched = await rt.launch(specOf(), cmd());
    sp.children[0].finish(0);
    await launched.exited;
    expect(smolvm.verbs()).toContain('stop');
  });

  it('still hands over the decisions the interceptor writes as the machine stops', async () => {
    const egress = fakeEgress();
    egress.stop.mockImplementation(async () => { egress.emit({ host: 'last.example.com', port: null, decision: 'deny', rule: 'not-on-allow-list' }); });
    const { rt, sp } = runtime({ egress });
    const seen: string[] = [];
    const launched = await rt.launch(specOf(), cmd(), { onProxyDecision: (d) => seen.push(d.host) });
    sp.children[0].finish(0);
    await launched.exited;
    expect(seen).toContain('last.example.com');
  });

  it('hands the interceptor\'s decisions to the hook while it runs; a hook that throws changes nothing', async () => {
    const { rt, sp, egress } = runtime();
    const seen: ProxyDecision[] = [];
    const launched = await rt.launch(specOf(), cmd(), {
      onProxyDecision: (d) => { seen.push(d); if (d.host === 'boom') throw new Error('hook failed'); },
    });
    egress.emit({ host: 'db.example.com', port: 5432, decision: 'allow', rule: 'observe' });
    expect(() => egress.emit({ host: 'boom', port: 443, decision: 'deny', rule: 'deny-list' })).not.toThrow();
    sp.children[0].finish(0);
    await launched.exited;
    expect(seen.map((d) => d.host)).toEqual(['db.example.com', 'boom']);
    expect(egress.unwatched).toBe(1);
  });
});

/**
 * CGLAB-696 task 7: a linked git worktree. Its .git is a file naming its git dir in the main
 * checkout (<common>/worktrees/<name>), outside the workspace: the machine mounts the common git
 * dir too, protected as a main checkout's is, the worktree's own git dir writable (index, HEAD),
 * and the other worktrees' metadata hidden.
 */
describe.skipIf(process.platform === 'win32')('guestPlanOf: a linked git worktree (CGLAB-696 task 7)', () => {
  let main: string;
  let common: string;
  let wt: string;
  let wtGit: string;
  const git = (dir: string, ...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  };
  beforeEach(() => {
    main = path.join(root, 'work', 'main');
    fs.mkdirSync(main, { recursive: true });
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'first');
    wt = path.join(root, 'work', 'wt');
    git(main, 'worktree', 'add', '-q', wt);
    git(main, 'worktree', 'add', '-q', path.join(root, 'work', 'other'));
    common = fs.realpathSync(path.join(main, '.git'));
    wtGit = path.join(common, 'worktrees', 'wt');
  });
  const plan = () => guestPlanOf(specOf({ workspace: wt, gitDir: null }), wt);

  it('mounts the common git dir beside the worktree, and nothing else of the main checkout', () => {
    const roots = plan().mounts.map((m) => m.host);
    expect(roots).toEqual(expect.arrayContaining([wt, common]));
    expect(roots).not.toContain(main);
  });

  it('protects the common git dir as a main checkout\'s, and what points the worktree at it', () => {
    const p = plan();
    expect(p.readOnly).toEqual(expect.arrayContaining([
      path.join(wt, '.git'), path.join(common, 'config'), path.join(common, 'hooks'),
      path.join(common, 'worktrees'), path.join(wtGit, 'commondir'), path.join(wtGit, 'gitdir'),
    ]));
    expect(p.placeholders).toContainEqual({ path: path.join(wtGit, 'config.worktree'), kind: 'file', content: '' });
    expect(p.pinned).toContain(common);
  });

  it('keeps the worktree\'s own git dir writable: its index and HEAD are the session\'s commits', () => {
    expect(plan().readOnly).not.toContain(wtGit);
    // Bound writable over the read-only worktrees dir: a bind made below a read-only one is read-only (measured).
    expect(plan().writable).toEqual([wtGit]);
  });

  it('hides the other worktrees\' metadata', () => {
    expect(plan().hidden).toContainEqual({ path: path.join(common, 'worktrees', 'other'), kind: 'dir' });
    expect(plan().hidden.map((h) => h.path)).not.toContain(wtGit);
  });

  it('binds the worktree\'s git dir writable over the read-only worktrees dir: the read-only one first', () => {
    const script = guestSetupScript(plan(), 503, 20);
    const ro = script.indexOf(`ro '${path.join(common, 'worktrees')}'`);
    const rw = script.indexOf(`rw '${wtGit}'`);
    expect(ro).toBeGreaterThan(-1);
    expect(rw).toBeGreaterThan(ro);
    expect(script).toMatch(/rw\(\) \{[^}]*remount,bind,rw/);
  });

  it('a main checkout has nothing bound writable', () => {
    expect(guestPlanOf(specOf(), workspace).writable).toEqual([]);
  });

  it('protects what else in the common dir host git reads or runs: commondir, config.worktree, info, modules (review 01a18d52)', () => {
    const p = plan();
    expect(p.readOnly).toEqual(expect.arrayContaining([path.join(common, 'info'), path.join(common, 'commondir'), path.join(common, 'config.worktree'), path.join(common, 'modules')]));
    expect(p.placeholders).toEqual(expect.arrayContaining([
      { path: path.join(common, 'commondir'), kind: 'file', content: '.\n' },
      { path: path.join(common, 'config.worktree'), kind: 'file', content: '' },
      { path: path.join(common, 'modules'), kind: 'dir' },
    ]));
  });

  it('keeps the main checkout\'s own index, HEAD and reflog read-only (review 01a18d52)', () => {
    fs.mkdirSync(path.join(common, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(common, 'logs', 'HEAD'), '');
    expect(plan().readOnly).toEqual(expect.arrayContaining([path.join(common, 'index'), path.join(common, 'HEAD'), path.join(common, 'logs', 'HEAD')].filter((f) => fs.existsSync(f))));
    expect(plan().readOnly).toContain(path.join(common, 'HEAD'));
  });

  it('a protected link into the worktree\'s own git dir keeps its target read-only, bound after the writable one (review 01a18d52)', () => {
    fs.writeFileSync(path.join(wtGit, 'hook-script'), '#!/bin/sh\n');
    fs.symlinkSync(path.join(wtGit, 'hook-script'), path.join(common, 'hooks', 'pre-commit'));
    const p = plan();
    expect(p.readOnly).toContain(path.join(wtGit, 'hook-script'));
    const script = guestSetupScript(p, 503, 20);
    expect(script.indexOf(`ro '${path.join(wtGit, 'hook-script')}'`)).toBeGreaterThan(script.indexOf(`rw '${wtGit}'`));
  });

  it('pins the directories between such a target and the writable git dir: none can be swapped (review 01a18d52, pass 2)', () => {
    fs.mkdirSync(path.join(wtGit, 'scripts'));
    fs.writeFileSync(path.join(wtGit, 'scripts', 'pre-commit'), '#!/bin/sh\n');
    fs.symlinkSync(path.join(wtGit, 'scripts', 'pre-commit'), path.join(common, 'hooks', 'pre-commit'));
    const p = plan();
    expect(p.readOnly).toContain(path.join(wtGit, 'scripts', 'pre-commit'));
    expect([...p.pinned, ...p.readOnly]).toContain(path.join(wtGit, 'scripts'));
  });

  it('refuses a pointer whose path runs through a symbolic link: the link could be repointed (review 01a18d52, pass 2)', () => {
    fs.symlinkSync(common, path.join(wt, 'via'));
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(wt, 'via', 'worktrees', 'wt')}\n`);
    expect(() => plan()).toThrow(/linked git worktree/);
  });

  it('protects what the main checkout\'s own config pulls in (its config.worktree included) (review 01a18d52, pass 2)', () => {
    fs.writeFileSync(path.join(common, 'extra.conf'), '[alias]\n');
    git(main, 'config', 'extensions.worktreeConfig', 'true');
    git(main, 'config', '--worktree', 'include.path', path.join(common, 'extra.conf'));
    expect(plan().readOnly).toContain(path.join(common, 'extra.conf'));
  });

  it('refuses a worktree of a repository whose git dir lives apart (--separate-git-dir): its main checkout\'s config cannot be found (review 01a18d52, pass 3)', () => {
    const sep = path.join(root, 'work', 'sep');
    const meta = path.join(root, 'meta');
    spawnSync('git', ['init', '-q', `--separate-git-dir=${meta}`, sep]);
    git(sep, 'commit', '-q', '--allow-empty', '-m', 'first');
    const sepWt = path.join(root, 'work', 'sep-wt');
    git(sep, 'worktree', 'add', '-q', sepWt);
    expect(() => guestPlanOf(specOf({ workspace: sepWt, gitDir: null }), sepWt)).toThrow(/linked git worktree.*apart/s);
  });

  it('refuses a .git that names another worktree\'s git dir: the git dir must name this worktree back (review 01a18d52)', () => {
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(common, 'worktrees', 'other')}\n`);
    expect(() => plan()).toThrow(/linked git worktree/);
  });

  it('refuses a worktree whose git dir does not lead back to the common dir it sits in', () => {
    fs.writeFileSync(path.join(wtGit, 'commondir'), '/somewhere/else\n');
    expect(() => plan()).toThrow(/linked git worktree/);
  });
});

/**
 * CGLAB-696 task 8: the machine's resolver (guestDns.ts) and the guest firewall that keeps the
 * session on it, set up by root before the session. An image without what they need (iptables,
 * node) cannot have them: enforce refuses, observe warns.
 */
/** Story review: what several sessions of one repository share, and what a crash leaves. */
describe('sessions sharing a machine, and crashes (CGLAB-696 story review)', () => {
  it('a second session under the same policy joins, though its relay to the server has another port', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name, 'other', specOf({ serverPort: 4000 }).network);
    const { rt, sp } = runtime({ smolvm });
    await rt.launch(specOf({ serverPort: 5000 }), cmd());
    expect(sp.spawn).toHaveBeenCalledTimes(1);
  });

  it('a session under another policy still waits its turn', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name, 'other', buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['example.org'] } }), session()).network);
    await expect(runtime({ smolvm }).rt.launch(specOf(), cmd())).rejects.toThrow(/different network policy/);
  });

  it('hidden files read as {}: a client takes its hidden auth.json for no logins, not a broken file', () => {
    expect(guestSetupScript(guestPlanOf(specOf(), workspace), 503, 20)).toMatch(/printf '\{\}\\n' > \/run\/agenfk\/hide\/empty/);
  });

  it('a machine lock with no owner in it (a launcher killed while taking it) does not block the next launch', async () => {
    const name = machineNameOf(workspace);
    const lock = path.join(stateDir, 'machines', name, 'lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    const { rt, sp } = runtime();
    await rt.launch(specOf(), cmd());
    expect(sp.spawn).toHaveBeenCalledTimes(1);
  });
});

/**
 * CGLAB-696 task 9: the agenfk adapters run inside the machine. The guest has no ~/.agenfk of its
 * own: root gives the session one it cannot write, holding the host's hook scripts, policy state
 * and workflow token; and marks the machine, which is how the adapters know they are inside one.
 */
describe('the agenfk adapters in the machine (CGLAB-696 task 9)', () => {
  const agenfkDir = () => path.join(home, '.agenfk');
  // The running CLI's own hook scripts (its install's bin/), not whatever ~/.agenfk/bin holds: review.
  const hooksDir = () => path.join(root, 'install', 'bin');
  const HOOKS = ['agenfk-airlock.mjs', 'agenfk-gatekeeper.mjs', 'agenfk-mcp-enforcer.mjs', 'agenfk-pr-hook.mjs'];
  const withHooks = (over: Record<string, unknown> = {}) => runtime({ hookScriptsDir: hooksDir(), ...over });
  const copies = (smolvm: ReturnType<typeof fakeSmolvm>) => smolvm.calls.filter((c) => c.args[1] === 'cp').map((c) => c.args);
  const target = (a: string[]) => a[a.length - 1];
  const rootScripts = (smolvm: ReturnType<typeof fakeSmolvm>) => smolvm.execs().filter((a) => flag(a, '-u') === 'root').map((a) => a[a.length - 1]);

  beforeEach(() => {
    fs.mkdirSync(path.join(agenfkDir(), 'bin'), { recursive: true });
    fs.mkdirSync(path.join(agenfkDir(), 'airlock'), { recursive: true });
    // An older install's scripts in ~/.agenfk/bin: never what the machine gets.
    fs.writeFileSync(path.join(agenfkDir(), 'bin', 'agenfk-airlock.mjs'), '// old\n');
    fs.mkdirSync(hooksDir(), { recursive: true });
    for (const f of HOOKS) fs.writeFileSync(path.join(hooksDir(), f), 'export {};\n');
    fs.writeFileSync(path.join(hooksDir(), 'not-a-hook.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(agenfkDir(), 'airlock-state.json'), '{"mode":"enforce"}\n');
    fs.writeFileSync(path.join(agenfkDir(), 'verify-token'), 'tok\n');
    // Not for the session: the server's config, the proxy reports' token, a link out of bin.
    fs.writeFileSync(path.join(agenfkDir(), 'config.json'), '{}\n');
    fs.writeFileSync(path.join(agenfkDir(), 'airlock', 'token'), 'secret\n');
  });

  it('marks the machine: root leaves a read-only /run/agenfk/machine', () => {
    const script = guestSetupScript(guestPlanOf(specOf(), workspace), 503, 20);
    expect(script).toContain('/run/agenfk/machine');
    expect(script).toMatch(/chmod 444 \/run\/agenfk\/machine/);
  });

  it('gives a client session the CLI\'s own hook scripts, the host\'s policy state and token, in a ~/.agenfk root owns, before it starts', async () => {
    const { rt, smolvm, sp } = withHooks();
    await rt.launch(specOf(), cmd());
    const name = machineNameOf(workspace);
    const g = agenfkDir();
    const made = rootScripts(smolvm).find((x) => x.includes(`mount -t tmpfs`) && x.includes(g));
    expect(made).toBeDefined();
    // Made before anything is copied in, and all of it before the session starts.
    const order = smolvm.calls.map((c) => (c.args[1] === 'cp' ? 'cp' : c.args[c.args.length - 1] === made ? 'made' : ''));
    expect(order.indexOf('made')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('made')).toBeLessThan(order.indexOf('cp'));
    expect(sp.spawn).toHaveBeenCalledTimes(1);
    const c = copies(smolvm);
    expect(c.map(target).sort()).toEqual([
      `${name}:${g}/airlock-state.json`, ...HOOKS.map((f) => `${name}:${g}/bin/${f}`), `${name}:${g}/verify-token`,
    ]);
    for (const a of c) {
      const file = target(a).slice(name.length + 1);
      const from = path.dirname(file) === path.join(g, 'bin') ? path.join(hooksDir(), path.basename(file)) : file;
      expect(a[a.length - 2], file).toBe(from);
      if (file.endsWith('verify-token')) {
        // The session's group may read it; nobody in the machine may write it.
        expect([flag(a, '--mode'), flag(a, '--uid'), flag(a, '--gid')]).toEqual(['440', '0', '20']);
      } else {
        expect(flag(a, '--mode'), file).toBe('444');
        expect(flag(a, '--uid'), file).toBeUndefined();
      }
    }
  });

  it('copies only what the host has: no token or policy state yet still launches', async () => {
    fs.rmSync(path.join(agenfkDir(), 'verify-token'));
    fs.rmSync(path.join(agenfkDir(), 'airlock-state.json'));
    const { rt, smolvm, sp } = withHooks();
    await rt.launch(specOf(), cmd());
    expect(copies(smolvm).map((a) => path.basename(target(a))).sort()).toEqual([...HOOKS].sort());
    expect(sp.spawn).toHaveBeenCalledTimes(1);
  });

  // Review (task 9): the adapters trust the state file over a cached answer when it is newer; in the
  // machine it is a copy, so it must follow the host's while the session runs.
  /** A smolvm whose state copies record what the host's file held when each was made (null: a refused one). */
  function stateRecorder(fails: () => boolean = () => false) {
    const smolvm = fakeSmolvm();
    const sent: Array<string | null> = [];
    const run = vi.fn(async (args: string[], o?: { env?: NodeJS.ProcessEnv }) => {
      if (args[1] === 'cp' && args[args.length - 1].endsWith('/airlock-state.json')) {
        if (fails()) { sent.push(null); return { code: 1, stdout: '', stderr: 'machine gone' }; }
        sent.push(fs.readFileSync(args[args.length - 2], 'utf8'));
      }
      return smolvm.run(args, o);
    });
    return { smolvm: { ...smolvm, run }, sent };
  }
  const REV3 = '{"mode":"enforce","revision":3}\n';

  it('keeps the session\'s policy state current while it runs, and stops when it ends', async () => {
    const { smolvm, sent } = stateRecorder();
    const { rt, sp } = withHooks({ policyFollowMs: 10, smolvm });
    const launched = await rt.launch(specOf(), cmd());
    fs.writeFileSync(path.join(agenfkDir(), 'airlock-state.json'), REV3);
    await vi.waitFor(() => expect(sent).toContain(REV3), { timeout: 2000 });
    sp.children[0].finish(0);
    await launched.exited;
    const after = sent.length;
    fs.writeFileSync(path.join(agenfkDir(), 'airlock-state.json'), '{"mode":"off","revision":4}\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.length).toBe(after);
  });

  it('catches up with a change made while the session was still starting', async () => {
    const { smolvm, sent } = stateRecorder();
    // Changed right after the first copy, before the session's follower runs.
    const run = smolvm.run;
    let changed = false;
    const racing = vi.fn(async (args: string[], o?: { env?: NodeJS.ProcessEnv }) => {
      const r = await run(args, o);
      if (!changed && args[1] === 'cp' && args[args.length - 1].endsWith('/airlock-state.json')) {
        changed = true;
        fs.writeFileSync(path.join(agenfkDir(), 'airlock-state.json'), REV3);
      }
      return r;
    });
    const { rt, sp } = withHooks({ policyFollowMs: 10, smolvm: { ...smolvm, run: racing } });
    const launched = await rt.launch(specOf(), cmd());
    await vi.waitFor(() => expect(sent).toContain(REV3), { timeout: 2000 });
    sp.children[0].finish(0);
    await launched.exited;
  });

  it('says so once when the policy state could not be brought up to date, and tries again until it is', async () => {
    const warnings: string[] = [];
    let refusals = 0;
    const { smolvm, sent } = stateRecorder(() => refusals-- > 0);
    const { rt, sp } = withHooks({ policyFollowMs: 10, smolvm, warn: (m: string) => warnings.push(m) });
    const launched = await rt.launch(specOf(), cmd());
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(1), { timeout: 2000 });
    refusals = 5;
    fs.writeFileSync(path.join(agenfkDir(), 'airlock-state.json'), REV3);
    // No other change on the host: the copy is tried again until it lands.
    await vi.waitFor(() => expect(sent.at(-1)).toBe(REV3), { timeout: 2000 });
    expect(sent.filter((x) => x === null).length).toBe(5);
    expect(warnings.filter((w) => /policy state/.test(w))).toHaveLength(1);
    sp.children[0].finish(0);
    await launched.exited;
  });

  it('refuses to launch without the CLI\'s hook scripts: the session\'s gate could not work', async () => {
    fs.rmSync(path.join(hooksDir(), 'agenfk-gatekeeper.mjs'));
    const { rt, sp } = withHooks();
    await expect(rt.launch(specOf(), cmd())).rejects.toThrow(/agenfk-gatekeeper\.mjs/);
    expect(sp.spawn).not.toHaveBeenCalled();
  });

  it('gives a command the server runs none of it: it is no agent, and needs no token', async () => {
    const { rt, smolvm } = withHooks();
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce' }),
      session({ purpose: 'command', inferenceHosts: [], serverPort: 0, piAgentDir: undefined }));
    await rt.launch(spec, { file: '/bin/sh', args: ['-c', 'true'], cwd: workspace, processGroup: false });
    expect(copies(smolvm)).toEqual([]);
  });
});

describe('the machine\'s resolver (CGLAB-696 task 8)', () => {
  const rootScripts = (smolvm: ReturnType<typeof fakeSmolvm>) => smolvm.execs().filter((a) => flag(a, '-u') === 'root').map((a) => a[a.length - 1]);

  it('is set up by root, with the policy\'s denied names, before the session starts', async () => {
    const { rt, smolvm, sp } = runtime();
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'observe', hosts: { allow: [], deny: ['evil.example'] } }), session());
    await rt.launch(spec, cmd());
    const setup = rootScripts(smolvm).join('\n');
    expect(setup).toContain(DNS_RESOLVER_ADDRESS);
    expect(setup).toContain('evil.example');
    const at = smolvm.run.mock.invocationCallOrder[smolvm.calls.findIndex((c) => c.args[1] === 'exec' && c.args.join(' ').includes(DNS_RESOLVER_ADDRESS))];
    expect(at).toBeLessThan(sp.spawn.mock.invocationCallOrder[0]);
  });

  it('enforce: an image that cannot run it refuses the launch, saying why; nothing runs', async () => {
    const smolvm = fakeSmolvm({ execStdout: (a) => (a.join(' ').includes(DNS_RESOLVER_ADDRESS) ? `${DNS_UNPROTECTED_MARK} iptables\n` : '') });
    const { rt, sp } = runtime({ smolvm });
    await expect(rt.launch(specOf(), cmd())).rejects.toThrow(/DNS.*iptables/s);
    expect(sp.spawn).not.toHaveBeenCalled();
  });

  it('observe: it warns, and the session runs', async () => {
    const warnings: string[] = [];
    const smolvm = fakeSmolvm({ execStdout: (a) => (a.join(' ').includes(DNS_RESOLVER_ADDRESS) ? `${DNS_UNPROTECTED_MARK} node\n` : '') });
    const { rt, sp } = runtime({ smolvm, warn: (m: string) => warnings.push(m) });
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'observe' }), session());
    await rt.launch(spec, cmd());
    expect(sp.spawn).toHaveBeenCalled();
    expect(warnings.join('\n')).toMatch(/DNS.*node/s);
  });

  it('runs as a user the session is not: another uid when the host user\'s is the usual one (review 01a18ddc)', () => {
    const net = { allow: [], deny: [], denyResolved: [], mode: 'enforce' as const };
    expect(guestDnsScript(net, '', 503)).toContain('"uid":997');
    expect(guestDnsScript(net, '', 997)).not.toContain('"uid":997');
    expect(guestDnsScript(net, '', 997)).toContain('"uid":996');
  });

  it('only names go to it: addresses and ranges are the decider\'s', () => {
    expect(resolverDenyOf({ allow: [], deny: ['evil.example', '*.ioc.test', '10.0.0.1', '*'], denyResolved: ['10.0.0.0/8'], mode: 'enforce' })).toEqual(['evil.example', '*.ioc.test', '*']);
  });
});

describe('guestPlanOf: what the session cannot move aside or plant', () => {
  it('pins the workspace .git, so it cannot be renamed and replaced around its read-only hooks and config', () => {
    const p = guestPlanOf(specOf(), workspace);
    expect(p.pinned).toContain(path.join(workspace, '.git'));
    expect(p.readOnly).not.toContain(path.join(workspace, '.git'));
  });

  it('pins every directory between a protected path and its mount root, so none can carry a bind away', () => {
    fs.mkdirSync(path.join(workspace, '.claude', 'commands'), { recursive: true });
    const p = guestPlanOf(specOf(), workspace);
    // packages/a/.agenfk: renaming packages/a would leave packages/a/.agenfk free to plant.
    expect(p.pinned).toContain(path.join(workspace, 'packages'));
    expect(p.pinned).toContain(path.join(workspace, 'packages', 'a'));
    expect(p.pinned).toContain(path.join(workspace, '.claude'));
    // Never a mount root.
    expect(p.pinned).not.toContain(workspace);
    expect(p.pinned).not.toContain(agentDir);
  });

  it('lists pins and read-only binds outer first: a bind over a directory hides the binds inside it', () => {
    const p = guestPlanOf(specOf(), workspace);
    const depth = (x: string) => x.split(path.sep).length;
    for (const list of [p.pinned, p.readOnly]) {
      expect(list.map(depth)).toEqual([...list.map(depth)].sort((a, b) => a - b));
    }
  });

  it('never pins a read-only path: an overlapping protection keeps .claude/commands read-only', () => {
    fs.mkdirSync(path.join(workspace, '.claude', 'commands', 'tool', '.agenfk'), { recursive: true });
    const p = guestPlanOf(specOf(), workspace);
    const commands = path.join(workspace, '.claude', 'commands');
    expect(p.readOnly).toContain(commands);
    expect(p.readOnly).toContain(path.join(commands, 'tool', '.agenfk'));
    expect(p.pinned).not.toContain(commands);
    expect(p.pinned).not.toContain(path.join(commands, 'tool'));
    expect(p.pinned).toContain(path.join(workspace, '.claude'));
  });

  it('refuses to mount the home folder, or anything above it', () => {
    expect(() => guestPlanOf(specOf({ workspace: home }), home)).toThrow(/whole home folder/);
  });

  it('refuses a write root that is, or is inside, a protected path: a bind on a mount root protects nothing', () => {
    const state = path.join(home, '.agenfk', 'proj');
    fs.mkdirSync(state, { recursive: true });
    expect(() => guestPlanOf(specOf({ workspace: state }), state)).toThrow(/\.agenfk/);
  });

  it('refuses a write root in the directory of a protected pattern: ~/.ssh by ~/.ssh/id_*', () => {
    const ssh = path.join(home, '.ssh');
    expect(() => guestPlanOf(specOf({ workspace: ssh }), ssh)).toThrow(/\.ssh/);
  });

  it('hides what a last-segment pattern matches inside the mounts', () => {
    const keys = path.join(workspace, 'keys');
    fs.mkdirSync(keys);
    for (const f of ['secret-a', 'secret-b', 'public']) fs.writeFileSync(path.join(keys, f), 'fake');
    const spec = specOf();
    const p = guestPlanOf({ ...spec, filesystem: { ...spec.filesystem, denyRead: [...spec.filesystem.denyRead, path.join(keys, 'secret-*')] } }, workspace);
    const hidden = p.hidden.map((h) => h.path);
    expect(hidden).toEqual(expect.arrayContaining([path.join(keys, 'secret-a'), path.join(keys, 'secret-b')]));
    expect(hidden).not.toContain(path.join(keys, 'public'));
  });

  it('refuses a protection pattern it cannot match, rather than dropping it', () => {
    const spec = specOf();
    const bad = { ...spec, filesystem: { ...spec.filesystem, denyWrite: [...spec.filesystem.denyWrite, path.join(workspace, '*', 'x', 'y')] } };
    expect(() => guestPlanOf(bad, workspace)).toThrow(/cannot apply the protection/);
  });

  it('protects what a protected tree links to: a hook linking to a workspace script makes the script read-only', () => {
    fs.mkdirSync(path.join(workspace, 'scripts'));
    fs.writeFileSync(path.join(workspace, 'scripts', 'pre-commit.sh'), '#!/bin/sh\n');
    fs.symlinkSync('../../scripts/pre-commit.sh', path.join(workspace, '.git', 'hooks', 'pre-commit'));
    const p = guestPlanOf(specOf(), workspace);
    expect(p.readOnly).toContain(path.join(workspace, 'scripts', 'pre-commit.sh'));
    expect(p.pinned).toContain(path.join(workspace, 'scripts'));
  });

  it('follows links on from what a protected tree links to: a plugin dir and the file it links to', () => {
    const plugin = path.join(workspace, 'plugin');
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(workspace, 'payload.ts'), 'export {}\n');
    fs.symlinkSync('../payload.ts', path.join(plugin, 'main.ts'));
    fs.symlinkSync(plugin, path.join(agentDir, 'extensions', 'pkg'));
    const p = guestPlanOf(specOf(), workspace);
    expect(p.readOnly).toContain(plugin);
    expect(p.readOnly).toContain(path.join(workspace, 'payload.ts'));
  });

  it('refuses a protected tree linking to a whole write root, which cannot be made read-only', () => {
    fs.symlinkSync(workspace, path.join(agentDir, 'extensions', 'everything'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/whole write root/);
  });

  it('refuses a hidden file that has another name: it could be read by that one', () => {
    fs.linkSync(path.join(agentDir, 'auth.json'), path.join(agentDir, 'backup.json'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/hard link/);
  });

  it('refuses a hidden directory holding a file with another name', () => {
    const store = path.join(agentDir, 'store');
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(store, 'key'), 'fake');
    fs.linkSync(path.join(store, 'key'), path.join(agentDir, 'key-copy'));
    const spec = specOf();
    const p = { ...spec, filesystem: { ...spec.filesystem, denyRead: [...spec.filesystem.denyRead, store] } };
    expect(() => guestPlanOf(p, workspace)).toThrow(/hard link/);
  });

  it('walks a directory named objects inside a protected tree that is no git dir', () => {
    const objects = path.join(workspace, '.git', 'hooks', 'objects');
    fs.mkdirSync(objects);
    fs.writeFileSync(path.join(workspace, 'helper.sh'), '#!/bin/sh\n');
    fs.linkSync(path.join(workspace, 'helper.sh'), path.join(objects, 'helper'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/hard link/);
  });

  it('walks a protected tree to any depth', () => {
    let deep = path.join(agentDir, 'extensions');
    for (let i = 0; i < 12; i++) deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'payload.ts'), 'export {}\n');
    fs.linkSync(path.join(workspace, 'payload.ts'), path.join(deep, 'main.ts'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/hard link/);
  });

  it('walks a hidden directory to any depth for files with another name', () => {
    const store = path.join(agentDir, 'store');
    let deep = store;
    for (let i = 0; i < 12; i++) deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'key'), 'fake');
    fs.linkSync(path.join(deep, 'key'), path.join(agentDir, 'key-copy'));
    const spec = specOf();
    const p = { ...spec, filesystem: { ...spec.filesystem, denyRead: [...spec.filesystem.denyRead, store] } };
    expect(() => guestPlanOf(p, workspace)).toThrow(/hard link/);
  });

  it('refuses a hidden path that is a symbolic link', () => {
    fs.renameSync(path.join(agentDir, 'auth.json'), path.join(agentDir, 'saved.json'));
    fs.symlinkSync('saved.json', path.join(agentDir, 'auth.json'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/cannot hide .*symbolic link/);
  });

  it('protects the hooks dir git\'s core.hooksPath names, and the config files git reads', () => {
    fs.mkdirSync(path.join(workspace, '.githooks'));
    fs.writeFileSync(path.join(workspace, 'shared.gitconfig'), '[alias]\n');
    const included = [
      `file:${path.join(workspace, '.git', 'config')}`, 'core.hookspath\n.githooks',
      `file:${path.join(workspace, 'shared.gitconfig')}`, 'alias.st\nstatus',
      'file:/etc/gitconfig', 'core.autocrlf\ninput',
    ].join('\0') + '\0';
    const hooks = `file:${path.join(workspace, '.git', 'config')}\0core.hookspath\n.githooks\0`;
    const p = guestPlanOf(specOf(), workspace, () => ({ list: '', included, hooks, top: workspace }));
    expect(p.readOnly).toContain(path.join(workspace, '.githooks'));
    expect(p.readOnly).toContain(path.join(workspace, 'shared.gitconfig'));
    expect(p.readOnly).not.toContain('/etc/gitconfig');
  });

  it('refuses a core.hooksPath inside the mounts that does not exist: the session could create it', () => {
    const hooks = `file:${path.join(workspace, '.git', 'config')}\0core.hookspath\n.husky/_\0`;
    expect(() => guestPlanOf(specOf(), workspace, () => ({ list: '', included: hooks, hooks, top: workspace }))).toThrow(/core\.hooksPath/);
  });

  // Story review fix (task 10): host git runs these programs from the host (the server's git status
  // and diff, the user's own git); the session must not be able to rewrite one the config names.
  it('protects the programs git\'s config names inside the mounts: fsmonitor, textconv, helpers, aliases', () => {
    for (const f of ['tools/fsmon.sh', 'scripts/tc.sh', 'bin/cred', 'tools/a.sh', 'tools/space dir/x.sh']) {
      fs.mkdirSync(path.dirname(path.join(workspace, f)), { recursive: true });
      fs.writeFileSync(path.join(workspace, f), '#!/bin/sh\n');
    }
    const cfg = `file:${path.join(workspace, '.git', 'config')}`;
    const included = [
      cfg, 'core.fsmonitor\ntools/fsmon.sh',
      cfg, 'diff.mine.textconv\nscripts/tc.sh --flag',
      cfg, 'credential.https://example.com.helper\n!./bin/cred get',
      cfg, 'alias.go\n!tools/a.sh "$@"',
      cfg, 'filter.lfs.smudge\n"tools/space dir/x.sh" %f',
      // Not programs in the mounts: a boolean, a name git finds on PATH, a path outside.
      cfg, 'core.fsmonitor\ntrue',
      cfg, 'credential.helper\nosxkeychain',
      cfg, 'core.pager\n/usr/bin/less -R',
    ].join('\0') + '\0';
    const p = guestPlanOf(specOf(), workspace, () => ({ list: '', included, hooks: '', top: workspace }));
    for (const f of ['tools/fsmon.sh', 'scripts/tc.sh', 'bin/cred', 'tools/a.sh', 'tools/space dir/x.sh']) {
      expect(p.readOnly, f).toContain(path.join(workspace, f));
    }
    expect(p.readOnly).not.toContain(path.join(workspace, 'true'));
    expect(p.readOnly).not.toContain('/usr/bin/less');
  });

  it('refuses a program git\'s config names inside the mounts that does not exist: the session could create it', () => {
    const included = `file:${path.join(workspace, '.git', 'config')}\0core.fsmonitor\ntools/fsmon.sh\0`;
    expect(() => guestPlanOf(specOf(), workspace, () => ({ list: '', included, hooks: '', top: workspace }))).toThrow(/core\.fsmonitor/);
  });

  // Second review pass: a command line is more than its first word.
  it('protects every path a configured command line names: env assignments, interpreters, sh -c bodies, proxies', () => {
    const files = ['tools/cred.sh', 'tools/env.sh', 'tools/body.sh', 'tools/proxy.sh', 'bare.sh', 'tools/via-var.sh'];
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(workspace, f)), { recursive: true });
      fs.writeFileSync(path.join(workspace, f), '#!/bin/sh\n');
    }
    const cfg = `file:${path.join(workspace, '.git', 'config')}`;
    const included = [
      cfg, 'credential.helper\n!sh tools/cred.sh',
      cfg, 'credential.https://a.example.helper\n!FOO=1 tools/env.sh get',
      cfg, 'alias.x\n!sh -c \'cd . && tools/body.sh "$1"\' -',
      cfg, 'core.gitproxy\ntools/proxy.sh for example.com',
      cfg, 'trailer.sign.cmd\nbare.sh',
      cfg, 'diff.external\nHOOK=tools/via-var.sh /usr/bin/env',
    ].join('\0') + '\0';
    const p = guestPlanOf(specOf(), workspace, () => ({ list: '', included, hooks: '', top: workspace }));
    for (const f of files) expect(p.readOnly, f).toContain(path.join(workspace, f));
  });

  it('refuses a missing path any word of a configured command line names inside the mounts', () => {
    const included = `file:${path.join(workspace, '.git', 'config')}\0credential.helper\n!sh tools/missing.sh\0`;
    expect(() => guestPlanOf(specOf(), workspace, () => ({ list: '', included, hooks: '', top: workspace }))).toThrow(/credential\.helper/);
  });

  it('protects the programs an include names that is not in effect now (includeIf onbranch), from the real git config', () => {
    fs.rmSync(path.join(workspace, '.git'), { recursive: true });
    const git = (...a: string[]) => spawnSync('git', ['-C', workspace, ...a], { encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    fs.mkdirSync(path.join(workspace, 'tools'));
    fs.writeFileSync(path.join(workspace, 'tools', 'cred.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(workspace, 'tools', 'nested.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(workspace, 'release.gitconfig'), '[credential]\n\thelper = !./tools/cred.sh\n[include]\n\tpath = nested.gitconfig\n');
    fs.mkdirSync(path.join(workspace, '.release-hooks'));
    fs.writeFileSync(path.join(workspace, 'nested.gitconfig'), '[core]\n\tfsmonitor = tools/nested.sh\n\thooksPath = .release-hooks\n');
    expect(git('config', 'includeIf.onbranch:release.path', path.join(workspace, 'release.gitconfig')).status).toBe(0);
    const p = guestPlanOf(specOf(), workspace);
    expect(p.readOnly).toContain(path.join(workspace, 'tools', 'cred.sh'));
    expect(p.readOnly).toContain(path.join(workspace, 'nested.gitconfig'));
    expect(p.readOnly).toContain(path.join(workspace, 'tools', 'nested.sh'));
    expect(p.readOnly).toContain(path.join(workspace, '.release-hooks'));
  });

  // Third review pass: what is not a program is left alone, and an unreadable config refuses.
  it('takes no word of a plain alias, a refspec or an expansion for a program, and no bare directory name', () => {
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.mkdirSync(path.join(workspace, 'auth'));
    const cfg = `file:${path.join(workspace, '.git', 'config')}`;
    const included = [
      cfg, 'alias.publish\npush origin HEAD:refs/heads/main',
      cfg, 'alias.history\nlog -- src/',
      cfg, 'credential.helper\n!"${PWD}/tools/cred.sh" get',
      cfg, 'credential.https://b.example.helper\n!gh auth git-credential',
    ].join('\0') + '\0';
    const p = guestPlanOf(specOf(), workspace, () => ({ list: '', included, hooks: '', top: workspace }));
    expect(p.readOnly).not.toContain(path.join(workspace, 'src'));
    expect(p.readOnly).not.toContain(path.join(workspace, 'auth'));
  });

  it('refuses the launch when an include git\'s config names cannot be read, rather than protecting less', () => {
    fs.rmSync(path.join(workspace, '.git'), { recursive: true });
    const git = (...a: string[]) => spawnSync('git', ['-C', workspace, ...a], { encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    fs.writeFileSync(path.join(workspace, 'broken.gitconfig'), '[core\n\tthis is not config\n');
    expect(git('config', 'includeIf.onbranch:release.path', path.join(workspace, 'broken.gitconfig')).status).toBe(0);
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/could not read git's config/);
  });

  it('refuses the launch when the config in effect cannot be read (a broken active include), rather than finding no repository', () => {
    fs.rmSync(path.join(workspace, '.git'), { recursive: true });
    const git = (...a: string[]) => spawnSync('git', ['-C', workspace, ...a], { encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    fs.writeFileSync(path.join(workspace, 'broken.gitconfig'), '[core\n\tthis is not config\n');
    expect(git('config', 'include.path', path.join(workspace, 'broken.gitconfig')).status).toBe(0);
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/could not read git's config/);
  });

  it('protects a program a plain alias sets with -c', () => {
    fs.mkdirSync(path.join(workspace, 'tools'));
    fs.writeFileSync(path.join(workspace, 'tools', 'monitor.sh'), '#!/bin/sh\n');
    const included = `file:${path.join(workspace, '.git', 'config')}\0alias.scan\n-c core.fsmonitor=./tools/monitor.sh status -- src/\0`;
    const p = guestPlanOf(specOf(), workspace, () => ({ list: '', included, hooks: '', top: workspace }));
    expect(p.readOnly).toContain(path.join(workspace, 'tools', 'monitor.sh'));
  });

  it('reads the programs git\'s config names from the real git config', () => {
    fs.rmSync(path.join(workspace, '.git'), { recursive: true });
    const git = (...a: string[]) => spawnSync('git', ['-C', workspace, ...a], { encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    fs.mkdirSync(path.join(workspace, 'tools'));
    fs.writeFileSync(path.join(workspace, 'tools', 'fsmon.sh'), '#!/bin/sh\n');
    expect(git('config', 'core.fsmonitor', 'tools/fsmon.sh').status).toBe(0);
    expect(guestPlanOf(specOf(), workspace).readOnly).toContain(path.join(workspace, 'tools', 'fsmon.sh'));
  });

  it('reads core.hooksPath from the real git config', () => {
    fs.rmSync(path.join(workspace, '.git'), { recursive: true });
    const git = (...a: string[]) => spawnSync('git', ['-C', workspace, ...a], { encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    fs.mkdirSync(path.join(workspace, '.husky'));
    expect(git('config', 'core.hooksPath', '.husky').status).toBe(0);
    expect(guestPlanOf(specOf(), workspace).readOnly).toContain(path.join(workspace, '.husky'));
  });

  it('refuses a link chain through a link the session could swap: hook -> scripts/current -> safe.sh', () => {
    fs.mkdirSync(path.join(workspace, 'scripts'));
    fs.writeFileSync(path.join(workspace, 'scripts', 'safe.sh'), '#!/bin/sh\n');
    fs.symlinkSync('safe.sh', path.join(workspace, 'scripts', 'current'));
    fs.symlinkSync('../../scripts/current', path.join(workspace, '.git', 'hooks', 'pre-commit'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/resolves through .*scripts\/current/);
  });

  it('refuses a link whose path runs through a linked directory the session could swap', () => {
    fs.mkdirSync(path.join(workspace, 'scripts'));
    fs.writeFileSync(path.join(workspace, 'scripts', 'safe.sh'), '#!/bin/sh\n');
    fs.symlinkSync('scripts', path.join(workspace, 'via'));
    fs.symlinkSync('../../via/safe.sh', path.join(workspace, '.git', 'hooks', 'pre-commit'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/resolves through .*via/);
  });

  describe('against real git', () => {
    const git = (dir: string, ...a: string[]) => {
      const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    };
    beforeEach(() => {
      fs.rmSync(path.join(workspace, '.git'), { recursive: true });
      git(workspace, 'init', '-q');
    });

    it('protects a file an include names even when it sets nothing, active or not', () => {
      fs.writeFileSync(path.join(workspace, 'shared.gitconfig'), '');
      fs.writeFileSync(path.join(workspace, 'cond.gitconfig'), '');
      git(workspace, 'config', 'include.path', '../shared.gitconfig');
      git(workspace, 'config', 'includeIf.gitdir:/nowhere/.path', '../cond.gitconfig');
      const p = guestPlanOf(specOf(), workspace);
      expect(p.readOnly).toContain(path.join(workspace, 'shared.gitconfig'));
      expect(p.readOnly).toContain(path.join(workspace, 'cond.gitconfig'));
    });

    it('reads an include written ~user/ as git does: the user\'s home, not a path in the repository', () => {
      git(workspace, 'config', 'include.path', `~${os.userInfo().username}/agenfk-no-such.gitconfig`);
      expect(() => guestPlanOf(specOf(), workspace)).not.toThrow();
    });

    it('refuses an include naming a file inside the mounts that does not exist', () => {
      git(workspace, 'config', 'include.path', '../later.gitconfig');
      expect(() => guestPlanOf(specOf(), workspace)).toThrow(/later\.gitconfig/);
    });

    it('protects nested repositories as the top one: pinned git dir, read-only hooks and config, read-only pointer files', () => {
      const lib = path.join(workspace, 'vendor', 'lib');
      fs.mkdirSync(lib, { recursive: true });
      git(lib, 'init', '-q');
      fs.mkdirSync(path.join(workspace, 'sub'));
      fs.writeFileSync(path.join(workspace, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
      const p = guestPlanOf(specOf(), workspace);
      expect(p.pinned).toContain(path.join(lib, '.git'));
      expect(p.readOnly).toContain(path.join(lib, '.git', 'hooks'));
      expect(p.readOnly).toContain(path.join(lib, '.git', 'config'));
      expect(p.readOnly).toContain(path.join(workspace, 'sub', '.git'));
    });

    it('refuses a nested .git that is a symbolic link', () => {
      fs.mkdirSync(path.join(workspace, 'elsewhere'));
      fs.mkdirSync(path.join(workspace, 'sub'));
      fs.symlinkSync(path.join(workspace, 'elsewhere'), path.join(workspace, 'sub', '.git'));
      expect(() => guestPlanOf(specOf(), workspace)).toThrow(/symbolic link/);
    });
  });

  it('reads the config of the repository above a workspace that has none of its own', () => {
    fs.rmSync(path.join(workspace, '.git'), { recursive: true });
    const top = path.dirname(workspace);
    expect(spawnSync('git', ['-C', top, 'init', '-q']).status).toBe(0);
    // Relative to the top of the working tree, as git reads it.
    expect(spawnSync('git', ['-C', top, 'config', 'core.hooksPath', `${path.basename(workspace)}/.githooks`]).status).toBe(0);
    fs.mkdirSync(path.join(workspace, '.githooks'));
    expect(guestPlanOf(specOf({ gitDir: null }), workspace).readOnly).toContain(path.join(workspace, '.githooks'));
  });

  it('refuses a .agenfk below the workspace that is a symbolic link', () => {
    fs.mkdirSync(path.join(workspace, 'elsewhere'));
    fs.mkdirSync(path.join(workspace, 'packages', 'b'));
    fs.symlinkSync(path.join(workspace, 'elsewhere'), path.join(workspace, 'packages', 'b', '.agenfk'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/symbolic link/);
  });

  it('refuses a pattern with a wildcard in its directory part, ? included', () => {
    const spec = specOf();
    const bad = { ...spec, filesystem: { ...spec.filesystem, denyWrite: [...spec.filesystem.denyWrite, path.join(workspace, 'pkg?', 'secret*')] } };
    expect(() => guestPlanOf(bad, workspace)).toThrow(/cannot apply the protection/);
  });

  it('hides first and counts only a tmpfs as hidden: a read-only bind already there does not hide', () => {
    const script = guestSetupScript(guestPlanOf(specOf(), workspace), 503, 20);
    const auth = path.join(agentDir, 'auth.json');
    expect(script.indexOf(`hide_file '${auth}'`)).toBeLessThan(script.indexOf('\nro '));
    expect(script).toMatch(/hide_file\(\) \{ hidden "\$2"/);
  });

  it('refuses a protected tree linking into the mounts at nothing yet: the session could create the target', () => {
    fs.symlinkSync('../../scripts/missing.sh', path.join(workspace, '.git', 'hooks', 'pre-push'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/does not exist/);
  });

  it('refuses a file in a protected tree that has another name', () => {
    fs.writeFileSync(path.join(workspace, 'notes.json'), '{}');
    fs.linkSync(path.join(workspace, 'notes.json'), path.join(workspace, '.agenfk', 'local.json'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/hard link/);
  });

  it('leaves a link out of the mounts alone: the guest cannot reach its target', () => {
    fs.symlinkSync('/usr/share/git-core/templates/hooks/pre-commit.sample', path.join(workspace, '.git', 'hooks', 'pre-commit'));
    expect(() => guestPlanOf(specOf(), workspace)).not.toThrow();
  });

  it('refuses a protected path that is a symbolic link: a bind would protect its target and leave the link replaceable', () => {
    fs.renameSync(path.join(workspace, '.git', 'config'), path.join(root, 'real-config'));
    fs.symlinkSync(path.join(root, 'real-config'), path.join(workspace, '.git', 'config'));
    expect(() => guestPlanOf(specOf(), workspace)).toThrow(/symbolic link/);
  });

  it('holds a missing .git with an empty read-only one, which git passes over, so none can be planted', () => {
    fs.rmSync(path.join(workspace, '.git'), { recursive: true });
    const p = guestPlanOf(specOf({ gitDir: null }), workspace);
    expect(p.placeholders).toContainEqual({ path: path.join(workspace, '.git'), kind: 'dir' });
    expect(p.readOnly).toContain(path.join(workspace, '.git'));
  });

  it('refuses a linked git worktree whose git dir it cannot follow back to its repository, saying why', () => {
    fs.rmSync(path.join(workspace, '.git'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    expect(() => guestPlanOf(specOf({ gitDir: null }), workspace)).toThrow(/linked git worktree/);
  });

  it('holds a missing protected directory with an empty one: pi extensions a session could plant for host pi', () => {
    fs.rmSync(path.join(agentDir, 'extensions'), { recursive: true });
    const p = guestPlanOf(specOf(), workspace);
    expect(p.placeholders).toContainEqual({ path: path.join(agentDir, 'extensions'), kind: 'dir' });
    expect(p.readOnly).toContain(path.join(agentDir, 'extensions'));
  });

  it('holds a missing workspace .agenfk and git hooks dir', () => {
    fs.rmSync(path.join(workspace, '.agenfk'), { recursive: true });
    fs.rmSync(path.join(workspace, '.git', 'hooks'), { recursive: true });
    const held = guestPlanOf(specOf(), workspace).placeholders.map((p) => p.path);
    expect(held).toContain(path.join(workspace, '.agenfk'));
    expect(held).toContain(path.join(workspace, '.git', 'hooks'));
  });

  it('does not hold the IDE dirs ASRT protected when they are missing: an empty .idea would be noticed', () => {
    const held = guestPlanOf(specOf(), workspace).placeholders.map((p) => p.path);
    for (const n of ['.vscode', '.idea', '.mcp.json', '.gitmodules']) expect(held).not.toContain(path.join(workspace, n));
  });

  it('holds nothing outside the mounts, and nothing through a linked parent', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(agentDir, 'extensions'), { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, 'linked'));
    const spec = specOf();
    const p = guestPlanOf({ ...spec, filesystem: { ...spec.filesystem, denyWrite: [...spec.filesystem.denyWrite, path.join(workspace, 'linked', 'x'), path.join(home, '.config', 'x')] } }, workspace);
    const held = p.placeholders.map((x) => x.path);
    expect(held).not.toContain(path.join(workspace, 'linked', 'x'));
    expect(held).not.toContain(path.join(home, '.config', 'x'));
  });

  it('binds the pinned .git before what is inside it: a bind over a directory hides binds already in it', async () => {
    const { rt, smolvm } = runtime();
    await rt.launch(specOf(), cmd());
    const script = smolvm.calls.find((c) => c.args[1] === 'exec' && flag(c.args, '-u', '--user') === 'root')!.args.at(-1) as string;
    const pin = script.indexOf(`pin '${path.join(workspace, '.git')}'`);
    const hooks = script.indexOf(`ro '${path.join(workspace, '.git', 'hooks')}'`);
    expect(pin).toBeGreaterThan(0);
    expect(hooks).toBeGreaterThan(pin);
  });
});

describe('placeholders are taken back only as they were made', () => {
  it('holds a missing .git/config with an empty file, which git reads as no settings', () => {
    fs.rmSync(path.join(workspace, '.git', 'config'));
    expect(guestPlanOf(specOf(), workspace).placeholders).toContainEqual({ path: path.join(workspace, '.git', 'config'), kind: 'file', content: '' });
  });

  it('holds only directly in a mount root or the pinned .git, never deeper', () => {
    fs.mkdirSync(path.join(workspace, 'sub'));
    const spec = specOf();
    const deeper = path.join(workspace, 'sub', 'held');
    const p = guestPlanOf({ ...spec, filesystem: { ...spec.filesystem, denyWrite: [...spec.filesystem.denyWrite, deeper] } }, workspace);
    expect(p.placeholders.map((x) => x.path)).not.toContain(deeper);
  });

  it('recovers from a launcher that crashed: its placeholders are taken back and held again, and the session starts', async () => {
    const smolvm = fakeSmolvm();
    const crashed = runtime({ smolvm });
    await crashed.rt.launch(specOf(), cmd());
    const commondir = path.join(workspace, '.git', 'commondir');
    expect(fs.existsSync(commondir)).toBe(true);
    // It died without releasing: its record is of a process that is gone, the machine still runs.
    const sessions = path.join(stateDir, 'machines', machineNameOf(workspace), 'sessions');
    for (const f of fs.readdirSync(sessions)) fs.writeFileSync(path.join(sessions, f), JSON.stringify({ pid: 999999 }));
    const next = runtime({ smolvm });
    const launched = await next.rt.launch(specOf(), cmd());
    // The protections' setup: the root script that defines the binds (not the resolver's, task 8,
    // nor the one making the session's ~/.agenfk, task 9).
    const setup = smolvm.calls.filter((c) => c.args[1] === 'exec' && flag(c.args, '-u', '--user') === 'root' && String(c.args.at(-1)).includes('pin() {')).at(-1)!.args.at(-1) as string;
    expect(setup).toContain(`ro '${commondir}'`);
    expect(fs.readFileSync(commondir, 'utf8')).toBe('.\n');
    next.sp.children[0].finish(0);
    await launched.exited;
    expect(fs.existsSync(commondir)).toBe(false);
  });

  it('keeps the protections and says so when smolvm does not confirm the stop: exited rejects, never hangs', async () => {
    const smolvm = fakeSmolvm({ stopFails: 'Error: vm busy' });
    const { rt, sp, egress } = runtime({ smolvm });
    const commondir = path.join(workspace, '.git', 'commondir');
    const launched = await rt.launch(specOf(), cmd());
    sp.children[0].finish(0);
    await expect(launched.exited).rejects.toThrow(/vm busy/);
    expect(fs.existsSync(commondir)).toBe(true);
    expect(egress.stop).not.toHaveBeenCalled();
  });

  it('leaves a placeholder dir the session replaced with another one', async () => {
    const { rt, sp } = runtime();
    const worktrees = path.join(workspace, '.git', 'worktrees');
    const launched = await rt.launch(specOf(), cmd());
    fs.rmdirSync(worktrees);
    fs.mkdirSync(worktrees);
    sp.children[0].finish(0);
    await launched.exited;
    expect(fs.existsSync(worktrees)).toBe(true);
  });

  it('leaves a placeholder file that was changed', async () => {
    const { rt, sp } = runtime();
    const conf = path.join(workspace, '.git', 'config.worktree');
    const launched = await rt.launch(specOf(), cmd());
    fs.writeFileSync(conf, '[core]\n');
    sp.children[0].finish(0);
    await launched.exited;
    expect(fs.readFileSync(conf, 'utf8')).toBe('[core]\n');
  });
});

describe('sessions starting and leaving at once', () => {
  it('two launches at once make one machine and start it once', async () => {
    const smolvm = fakeSmolvm();
    const egress = fakeEgress();
    const a = runtime({ smolvm, egress, pidAlive: () => true });
    const b = runtime({ smolvm, egress, pidAlive: () => true });
    await Promise.all([a.rt.launch(specOf(), cmd()), b.rt.launch(specOf(), cmd())]);
    expect(smolvm.verbs().filter((v) => v === 'create')).toHaveLength(1);
    expect(smolvm.verbs().filter((v) => v === 'start')).toHaveLength(1);
    expect(egress.ensure).toHaveBeenCalledTimes(1);
  });

  it('a session joining while the last one leaves is never left in a stopped machine', async () => {
    const smolvm = fakeSmolvm({ stopTakesMs: 30 });
    const egress = fakeEgress();
    const a = runtime({ smolvm, egress, pidAlive: () => true });
    const b = runtime({ smolvm, egress, pidAlive: () => true });
    const first = await a.rt.launch(specOf(), cmd());
    a.sp.children[0].finish(0);
    // B arrives while A's stop is in flight.
    while (!smolvm.verbs().includes('stop')) await new Promise((r) => setTimeout(r, 1));
    const [, second] = await Promise.all([first.exited, b.rt.launch(specOf(), cmd())]);
    expect(smolvm.machines.get(machineNameOf(workspace))?.state).toBe('running');
    expect(second.pid).toBeDefined();
  });

  it('refuses to join a machine holding a mount this session may not see', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, [{ source: '/home/other/secrets', target: '/home/other/secrets', readOnly: false }]);
    liveSession(name);
    const { rt, sp } = runtime({ smolvm });
    await expect(rt.launch(specOf(), cmd())).rejects.toThrow(/\/home\/other\/secrets/);
    expect(sp.spawn).not.toHaveBeenCalled();
    // The other session's machine keeps running.
    expect(smolvm.machines.get(name)?.state).toBe('running');
  });

  it('refuses a session that would mount more than the one already in the machine may see', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    // The session in it has the workspace alone (a command's sandbox: no client state).
    smolvm.mounts.set(name, [{ source: workspace, target: workspace, readOnly: false }]);
    liveSession(name);
    const { rt, sp } = runtime({ smolvm });
    await expect(rt.launch(specOf(), cmd())).rejects.toThrow(new RegExp(agentDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(smolvm.calls.filter((c) => c.args[1] === 'mount' && c.args[2] === 'add')).toEqual([]);
    expect(sp.spawn).not.toHaveBeenCalled();
  });

  it('refuses to join a machine started under another network policy: one interceptor decides for it', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name, 'other', { ...specOf().network, allow: ['*.example.com'] });
    const { rt, sp } = runtime({ smolvm });
    await expect(rt.launch(specOf(), cmd())).rejects.toThrow(/different network policy/);
    expect(sp.spawn).not.toHaveBeenCalled();
  });

  it('refuses to join when the machine\'s network policy was never recorded', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name);
    fs.rmSync(path.join(stateDir, 'machines', name, 'network.json'));
    await expect(runtime({ smolvm }).rt.launch(specOf(), cmd())).rejects.toThrow(/different network policy/);
  });

  it('refuses to join a machine whose file protections differ: what is already open would stay writable', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name);
    fs.writeFileSync(path.join(stateDir, 'machines', name, 'protections.json'), JSON.stringify({ pinned: [], readOnly: [], hidden: [] }));
    const { rt, sp } = runtime({ smolvm });
    await expect(rt.launch(specOf(), cmd())).rejects.toThrow(/different file protections/);
    expect(sp.spawn).not.toHaveBeenCalled();
  });

  it('lets a second session join a workspace with no repository: the .git placeholder is planned as missing again', async () => {
    fs.rmSync(path.join(workspace, '.git'), { recursive: true });
    const smolvm = fakeSmolvm();
    const egress = fakeEgress();
    const a = runtime({ smolvm, egress, pidAlive: () => true });
    const b = runtime({ smolvm, egress, pidAlive: () => true });
    await a.rt.launch(specOf({ gitDir: null }), cmd());
    expect(fs.statSync(path.join(workspace, '.git')).isDirectory()).toBe(true);
    await b.rt.launch(specOf({ gitDir: null }), cmd());
    expect(b.sp.spawn).toHaveBeenCalledTimes(1);
  });

  it('restarts a machine left running with no session in it: its interceptor is gone, and so are its mounts', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, [{ source: '/gone/session', target: '/gone/session', readOnly: false }]);
    const egress = fakeEgress();
    const { rt, sp } = runtime({ smolvm, egress });
    await rt.launch(specOf(), cmd());
    const v = smolvm.verbs();
    expect(v.indexOf('stop')).toBeLessThan(v.indexOf('start'));
    expect(egress.ensure).toHaveBeenCalledTimes(1);
    expect(sp.spawn).toHaveBeenCalledTimes(1);
  });

  it('waits for a lock a live process holds, and goes on once it is released', async () => {
    const name = machineNameOf(workspace);
    const lock = path.join(stateDir, 'machines', name, 'lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid} other`);
    const { rt, sp } = runtime();
    const launching = rt.launch(specOf(), cmd());
    await new Promise((r) => setTimeout(r, 100));
    expect(sp.spawn).not.toHaveBeenCalled();
    fs.rmSync(lock);
    await launching;
    expect(sp.spawn).toHaveBeenCalledTimes(1);
  });

  it('waits while another launcher is breaking a stale lock', async () => {
    const name = machineNameOf(workspace);
    const lock = path.join(stateDir, 'machines', name, 'lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '999999 gone');
    fs.writeFileSync(`${lock}.break`, String(process.pid));
    const { rt, sp } = runtime();
    const launching = rt.launch(specOf(), cmd());
    await new Promise((r) => setTimeout(r, 100));
    expect(sp.spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(lock)).toBe(true);
    fs.rmSync(`${lock}.break`);
    await launching;
    expect(sp.spawn).toHaveBeenCalledTimes(1);
  });

  it('clears a breaking turn whose launcher is gone, and goes on', async () => {
    const name = machineNameOf(workspace);
    const lock = path.join(stateDir, 'machines', name, 'lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '999999 gone');
    fs.writeFileSync(`${lock}.break`, '999998 crashed');
    const { rt, sp } = runtime();
    await rt.launch(specOf(), cmd());
    expect(sp.spawn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${lock}.break`)).toBe(false);
  });

  it('clears a breaking turn with no owner in it (a launcher killed while taking it) once it is old, and goes on', async () => {
    const name = machineNameOf(workspace);
    const lock = path.join(stateDir, 'machines', name, 'lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '999999 gone');
    fs.writeFileSync(`${lock}.break`, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(`${lock}.break`, old, old);
    const { rt, sp } = runtime();
    await rt.launch(specOf(), cmd());
    expect(sp.spawn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${lock}.break`)).toBe(false);
  });

  it('never breaks a lock a live owner took after the stale one was seen', () => {
    const name = machineNameOf(workspace);
    const lock = path.join(stateDir, 'machines', name, 'lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '999999 gone');
    const staleIno = fs.statSync(lock).ino;
    // Before this launcher gets its turn, the stale lock is cleared and a live owner takes a new one.
    fs.rmSync(lock);
    fs.writeFileSync(lock, `${process.pid} live`);
    const { rt } = runtime();
    // Nothing removed, and it says so: a true here sent the caller round again at once, which spun
    // on a lock it could never take (story review: an ownerless lock pinned the CPU).
    expect((rt as unknown as { breakStaleLock(l: string, ino: number): boolean }).breakStaleLock(lock, staleIno)).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.pid} live`);
  });

  it('takes over the lock of a process that is gone', async () => {
    const name = machineNameOf(workspace);
    fs.mkdirSync(path.join(stateDir, 'machines', name), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machines', name, 'lock'), '999999');
    const { rt, sp } = runtime();
    await rt.launch(specOf(), cmd());
    expect(sp.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('signalling through a pid file the session owns', () => {
  it('bounds the signalling exec and accepts nothing but a pid from the file', async () => {
    const { rt, smolvm } = runtime();
    const launched = await rt.launch(specOf(), cmd());
    launched.kill('SIGINT');
    await settle();
    const kill = smolvm.execs().find((a) => a.join(' ').includes('kill -INT'))!;
    expect(flag(kill, '--timeout')).toBe('10s');
    const script = kill[kill.indexOf('-c') + 1];
    // Run the reader on the host's sh against crafted files: only a plain pid gets through.
    for (const [content, ok] of [['4242\n', true], ['1', false], ['0', false], ['12 13', false], ['$(touch /tmp/x)', false], ['', false]] as const) {
      const f = path.join(root, `pid-${Math.random()}`);
      fs.writeFileSync(f, content);
      const r = spawnSync('sh', ['-c', script.replace(/kill -INT -\$pid$/, 'echo "$pid"'), f], { encoding: 'utf8', timeout: 5000 });
      expect(r.status === 0 && r.stdout.trim() === '4242').toBe(ok);
    }
  });

  it('refuses a signal name that is not one', async () => {
    const { rt } = runtime();
    const launched = await rt.launch(specOf(), cmd());
    expect(launched.kill('TERM; reboot' as NodeJS.Signals)).toBe(false);
  });
});

describe('the AgEnFK server and the model key, from inside the machine', () => {
  const keySession = (over: Partial<SandboxSession> = {}) => specOf({ serverUrl: 'http://127.0.0.1:3123', maskedEnv: ['OPENAI_API_KEY'], ...over });

  type Started = { routes: unknown; secrets: Array<{ placeholder: string; value: string }>; ca: { certPem: string }; socketPath?: string };
  function injectorDeps() {
    const started: Started[] = [];
    const closed: number[] = [];
    const startInjector = vi.fn(async (o: Started) => {
      started.push(o);
      const n = started.length;
      return { port: 0, socket: o.socketPath, close: async () => { closed.push(n); } };
    });
    return { started, closed, startInjector };
  }

  it('relays the session\'s AgEnFK server through the gateway: a route to a socket that reaches its relay, AGENFK_API_URL pointing there', async () => {
    let got = '';
    const relay = net.createServer((c) => c.on('data', (d) => { got += d; }));
    await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
    const relayPort = (relay.address() as net.AddressInfo).port;
    try {
      const egress = fakeEgress();
      const { rt, sp } = runtime({ egress, ...injectorDeps() });
      const launched = await rt.launch(keySession({ serverPort: relayPort, serverUrl: `http://127.0.0.1:${relayPort}` }), cmd());
      const route = egress.routes.find((r) => r.kind === 'relay') as Extract<Route, { kind: 'relay' }>;
      expect(route).toMatchObject({ kind: 'relay', port: relayPort });
      // What the decider sends to the route's socket arrives at the relay.
      await new Promise<void>((r) => { const c = net.connect(route.socket, () => { c.end('GET /health'); r(); }); });
      await vi.waitFor(() => expect(got).toBe('GET /health'));
      const args = (sp.spawn.mock.calls[0] as unknown as [string, string[]])[1];
      expect(args).toContain(`AGENFK_API_URL=http://${GATEWAY}:${relayPort}`);
      sp.children[0].finish(0);
      await launched.exited;
      expect(egress.routes).toEqual([]);
      // Its socket is gone with it.
      await expect(new Promise((res, rej) => { const c = net.connect(route.socket, () => { c.end(); res(true); }); c.on('error', rej); })).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => relay.close(() => r()));
    }
  });

  it('gives the guest a placeholder for the key, and the injector the real one: the key is on no command line', async () => {
    const egress = fakeEgress();
    const inj = injectorDeps();
    const { rt, sp, smolvm } = runtime({ egress, ...inj });
    const launched = await rt.launch(keySession(), cmd());
    const args = (sp.spawn.mock.calls[0] as unknown as [string, string[]])[1];
    const env = args.flatMap((a, i) => (args[i - 1] === '-e' ? [a] : []));
    const placeholder = env.find((e) => e.startsWith('OPENAI_API_KEY='))!.slice('OPENAI_API_KEY='.length);
    expect(placeholder).not.toBe('sk-fake-not-real');
    expect(inj.started[0].secrets).toEqual([{ placeholder, value: 'sk-fake-not-real' }]);
    expect(inj.started[0].routes).toEqual([{ host: 'api.openai.com', port: 443 }]);
    expect(egress.routes).toContainEqual({ kind: 'inject', host: 'api.openai.com', port: 443, socket: inj.started[0].socketPath });
    const everyArg = [...smolvm.calls.map((c) => c.args), args].flat().join(' ');
    expect(everyArg).not.toContain('sk-fake-not-real');
    sp.children[0].finish(0);
    await launched.exited;
    expect(inj.closed).toEqual([1]);
    expect(egress.routes).toEqual([]);
  });

  it('has the guest trust the machine\'s CA beside the host\'s, for every client that reads a bundle', async () => {
    const inj = injectorDeps();
    const { rt, sp, smolvm } = runtime({ ...inj });
    await rt.launch(keySession(), cmd());
    const args = (sp.spawn.mock.calls[0] as unknown as [string, string[]])[1];
    for (const v of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) expect(args).toContain(`${v}=/run/agenfk/ca-bundle.pem`);
    const setup = smolvm.calls.find((c) => c.args[1] === 'exec' && flag(c.args, '-u', '--user') === 'root')!.args.at(-1) as string;
    expect(setup).toContain('/etc/smolvm-host-trust/ca-bundle.pem');
    expect(setup).toContain(inj.started[0].ca.certPem.trim().split('\n')[1]);
    expect(setup).not.toContain('PRIVATE KEY');
  });

  it('ends its session though a connection through its relay is still open', async () => {
    const relay = net.createServer(() => undefined);
    await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
    const relayPort = (relay.address() as net.AddressInfo).port;
    try {
      const egress = fakeEgress();
      const { rt, sp } = runtime({ egress, ...injectorDeps() });
      const launched = await rt.launch(keySession({ serverPort: relayPort, serverUrl: `http://127.0.0.1:${relayPort}` }), cmd());
      const route = egress.routes.find((r) => r.kind === 'relay') as Extract<Route, { kind: 'relay' }>;
      // Another session in the machine holds a connection to it open.
      const held = net.connect(route.socket);
      held.on('error', () => undefined);
      await new Promise((r) => held.once('connect', r));
      sp.children[0].finish(0);
      const ended = await Promise.race([launched.exited.then(() => 'ended'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
      expect(ended).toBe('ended');
      held.destroy();
    } finally {
      relay.closeAllConnections?.();
      await new Promise<void>((r) => relay.close(() => r()));
    }
  });

  it('gives every session in a machine the same placeholder for a key, so either injector can swap it', async () => {
    const smolvm = fakeSmolvm();
    const egress = fakeEgress();
    const a = runtime({ smolvm, egress, pidAlive: () => true, ...injectorDeps() });
    const b = runtime({ smolvm, egress, pidAlive: () => true, ...injectorDeps() });
    await a.rt.launch(keySession(), cmd());
    await b.rt.launch(keySession(), cmd());
    const keyOf = (r: { sp: ReturnType<typeof fakeSpawn> }) => ((r.sp.spawn.mock.calls[0] as unknown as [string, string[]])[1]).find((x) => x.startsWith('OPENAI_API_KEY='));
    expect(keyOf(b)).toBe(keyOf(a));
  });

  it('refuses to join a machine whose sessions inject other keys or hosts', async () => {
    const smolvm = fakeSmolvm();
    const egress = fakeEgress();
    const a = runtime({ smolvm, egress, pidAlive: () => true, ...injectorDeps() });
    const b = runtime({ smolvm, egress, pidAlive: () => true, ...injectorDeps() });
    await a.rt.launch(keySession(), cmd());
    await expect(b.rt.launch(keySession({ maskedEnv: ['OTHER_KEY'] }), cmd())).rejects.toThrow(/other model keys/);
  });

  it('injects nothing for a key the host does not have set', async () => {
    const inj = injectorDeps();
    const egress = fakeEgress();
    const { rt, sp } = runtime({ egress, ...inj, hostEnv: {} });
    await rt.launch(keySession(), cmd());
    expect(inj.startInjector).not.toHaveBeenCalled();
    expect(egress.routes.filter((r) => r.kind === 'inject')).toEqual([]);
    const args = (sp.spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args.some((a) => a.startsWith('OPENAI_API_KEY='))).toBe(false);
  });

  it('keeps the inference endpoint\'s own port', async () => {
    const inj = injectorDeps();
    const { rt } = runtime({ ...inj });
    await rt.launch(keySession({ inferenceHosts: ['llm.example.com:8443'] }), cmd());
    expect(inj.started[0].routes).toEqual([{ host: 'llm.example.com', port: 8443 }]);
  });
});

describe('the image of the machine (CGLAB-696 task 4)', () => {
  const OTHER = 'ghcr.io/acme/app-airlock:3';

  it('is the spec\'s machineImage when it names one: created from it and labelled with it', async () => {
    const { rt, smolvm } = runtime();
    await rt.launch({ ...specOf(), machineImage: OTHER }, cmd());
    const create = smolvm.calls.find((c) => c.args[1] === 'create')!.args;
    expect(flag(create, '-I', '--image')).toBe(OTHER);
    expect(create).toContain(`agenfk.image=${OTHER}`);
  });

  it('is the runtime\'s own when the spec names none', async () => {
    const { rt, smolvm } = runtime();
    await rt.launch(specOf(), cmd());
    expect(flag(smolvm.calls.find((c) => c.args[1] === 'create')!.args, '-I', '--image')).toBe(IMAGE);
  });

  it('makes the machine again when the spec names another image than the one it was made from', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: { state: 'stopped', image: IMAGE, labels: { 'agenfk.workspace': workspace, 'agenfk.image': IMAGE } } } });
    await runtime({ smolvm }).rt.launch({ ...specOf(), machineImage: OTHER }, cmd());
    const v = smolvm.verbs();
    expect(v.indexOf('delete')).toBeGreaterThanOrEqual(0);
    expect(v.indexOf('delete')).toBeLessThan(v.indexOf('create'));
    expect(smolvm.machines.get(name)?.labels['agenfk.image']).toBe(OTHER);
  });
});

describe('guestPlanOf: the guest\'s own platform dirs (CGLAB-696 task 4)', () => {
  const plan = () => guestPlanOf(specOf(), workspace);
  const write = (rel: string, content = '{}') => {
    fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
    fs.writeFileSync(path.join(workspace, rel), content);
  };

  it('binds no platform dir in a workspace with no package or Python project', () => {
    expect(plan().platform).toEqual([]);
  });

  it('gives the workspace\'s node_modules a store on the machine\'s disk: the host\'s is never what the guest sees', () => {
    write('package.json');
    const p = plan().platform;
    expect(p.map((x) => x.path)).toEqual([path.join(workspace, 'node_modules')]);
    expect(p[0].store.startsWith(`${GUEST_PLATFORM_ROOT}/`)).toBe(true);
    // Outside every mount: what the guest installs never lands on the host.
    expect(plan().mounts.some((m) => p[0].store.startsWith(m.guest))).toBe(false);
  });

  it('gives every package below the workspace its own node_modules store, but looks inside no node_modules', () => {
    write('package.json');
    write('packages/a/package.json');
    write('packages/b/package.json');
    write('node_modules/dep/package.json');
    const paths = plan().platform.map((x) => x.path).sort();
    expect(paths).toEqual([
      path.join(workspace, 'node_modules'),
      path.join(workspace, 'packages', 'a', 'node_modules'),
      path.join(workspace, 'packages', 'b', 'node_modules'),
    ]);
  });

  it('takes npm\'s install destinations from package-lock.json too: a workspace in a dot-directory or deeper than the walk (review 2)', () => {
    write('package.json');
    write('.tools/lint/package.json');
    const deep = 'a/b/c/d/e/f/g/h/i/j';
    write(`${deep}/package.json`);
    write('package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {}, 'node_modules/x': {}, 'node_modules/x/node_modules/y': {},
        '.tools/lint/node_modules/z': {}, [`${deep}/node_modules/w`]: {},
        // A workspace the lockfile names but the checkout does not have: nothing to bind onto.
        'gone/pkg/node_modules/q': {},
      },
    }));
    expect(plan().platform.map((x) => x.path).sort()).toEqual([
      path.join(workspace, '.tools', 'lint', 'node_modules'),
      path.join(workspace, deep, 'node_modules'),
      path.join(workspace, 'node_modules'),
    ].sort());
  });

  it('takes no install destination through a linked directory: root\'s bind would follow the link (second review 1)', () => {
    write('package.json');
    fs.mkdirSync(path.join(root, 'elsewhere', 'sub'), { recursive: true });
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(workspace, 'lnk'));
    write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'lnk/sub/node_modules/x': {} } }));
    expect(plan().platform.map((x) => x.path)).toEqual([path.join(workspace, 'node_modules')]);
  });

  it('takes yarn\'s (and npm\'s) workspaces from package.json: a workspace in a dot-directory (second review 5)', () => {
    write('package.json', JSON.stringify({ workspaces: ['.tools/*', 'libs/core'] }));
    write('.tools/lint/package.json');
    write('libs/core/package.json');
    write('yarn.lock', '# yarn\n');
    expect(plan().platform.map((x) => x.path).sort()).toEqual([
      path.join(workspace, '.tools', 'lint', 'node_modules'),
      path.join(workspace, 'libs', 'core', 'node_modules'),
      path.join(workspace, 'node_modules'),
    ].sort());
  });

  it('takes no destination inside another platform dir: its path would run through that dir\'s store, which the session fills (third review 1)', () => {
    write('pyproject.toml', '[project]\nname = "x"\n');
    write('package.json');
    write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, '.venv/node_modules/x': {} } }));
    // The host's .venv exists: the destination inside it passes every host-side check.
    fs.mkdirSync(path.join(workspace, '.venv'));
    expect(plan().platform.map((x) => x.path).sort()).toEqual([path.join(workspace, '.venv'), path.join(workspace, 'node_modules')].sort());
  });

  it('says it cannot place every install destination when a workspace pattern is beyond it: ** or a brace (third review 3)', () => {
    write('package.json', JSON.stringify({ workspaces: ['.tools/**'] }));
    expect(plan().platformIncomplete).toMatch(/\.tools\/\*\*/);
    write('package.json', JSON.stringify({ workspaces: ['.tools/pkg-*'] }));
    expect(plan().platformIncomplete).toMatch(/pkg-\*/);
    write('package.json', JSON.stringify({ workspaces: ['libs/*'] }));
    expect(plan().platformIncomplete).toBeUndefined();
  });

  it('reads workspaces in the {packages: [...]} form too', () => {
    write('package.json', JSON.stringify({ workspaces: { packages: ['.tools/*'] } }));
    write('.tools/lint/package.json');
    expect(plan().platform.map((x) => x.path)).toContain(path.join(workspace, '.tools', 'lint', 'node_modules'));
  });

  it('takes pnpm\'s install destinations from its importers', () => {
    write('package.json');
    write('.config/tool/package.json');
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n\n  .config/tool:\n    dependencies: {}\n\npackages: {}\n");
    expect(plan().platform.map((x) => x.path).sort()).toEqual([
      path.join(workspace, '.config', 'tool', 'node_modules'),
      path.join(workspace, 'node_modules'),
    ].sort());
  });

  it('gives a Python project its own .venv', () => {
    write('pyproject.toml', '[project]\nname = "x"\n');
    expect(plan().platform.map((x) => x.path)).toEqual([path.join(workspace, '.venv')]);
  });

  it('keeps one store per directory, the same on every launch, none shared', () => {
    write('package.json');
    write('packages/a/package.json');
    const first = plan().platform;
    expect(plan().platform).toEqual(first);
    expect(new Set(first.map((x) => x.store)).size).toBe(first.length);
  });

  it('holds a platform dir the host does not have yet with an empty directory, so the guest\'s store has somewhere to go', () => {
    write('package.json');
    write('packages/a/package.json');
    fs.rmSync(path.join(workspace, 'node_modules'), { recursive: true, force: true });
    const p = plan();
    expect(p.placeholders).toEqual(expect.arrayContaining([
      { path: path.join(workspace, 'node_modules'), kind: 'dir' },
      { path: path.join(workspace, 'packages', 'a', 'node_modules'), kind: 'dir' },
    ]));
  });

  it('does not hold a platform dir the host already has', () => {
    write('package.json');
    expect(plan().placeholders.map((x) => x.path)).not.toContain(path.join(workspace, 'node_modules'));
  });

  it('refuses a platform dir that is a symbolic link: the bind would land where it points', () => {
    write('package.json');
    fs.rmSync(path.join(workspace, 'node_modules'), { recursive: true, force: true });
    fs.symlinkSync(home, path.join(workspace, 'node_modules'));
    expect(() => plan()).toThrow(/node_modules.*symbolic link/);
  });
});

describe('guestSetupScript: the platform dirs', () => {
  it('binds a platform dir only where the guest resolves it to itself: root never binds through a link (third review 1)', () => {
    // Run by sh, with mount and its helpers stubbed: one real dir, and one the session made a link to /usr/bin.
    const real = path.join(workspace, 'node_modules');
    const linked = path.join(workspace, 'pkg', 'node_modules');
    fs.mkdirSync(path.dirname(linked));
    fs.symlinkSync('/usr/bin', linked);
    const log = path.join(root, 'mounts.log');
    const lines = platformBindLines([{ path: real, store: '/var/lib/agenfk/platform/a' }, { path: linked, store: '/var/lib/agenfk/platform/b' }], 503, 20);
    const stubs = `mkdir() { :; }; chown() { :; }; mounted() { return 1; }; mount() { echo "$@" >> '${log}'; }`;
    const r = spawnSync('sh', ['-c', `set -e; ${stubs}; ${lines.join('; ')}`], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([`--bind /var/lib/agenfk/platform/a ${real}`]);
  });

  it('binds each platform dir from its store, made and owned by the session user, once', () => {
    fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
    const plan = guestPlanOf(specOf(), workspace);
    const store = plan.platform[0].store;
    const script = guestSetupScript(plan, 503, 20);
    expect(script).toContain(`mkdir -p '${store}'`);
    expect(script).toContain(`chown 503:20 '${store}'`);
    expect(script).toMatch(new RegExp(`mounted '${path.join(workspace, 'node_modules')}' \\|\\| mount --bind '${store}' '${path.join(workspace, 'node_modules')}'`));
  });
});

describe('guestSetupScript: the session user', () => {
  it('gives the session\'s uid and gid a passwd and group entry when the image has none: ssh refuses a user it cannot look up', () => {
    const script = guestSetupScript(guestPlanOf(specOf(), workspace), 503, 20, undefined, '/home/u');
    expect(script).toContain("getent group 20 >/dev/null || echo 'agenfk:x:20:' >> /etc/group");
    expect(script).toContain("getent passwd 503 >/dev/null || echo 'agenfk:x:503:20:AgEnFK session:/home/u:/bin/sh' >> /etc/passwd");
  });

  it('gives the session its HOME in that entry: the runtime passes the spec\'s', async () => {
    const { rt, smolvm } = runtime();
    await rt.launch({ ...specOf(), home: '/home/someone' }, cmd());
    const setup = smolvm.calls.find((c) => c.args[1] === 'exec' && flag(c.args, '-u', '--user') === 'root')!;
    expect(setup.args.join(' ')).toContain(':AgEnFK session:/home/someone:/bin/sh');
  });
});

describe('platformInstallOf: what installs the guest\'s dependencies', () => {
  const write = (rel: string, content: string) => fs.writeFileSync(path.join(workspace, rel), content);
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

  it('is nothing without a lockfile: no install that would rewrite one', () => {
    write('package.json', '{}');
    expect(platformInstallOf(workspace)).toBeNull();
  });

  it('is npm ci for package-lock.json, keyed by the lockfile\'s hash', () => {
    write('package.json', '{}');
    write('package-lock.json', '{"lockfileVersion":3}');
    expect(platformInstallOf(workspace)).toEqual({ lockfile: path.join(workspace, 'package-lock.json'), hash: sha('{"lockfileVersion":3}'), command: ['npm', 'ci'] });
  });

  it('is a frozen pnpm install for pnpm-lock.yaml, and a frozen yarn install for yarn.lock', () => {
    write('package.json', '{}');
    write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    expect(platformInstallOf(workspace)?.command).toEqual(['pnpm', 'install', '--frozen-lockfile']);
    fs.rmSync(path.join(workspace, 'pnpm-lock.yaml'));
    write('yarn.lock', '# yarn\n');
    expect(platformInstallOf(workspace)?.command).toEqual(['yarn', 'install', '--frozen-lockfile']);
  });
});

describe('PLATFORM_INSTALL_SCRIPT, run by sh', () => {
  // The script as the guest runs it: sh -c SCRIPT <stamp> <hash> <command...>, in the workspace.
  let bin: string;
  let log: string;
  let stamp: string;
  beforeEach(() => {
    bin = path.join(root, 'bin');
    log = path.join(root, 'install.log');
    stamp = path.join(root, 'stamps', 'install.hash');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.dirname(stamp));
    fs.writeFileSync(path.join(bin, 'fake-npm'), `#!/bin/sh\necho "$@" >> '${log}'\n[ -z "$FAIL" ]\n`, { mode: 0o755 });
  });
  const run = (hash: string, env: Record<string, string> = {}) => spawnSync('sh', ['-c', PLATFORM_INSTALL_SCRIPT, stamp, hash, 'fake-npm', 'ci'], {
    cwd: workspace, env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: 'utf8',
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

  it('installs on the first launch and records the lockfile\'s hash', () => {
    expect(run('h1').status).toBe(0);
    expect(calls()).toEqual(['ci']);
    expect(fs.readFileSync(stamp, 'utf8').trim()).toBe('h1');
  });

  it('does not install again while the lockfile is unchanged', () => {
    run('h1');
    expect(run('h1').status).toBe(0);
    expect(calls()).toEqual(['ci']);
  });

  it('installs again when the lockfile changed', () => {
    run('h1');
    expect(run('h2').status).toBe(0);
    expect(calls()).toEqual(['ci', 'ci']);
    expect(fs.readFileSync(stamp, 'utf8').trim()).toBe('h2');
  });

  it('forgets the last install when a reinstall fails: going back to that lockfile installs again (review 4)', () => {
    run('h1');
    expect(run('h2', { FAIL: '1' }).status).not.toBe(0);
    expect(run('h1').status).toBe(0);
    expect(calls()).toEqual(['ci', 'ci', 'ci']);
  });

  it('is not held up by a FIFO the session planted as the stamp: it installs and replaces it (review 7)', () => {
    spawnSync('mkfifo', [stamp]);
    const r = spawnSync('sh', ['-c', PLATFORM_INSTALL_SCRIPT, stamp, 'h1', 'fake-npm', 'ci'], {
      cwd: workspace, env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 5000,
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(fs.lstatSync(stamp).isFile()).toBe(true);
    expect(fs.readFileSync(stamp, 'utf8').trim()).toBe('h1');
  });

  it('fails, and records nothing, when the install fails: the next launch tries again', () => {
    expect(run('h1', { FAIL: '1' }).status).not.toBe(0);
    expect(fs.existsSync(stamp)).toBe(false);
    run('h1');
    expect(calls()).toEqual(['ci', 'ci']);
  });
});

describe('a session in a machine with dependencies to install', () => {
  const lock = '{"lockfileVersion":3}';
  beforeEach(() => {
    fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
    fs.writeFileSync(path.join(workspace, 'package-lock.json'), lock);
  });
  const installExec = (smolvm: ReturnType<typeof fakeSmolvm>) => smolvm.calls.find((c) => c.args[1] === 'exec' && c.args.includes(PLATFORM_INSTALL_SCRIPT));

  it('installs them in the guest as the session user, in the workspace, after the protections and before the session', async () => {
    const { rt, smolvm, sp } = runtime();
    await rt.launch(specOf(), cmd());
    const install = installExec(smolvm);
    expect(install).toBeTruthy();
    expect(flag(install!.args, '-u', '--user')).toBe('503:20');
    expect(flag(install!.args, '-w', '--workdir')).toBe(workspace);
    const tail = install!.args.slice(install!.args.indexOf(PLATFORM_INSTALL_SCRIPT) + 2);
    expect(tail).toEqual([crypto.createHash('sha256').update(lock).digest('hex'), 'npm', 'ci']);
    const setup = smolvm.calls.find((c) => c.args[1] === 'exec' && flag(c.args, '-u', '--user') === 'root')!;
    const order = (c: { args: string[] }) => smolvm.run.mock.invocationCallOrder[smolvm.calls.indexOf(c as any)];
    expect(order(setup)).toBeLessThan(order(install!));
    expect(order(install!)).toBeLessThan(sp.spawn.mock.invocationCallOrder[0]);
  });

  it('bounds the install: a hung lifecycle script cannot hold the machine\'s lock forever (review 7)', async () => {
    const { rt, smolvm } = runtime();
    await rt.launch(specOf(), cmd());
    expect(flag(installExec(smolvm)!.args, '--timeout')).toMatch(/^\d+s$/);
  });

  it('keeps the host\'s model keys out of the install', async () => {
    const { rt, smolvm } = runtime();
    await rt.launch(specOf(), cmd());
    expect(installExec(smolvm)!.args.join(' ')).not.toContain('sk-fake-not-real');
  });

  it('starts the session anyway when the install fails, and says so with what the installer said', async () => {
    const warnings: string[] = [];
    const smolvm = fakeSmolvm({ execFails: (args) => (args.includes(PLATFORM_INSTALL_SCRIPT) ? 'npm ERR! 404 left-pad' : null) });
    const { rt, sp } = runtime({ smolvm, warn: (m: string) => warnings.push(m) });
    await rt.launch(specOf(), cmd());
    expect(sp.spawn).toHaveBeenCalledTimes(1);
    expect(warnings.join('\n')).toMatch(/npm ci.*failed[\s\S]*npm ERR! 404 left-pad/);
  });

  it('installs nothing, and says why, when it cannot place every install destination (third review 3)', async () => {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ workspaces: ['.tools/{lint,build}'] }));
    const warnings: string[] = [];
    const { rt, smolvm } = runtime({ warn: (m: string) => warnings.push(m) });
    await rt.launch(specOf(), cmd());
    expect(installExec(smolvm)).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/\.tools\/\{lint,build\}[\s\S]*not installed/);
  });

  it('installs nothing when the workspace has no lockfile', async () => {
    fs.rmSync(path.join(workspace, 'package-lock.json'));
    const { rt, smolvm } = runtime();
    await rt.launch(specOf(), cmd());
    expect(installExec(smolvm)).toBeUndefined();
  });

  it('joining a running machine, makes no platform bind and holds no platform dir: root would follow a link the session in it swapped in (review 3, second review 1)', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name);
    fs.mkdirSync(path.join(workspace, 'packages', 'b'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'packages', 'b', 'package.json'), '{}');
    fs.rmSync(path.join(workspace, 'node_modules'), { recursive: true, force: true });
    await runtime({ smolvm }).rt.launch(specOf(), cmd());
    expect(fs.existsSync(path.join(workspace, 'packages', 'b', 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'node_modules'))).toBe(false);
    const setup = smolvm.calls.find((c) => c.args[1] === 'exec' && flag(c.args, '-u', '--user') === 'root')!;
    expect(setup.args.join(' ')).not.toContain('mount --bind \'/var/lib/agenfk/platform');
  });

  it('refuses to join a running machine made from another image than this launch needs: the policy\'s image would not run (second review 2)', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name);
    const { rt, sp } = runtime({ smolvm });
    await expect(rt.launch({ ...specOf(), machineImage: 'ghcr.io/acme/hardened:1' }, cmd())).rejects.toThrow(/another session[\s\S]*ghcr\.io\/acme\/hardened:1/i);
    expect(sp.spawn).not.toHaveBeenCalled();
  });

  it('waits for another launcher\'s start longer than an install may take (second review 6)', () => {
    expect(LOCK_TIMEOUT_MS / 1000).toBeGreaterThan(Number.parseInt(INSTALL_TIMEOUT, 10) + 60);
  });

  it('does not install under a session already in the machine: its dependencies would change beneath it', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name);
    await runtime({ smolvm }).rt.launch(specOf(), cmd());
    expect(installExec(smolvm)).toBeUndefined();
  });
});

describe('airlock reset', () => {
  it('deletes the workspace\'s machine', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: { state: 'running', image: IMAGE, labels: { 'agenfk.workspace': workspace, 'agenfk.image': IMAGE } } } });
    const { rt } = runtime({ smolvm });
    expect(await rt.reset(workspace)).toBe('deleted');
    expect(smolvm.machines.has(name)).toBe(false);
  });

  it('refuses to delete a machine of that name that belongs to another workspace', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: { state: 'stopped', image: IMAGE, labels: { 'agenfk.workspace': '/somewhere/else', 'agenfk.image': IMAGE } } } });
    await expect(runtime({ smolvm }).rt.reset(workspace)).rejects.toThrow(/\/somewhere\/else/);
    expect(smolvm.machines.has(name)).toBe(true);
    expect(smolvm.verbs()).not.toContain('stop');
  });

  it('says so when the workspace has no machine', async () => {
    expect(await runtime().rt.reset(workspace)).toBe('absent');
  });

  it('refuses while a session is in the machine', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: { state: 'running', image: IMAGE, labels: { 'agenfk.workspace': workspace, 'agenfk.image': IMAGE } } } });
    const sessions = path.join(stateDir, 'machines', name, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'live.json'), JSON.stringify({ pid: process.pid }));
    await expect(runtime({ smolvm }).rt.reset(workspace)).rejects.toThrow(/session/);
    expect(smolvm.machines.has(name)).toBe(true);
  });

  it('runAirlockReset prints what happened and exits 0, or the refusal and 1', async () => {
    const out: string[] = [];
    expect(await runAirlockReset(workspace, { reset: async () => 'deleted', log: (m) => out.push(m) })).toBe(0);
    expect(out.join('\n')).toContain(workspace);
    expect(await runAirlockReset(workspace, { reset: async () => 'absent', log: (m) => out.push(m) })).toBe(0);
    expect(await runAirlockReset(workspace, { reset: async () => { throw new Error('a session is running'); }, log: (m) => out.push(m) })).toBe(1);
    expect(out.join('\n')).toContain('a session is running');
  });
});

describe('buildSandboxSpec, for a runtime that mounts', () => {
  it('names the workspace, the home and the temp dirs a machine keeps its own', () => {
    const spec = specOf();
    expect(spec.workspace).toBe(workspace);
    expect(spec.home).toBe(home);
    expect(spec.filesystem.privateTemp).toEqual([tmpDir]);
  });

  it('names the relay port for a client session, and none for a command', () => {
    expect(specOf({ serverPort: 3123 }).relayPort).toBe(3123);
    expect(specOf({ purpose: 'command' }).relayPort).toBeUndefined();
  });
});

/**
 * CGLAB-696 task 5: a command the AgEnFK server runs (verify, the suite) runs in the workspace's
 * machine - its image, its dependencies. Most often a pi session is in it: pi calls agenfk verify.
 * The command joins it, in a mount namespace of its own made as root, which applies the command's
 * protections and hides the session's other mounts (pi's state) at their paths, then becomes the
 * host user. The machine's network is the one decider's: it stays what it is. ACCEPTED LIMIT (user
 * decision 2026-10-30): not a boundary - through the session's /proc view the command reaches what
 * the session does, its relay to the AgEnFK server included.
 */
describe('a command the server runs, in the workspace machine (CGLAB-696 task 5)', () => {
  const commandSpec = (): SandboxSpec => buildSandboxSpec(
    normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['registry.npmjs.org'] } }),
    session({ purpose: 'command', inferenceHosts: [], serverPort: 0, piAgentDir: undefined }),
  );
  const npmTest = () => ({ file: '/bin/sh', args: ['-c', 'npm test'], cwd: workspace, processGroup: false });
  const spawnArgs = (sp: ReturnType<typeof fakeSpawn>) => sp.spawn.mock.calls[0][1] as string[];
  /** The script root runs in the command's namespace before it becomes the user. */
  const nsSetup = (args: string[]) => args[args.indexOf(COMMAND_IN_NAMESPACE) + 1];
  const inSession = () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name);
    return { name, smolvm };
  };

  it('joins the machine a pi session is in, though its network, keys, mounts and protections differ', async () => {
    const { smolvm } = inSession();
    const { rt, sp, egress } = runtime({ smolvm });
    await rt.launch(commandSpec(), npmTest());
    expect(sp.spawn).toHaveBeenCalledTimes(1);
    expect(smolvm.verbs()).not.toContain('start');
    expect(smolvm.verbs()).not.toContain('update');
    expect(smolvm.calls.filter((c) => c.args[1] === 'mount' && c.args[2] === 'add')).toEqual([]);
    // No route of its own to the server or an injector. The session's stay, and the command can
    // use them (accepted limit, user decision 2026-10-30): this checks only that it adds none.
    expect(egress.addRoute).not.toHaveBeenCalled();
  });

  it('leaves what the session in the machine holds as it is: no setup across the whole machine', async () => {
    const { name, smolvm } = inSession();
    const protections = fs.readFileSync(path.join(stateDir, 'machines', name, 'protections.json'), 'utf8');
    await runtime({ smolvm }).rt.launch(commandSpec(), npmTest());
    expect(smolvm.execs().filter((a) => flag(a, '-u') === 'root')).toEqual([]);
    expect(fs.readFileSync(path.join(stateDir, 'machines', name, 'protections.json'), 'utf8')).toBe(protections);
  });

  it('runs as root in a namespace of its own that hides the session\'s other mounts and applies the command\'s protections, then becomes the host user', async () => {
    const { smolvm } = inSession();
    const { rt, sp } = runtime({ smolvm });
    await rt.launch(commandSpec(), npmTest());
    const args = spawnArgs(sp);
    expect(flag(args, '-u')).toBe('root');
    expect(flag(args, '-w')).toBe(workspace);
    expect(args).toContain(COMMAND_IN_NAMESPACE);
    const setup = nsSetup(args);
    // pi's state is the session's: hidden at its path in the command's namespace (not a
    // boundary: /proc/<pid>/root shows the session's view - accepted limit).
    expect(setup).toContain(`hide_dir '${agentDir}'`);
    // The command's own protections, inside the workspace.
    expect(setup).toContain(`ro '${path.join(workspace, '.agenfk')}'`);
    expect(setup).toContain(`ro '${path.join(workspace, '.git', 'hooks')}'`);
    // Then the user, the session's pid file, and the command - as given.
    const after = args.slice(args.indexOf(COMMAND_IN_NAMESPACE) + 2);
    expect(after.slice(0, 2)).toEqual(['503', '20']);
    expect(after[2]).toMatch(/^\/run\/agenfk\/sessions\/[0-9a-f]{16}\.pid$/);
    expect(after.slice(3)).toEqual(['/bin/sh', '-c', 'npm test']);
  });

  it('a signal reaches the command through the same pid file, as the host user', async () => {
    const { smolvm } = inSession();
    const { rt, sp } = runtime({ smolvm });
    const launched = await rt.launch(commandSpec(), npmTest());
    const pidFile = spawnArgs(sp)[spawnArgs(sp).indexOf(COMMAND_IN_NAMESPACE) + 4];
    expect(launched.kill('SIGTERM')).toBe(true);
    await settle();
    const kill = smolvm.execs().find((a) => a.join(' ').includes('kill -TERM'));
    expect(flag(kill!, '-u')).toBe('503:20');
    expect(kill).toContain(pidFile);
  });

  it('is refused when it needs a mount the machine does not hold: the session may not see it', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    // A session elsewhere holds only pi's state: the workspace would have to be mounted under it.
    smolvm.mounts.set(name, [{ source: agentDir, target: agentDir, readOnly: false }]);
    liveSession(name);
    const { rt, sp } = runtime({ smolvm });
    await expect(rt.launch(commandSpec(), npmTest())).rejects.toThrow(/Another session is in the Airlock machine.*mount/s);
    expect(sp.spawn).not.toHaveBeenCalled();
  });

  it('is refused when the session holds a mount above the workspace: hiding it would hide the workspace', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, [...sameMounts(), { source: path.dirname(workspace), target: path.dirname(workspace), readOnly: false }]);
    liveSession(name);
    const { rt, sp } = runtime({ smolvm });
    await expect(rt.launch(commandSpec(), npmTest())).rejects.toThrow(/nothing was launched/i);
    expect(sp.spawn).not.toHaveBeenCalled();
  });

  it('keeps the machine running for the session when it ends, and the session\'s for it', async () => {
    const { name, smolvm } = inSession();
    const { rt, sp } = runtime({ smolvm });
    const launched = await rt.launch(commandSpec(), npmTest());
    sp.children[0].finish(0);
    expect(await launched.exited).toEqual({ code: 0, signal: null });
    expect(smolvm.verbs()).not.toContain('stop');
    expect(smolvm.machines.get(name)!.state).toBe('running');
  });

  it('a client session still may not join a machine on other terms: only a command does', async () => {
    const name = machineNameOf(workspace);
    const smolvm = fakeSmolvm({ machines: { [name]: running(name) } });
    smolvm.mounts.set(name, sameMounts());
    liveSession(name, 'other', commandSpec().network);
    await expect(runtime({ smolvm }).rt.launch(specOf(), cmd())).rejects.toThrow(/different network policy/);
  });

  it('alone, it starts the machine under the command\'s network, with no relay, and still runs in its own namespace', async () => {
    const { rt, smolvm, sp, egress } = runtime();
    const spec = commandSpec();
    await rt.launch(spec, npmTest());
    const update = smolvm.calls.find((c) => c.args[1] === 'update')!;
    expect(update.args.slice(4)).toEqual(allowListArgs(spec.network));
    expect(smolvm.verbs()).toContain('start');
    expect(egress.addRoute).not.toHaveBeenCalled();
    expect(spawnArgs(sp)).toContain(COMMAND_IN_NAMESPACE);
    // Nothing of the session's to hide: nothing is mounted but the workspace.
    expect(nsSetup(spawnArgs(sp))).not.toContain(agentDir);
  });

  it('gets the spec\'s env and HOME, never the host\'s PATH', async () => {
    const { smolvm } = inSession();
    const { rt, sp } = runtime({ smolvm });
    const spec = commandSpec();
    spec.env.CI = '1';
    await rt.launch(spec, npmTest());
    const env = spawnArgs(sp).flatMap((a, i, all) => (all[i - 1] === '-e' ? [a] : []));
    expect(env).toEqual(expect.arrayContaining(['CI=1', `HOME=${home}`, 'TMPDIR=/tmp', 'AGENFK_AIRLOCK_SANDBOX=command']));
    expect(env.some((e) => e.startsWith('PATH='))).toBe(false);
  });
});

/**
 * COMMAND_IN_NAMESPACE, run by a real sh with stand-ins for util-linux's unshare, setpriv and
 * setsid that record how they were called and run what they are given.
 */
describe.skipIf(process.platform === 'win32')('COMMAND_IN_NAMESPACE, run by sh', () => {
  let bin: string;
  let log: string;
  beforeEach(() => {
    bin = path.join(root, 'bin');
    log = path.join(root, 'calls.log');
    fs.mkdirSync(bin);
    // Each logs its arguments, drops its own options up to --, and runs the rest.
    for (const tool of ['unshare', 'setpriv']) {
      fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(log)}\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n`, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(bin, 'setsid'), `#!/bin/sh\necho "setsid $*" >> ${JSON.stringify(log)}\nexec "$@"\n`, { mode: 0o755 });
  });
  const run = (setup: string, command: string[], pathDirs = [bin, '/usr/bin', '/bin']) => spawnSync('/bin/sh', [
    '-c', COMMAND_IN_NAMESPACE, setup, '503', '20', path.join(root, 'cmd.pid'), ...command,
  ], { encoding: 'utf8', cwd: root, env: { PATH: pathDirs.join(':') } });

  it('applies the setup in a private mount namespace, becomes the user, and runs the command as a session leader with its exit code', () => {
    const r = run('echo setup-ran > setup.out', ['sh', '-c', 'echo "$1" > ran.out; exit 4', 'sh', 'an arg']);
    expect(r.status).toBe(4);
    expect(fs.readFileSync(path.join(root, 'setup.out'), 'utf8')).toBe('setup-ran\n');
    expect(fs.readFileSync(path.join(root, 'ran.out'), 'utf8')).toBe('an arg\n');
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).toMatch(/^unshare .*--mount.*--propagation private/m);
    expect(calls).toMatch(/^setpriv .*--reuid=503 --regid=20 --clear-groups/m);
    expect(calls).toMatch(/^setsid /m);
    // The pid file holds the command's pid, for a signal to find.
    expect(fs.readFileSync(path.join(root, 'cmd.pid'), 'utf8')).toMatch(/^\d+\n$/);
  });

  it('a setup that fails: the command never runs, 125 with the reason', () => {
    const r = run('exit 3', ['sh', '-c', 'echo ran > ran.out']);
    expect(r.status).toBe(125);
    expect(r.stderr).toMatch(/could not apply the command's protections/);
    expect(fs.existsSync(path.join(root, 'ran.out'))).toBe(false);
    expect(fs.readFileSync(log, 'utf8')).not.toMatch(/^setpriv/m);
  });

  it('an image without util-linux\'s unshare, setpriv or setsid: the command never runs, 125 with the reason', () => {
    for (const missing of ['unshare', 'setpriv', 'setsid']) {
      fs.rmSync(log, { force: true });
      const partial = path.join(root, `bin-no-${missing}`);
      fs.mkdirSync(partial);
      for (const t of ['unshare', 'setpriv', 'setsid'].filter((x) => x !== missing)) fs.copyFileSync(path.join(bin, t), path.join(partial, t));
      for (const t of fs.readdirSync(partial)) fs.chmodSync(path.join(partial, t), 0o755);
      // Only sh beside the stand-ins: a real util-linux in /bin or /usr/bin (Linux) must not stand in for the missing one.
      fs.symlinkSync('/bin/sh', path.join(partial, 'sh'));
      const r = run('echo setup-ran > setup.out', ['sh', '-c', 'echo ran > ran.out'], [partial]);
      expect(r.status, missing).toBe(125);
      expect(r.stderr, missing).toMatch(new RegExp(`${missing}.*util-linux|util-linux.*${missing}`));
      expect(fs.existsSync(path.join(root, 'ran.out')), missing).toBe(false);
      expect(fs.existsSync(path.join(root, 'setup.out')), missing).toBe(false);
    }
  });
});

/**
 * Review 01a18ca1: the server kills a command's host process group with SIGKILL on a timeout, and
 * a host-side `smolvm machine exec` that dies leaves its command running in the guest (measured).
 * A watchdog of its own, outside that group, ends the guest command when the launcher is gone.
 */
describe('a launcher killed outright (review 01a18ca1)', () => {
  it('starts a watchdog that, once this process is gone, kills the command\'s group in the guest through its pid file', async () => {
    const { rt, sp, watchdog } = runtime();
    await rt.launch(specOf(), cmd());
    expect(watchdog.start).toHaveBeenCalledTimes(1);
    const args = watchdog.start.mock.calls[0][0];
    expect(args[1]).toBe('machine');
    const pidFile = (sp.spawn.mock.calls[0][1] as string[]).find((a) => a.startsWith('/run/agenfk/sessions/'));
    expect(args).toContain(pidFile);
    expect(flag(args, '-u')).toBe('503:20');
    expect(args.join(' ')).toMatch(/kill -KILL -\$pid/);
  });

  it('stops the watchdog only once the leftovers in the guest are killed: the launcher may die meanwhile', async () => {
    const smolvm = fakeSmolvm();
    const { rt, sp, watchdog } = runtime({ smolvm });
    const launched = await rt.launch(specOf(), cmd());
    let stoppedAtLeftovers: number | null = null;
    smolvm.run.mockImplementation(((orig) => async (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      if (args.join(' ').includes('kill -KILL')) stoppedAtLeftovers = watchdog.stopped;
      return orig(args, opts);
    })(smolvm.run.getMockImplementation()!) as any);
    sp.children[0].finish(0);
    await launched.exited;
    expect(stoppedAtLeftovers).toBe(0);
    expect(watchdog.stopped).toBe(1);
  });

  it('starts none when the launch fails before anything runs', async () => {
    const { rt, watchdog } = runtime({ smolvm: fakeSmolvm({ startFails: 'no' }) });
    await expect(rt.launch(specOf(), cmd())).rejects.toThrow();
    expect(watchdog.start).not.toHaveBeenCalled();
  });
});

/**
 * WATCHDOG, run by sh: it watches the launcher through its stdin, a pipe the launcher alone holds
 * open - closed however the launcher ends, before any reaping, whatever pid comes next.
 */
describe.skipIf(process.platform === 'win32')('WATCHDOG, run by sh', () => {
  it('waits while its stdin is open, and runs its command once it closes', async () => {
    const { spawn } = await import('child_process');
    const out = path.join(root, 'fired');
    const dog = spawn('/bin/sh', ['-c', WATCHDOG, 'sh', '/bin/sh', '-c', `echo fired > ${out}`], { stdio: ['pipe', 'ignore', 'ignore'] });
    await new Promise((r) => setTimeout(r, 800));
    expect(fs.existsSync(out)).toBe(false);
    dog.stdin!.end();
    await new Promise((r) => dog.once('exit', r));
    expect(fs.readFileSync(out, 'utf8')).toBe('fired\n');
  }, 15_000);

  it('fires when the Node process holding the pipe is SIGKILLed', async () => {
    const { spawn } = await import('child_process');
    const out = path.join(root, 'fired');
    // A launcher stand-in: starts the watchdog as the runtime does (detached, stdin a pipe it holds), then waits.
    const script = `const c = require('child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(WATCHDOG)}, 'sh', '/bin/sh', '-c', 'echo fired > ' + ${JSON.stringify(out)}], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });`
      + ' c.unref(); console.log("up"); setInterval(() => {}, 1000);';
    const holder = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((r) => holder.stdout!.once('data', r));
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(out)).toBe(false);
    holder.kill('SIGKILL');
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(out, 'utf8')).toBe('fired\n');
  }, 15_000);
});

// The real smolvm, where it is installed and can run here (Apple Silicon, or Linux with KVM).
const smolvmHere = (() => {
  if (process.env.AGENFK_SMOLVM_TESTS !== '1') return false;
  const v = spawnSync('smolvm', ['--version'], { encoding: 'utf8' });
  return v.status === 0 && v.stdout.includes(SMOLVM_VERSION);
})();

/** Answers every flow "allow", after reading its header (protocol v2). */
function allowAllInterceptor(): Promise<{ address: string; token: string; close(): void }> {
  const token = 'b'.repeat(64);
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 8 + 32 + 16 + 16 + 1) return;
      const family = buf[8 + 32 + 32];
      const ipLen = family === 6 ? 16 : 4;
      const fixed = 8 + 32 + 32 + 1 + 2 + ipLen;
      if (buf.length < fixed + 2) return;
      const payload = buf.readUInt16BE(fixed);
      if (buf.length < fixed + 2 + payload) return;
      sock.write(Buffer.from([0]));
      sock.end();
    });
    sock.on('error', () => undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as net.AddressInfo;
    resolve({ address: `127.0.0.1:${port}`, token, close: () => server.close() });
  }));
}

/**
 * The AgEnFK base image, built locally and saved: `docker build -f airlock-image/Dockerfile -t agenfk-airlock-base:dev .`
 * then `docker save agenfk-airlock-base:dev -o <file>`, and AGENFK_AIRLOCK_TEST_IMAGE=<file>.
 */
const baseImageArchive = process.env.AGENFK_AIRLOCK_TEST_IMAGE;

describe.skipIf(!smolvmHere || !baseImageArchive)('the AgEnFK base image in a real machine (AGENFK_AIRLOCK_TEST_IMAGE)', () => {
  it('runs its tools as the session user, and installs the workspace\'s dependencies in the guest\'s own node_modules', async () => {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'w', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } }));
    fs.writeFileSync(path.join(workspace, 'package-lock.json'), JSON.stringify({
      name: 'w', version: '1.0.0', lockfileVersion: 3, requires: true,
      packages: {
        '': { name: 'w', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } },
        'node_modules/is-number': {
          version: '7.0.0', resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
          integrity: 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
          engines: { node: '>=0.12.0' },
        },
      },
    }));
    // The host's own node_modules: the guest neither sees nor changes it.
    fs.writeFileSync(path.join(workspace, 'node_modules', 'host-only'), 'host\n');
    const icpt = await allowAllInterceptor();
    const egress: EgressBroker = {
      ensure: async () => ({ address: icpt.address, token: icpt.token }),
      watch: () => () => undefined,
      stop: async () => undefined,
      routeSocket: () => path.join(fs.mkdtempSync(path.join('/tmp', 'agenfk-r-')), 's.sock'),
      addRoute: () => () => undefined,
    };
    const warnings: string[] = [];
    const rt = new SmolvmRuntime({ image: baseImageArchive!, egress, stateDir, isTTY: false, hostEnv: {}, warn: (m) => warnings.push(m) });
    const sandboxHome = process.env.HOME;
    process.env.HOME = os.userInfo().homedir;
    try {
      const out = path.join(workspace, 'probe.out');
      const probe = [
        'for c in node pi opencode agenfk git psql mysql redis-cli mongosh python3 yarn pnpm; do command -v $c >/dev/null || echo "missing $c"; done',
        'ssh -V 2>&1 | grep -q OpenSSH || echo "ssh: $(ssh -V 2>&1)"',
        // The image's ENV reaches the session: pnpm and yarn run from the corepack home it prepared.
        '[ "$COREPACK_HOME" = /usr/local/share/corepack ] || echo "COREPACK_HOME=$COREPACK_HOME"',
        'pnpm --version >/dev/null 2>&1 || echo pnpm-failed',
        'node -e "require(\'is-number\')" || echo is-number-missing',
        'test -e node_modules/host-only && echo host-node_modules-visible',
        'python3 -m venv /tmp/v >/dev/null || echo venv-failed',
      ].join('; ');
      // Enforce: the registry resolves in the guest only when the policy allows it.
      const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['registry.npmjs.org'] } }), session());
      const launched = await rt.launch(spec, { file: 'sh', args: ['-c', `(${probe}) > ${out} 2>&1`], cwd: workspace });
      expect((await launched.exited).code).toBe(0);
      expect(warnings).toEqual([]);
      expect(fs.readFileSync(out, 'utf8')).toBe('');
      expect(fs.readdirSync(path.join(workspace, 'node_modules'))).toEqual(['dep', 'host-only']);
    } finally {
      await rt.reset(workspace).catch(() => undefined);
      await rt.dispose();
      icpt.close();
      process.env.HOME = sandboxHome;
    }
  }, 600_000);

  it('runs a command the server gives beside a session in the machine: the workspace, pi\'s state hidden at its path, and its exit code', async () => {
    const icpt = await allowAllInterceptor();
    const egress: EgressBroker = {
      ensure: async () => ({ address: icpt.address, token: icpt.token }),
      watch: () => () => undefined,
      stop: async () => undefined,
      routeSocket: () => path.join(fs.mkdtempSync(path.join('/tmp', 'agenfk-r-')), 's.sock'),
      addRoute: () => () => undefined,
    };
    const rt = new SmolvmRuntime({ image: baseImageArchive!, egress, stateDir, isTTY: false, hostEnv: {} });
    const sandboxHome = process.env.HOME;
    process.env.HOME = os.userInfo().homedir;
    try {
      // pi's stand-in: a session that stays in the machine until the command is done.
      const piSpec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['api.github.com'] } }), session({ inferenceHosts: [] }));
      const pi = await rt.launch(piSpec, { file: 'sh', args: ['-c', `while [ ! -e done ]; do sleep 0.2; done; ls ${agentDir} | grep -qx sessions && echo pi-sees-its-state > pi.out`], cwd: workspace });
      await new Promise((r) => setTimeout(r, 1500));
      const commandSpec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce' }),
        session({ purpose: 'command', inferenceHosts: [], serverPort: 0, piAgentDir: undefined }));
      const out = path.join(workspace, 'command.out');
      const probe = [
        'echo made > made-by-command',
        `ls ${agentDir} 2>/dev/null | grep -q . && echo pi-state-visible`,
        `{ echo x > ${path.join(workspace, '.agenfk', 'planted')}; } 2>/dev/null && echo agenfk-writable`,
        '[ "$(id -u)" = "' + os.userInfo().uid + '" ] || echo "uid $(id -u)"',
        'exit 5',
      ].join('; ');
      const command = await rt.launch(commandSpec, { file: '/bin/sh', args: ['-c', `(${probe}) > ${out} 2>&1`], cwd: workspace, processGroup: false });
      expect((await command.exited).code).toBe(5);
      expect(fs.readFileSync(out, 'utf8')).toBe('');
      expect(fs.readFileSync(path.join(workspace, 'made-by-command'), 'utf8')).toBe('made\n');
      // The session in the machine still sees its own state: the command's namespace was its own.
      fs.writeFileSync(path.join(workspace, 'done'), '');
      expect((await pi.exited).code).toBe(0);
      expect(fs.readFileSync(path.join(workspace, 'pi.out'), 'utf8')).toBe('pi-sees-its-state\n');
    } finally {
      await rt.reset(workspace).catch(() => undefined);
      await rt.dispose();
      icpt.close();
      process.env.HOME = sandboxHome;
    }
  }, 600_000);
});

describe.skipIf(!smolvmHere || !baseImageArchive)('a linked git worktree in a real machine (CGLAB-696 task 7)', () => {
  it('git works in the worktree as the session user, commits land, and the main checkout\'s config, hooks and other worktrees stay out of reach', async () => {
    const run = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    const main = path.join(root, 'work', 'main');
    fs.mkdirSync(main, { recursive: true });
    run(main, 'init', '-q');
    run(main, 'commit', '-q', '--allow-empty', '-m', 'first');
    const wt = path.join(root, 'work', 'wt');
    run(main, 'worktree', 'add', '-q', wt);
    run(main, 'worktree', 'add', '-q', path.join(root, 'work', 'other'));
    const common = fs.realpathSync(path.join(main, '.git'));
    const icpt = await allowAllInterceptor();
    const egress: EgressBroker = {
      ensure: async () => ({ address: icpt.address, token: icpt.token }), watch: () => () => undefined, stop: async () => undefined,
      routeSocket: () => path.join(fs.mkdtempSync(path.join('/tmp', 'agenfk-r-')), 's.sock'), addRoute: () => () => undefined,
    };
    const rt = new SmolvmRuntime({ image: baseImageArchive!, egress, stateDir, isTTY: false, hostEnv: {} });
    const sandboxHome = process.env.HOME;
    process.env.HOME = os.userInfo().homedir;
    try {
      const out = path.join(wt, 'probe.out');
      const probe = [
        'git status --porcelain >/dev/null || echo status-failed',
        'echo x > f && git add f && git -c user.email=g@g -c user.name=g commit -qm in-guest || echo commit-failed',
        `cat ${path.join(common, 'worktrees', 'other', 'HEAD')} >/dev/null 2>&1 && echo other-worktree-visible`,
        `{ echo x >> ${path.join(common, 'config')}; } 2>/dev/null && echo common-config-writable`,
        `{ echo x > ${path.join(common, 'hooks', 'pre-commit')}; } 2>/dev/null && echo hooks-writable`,
        `{ echo /tmp > ${path.join(common, 'worktrees', 'wt', 'commondir')}; } 2>/dev/null && echo commondir-writable`,
        `{ echo x > .git; } 2>/dev/null && echo pointer-writable`,
        `mkdir ${path.join(common, 'worktrees', 'planted')} 2>/dev/null && echo worktrees-writable`,
        `{ echo /tmp > ${path.join(common, 'commondir')}; } 2>/dev/null && echo common-commondir-writable`,
        `mkdir -p ${path.join(common, 'modules', 'x')} 2>/dev/null && echo modules-writable`,
        `{ echo x >> ${path.join(common, 'info', 'exclude')}; } 2>/dev/null && echo info-writable`,
        `{ echo x > ${path.join(common, 'index')}; } 2>/dev/null && echo main-index-writable`,
        // The verdict is the output: the refusals above leave the last status non-zero.
        'true',
      ].join('; ');
      const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce' }), session({ workspace: wt, gitDir: null, inferenceHosts: [] }));
      const launched = await rt.launch(spec, { file: 'sh', args: ['-c', `(${probe}) > ${out} 2>&1`], cwd: wt });
      expect((await launched.exited).code).toBe(0);
      expect(fs.readFileSync(out, 'utf8')).toBe('');
      // The commit is the host repository's.
      expect(run(main, 'log', '--all', '--format=%s').stdout).toContain('in-guest');
    } finally {
      await rt.reset(wt).catch(() => undefined);
      await rt.dispose();
      icpt.close();
      process.env.HOME = sandboxHome;
    }
  }, 600_000);
});

describe.skipIf(!smolvmHere || !baseImageArchive)('the machine\'s resolver in a real machine (CGLAB-696 task 8)', () => {
  const inMachine = async (policy: Parameters<typeof normalizeAirlockPolicy>[0], probe: string) => {
    const icpt = await allowAllInterceptor();
    const egress: EgressBroker = {
      ensure: async () => ({ address: icpt.address, token: icpt.token }), watch: () => () => undefined, stop: async () => undefined,
      routeSocket: () => path.join(fs.mkdtempSync(path.join('/tmp', 'agenfk-r-')), 's.sock'), addRoute: () => () => undefined,
    };
    const rt = new SmolvmRuntime({ image: baseImageArchive!, egress, stateDir, isTTY: false, hostEnv: {} });
    const sandboxHome = process.env.HOME;
    process.env.HOME = os.userInfo().homedir;
    try {
      const out = path.join(workspace, `dns-${Date.now()}.out`);
      const spec = buildSandboxSpec(normalizeAirlockPolicy(policy), session({ inferenceHosts: [] }));
      const launched = await rt.launch(spec, { file: 'sh', args: ['-c', `(${probe}; true) > ${out} 2>&1`], cwd: workspace });
      expect((await launched.exited).code).toBe(0);
      return fs.readFileSync(out, 'utf8');
    } finally {
      await rt.reset(workspace).catch(() => undefined);
      await rt.dispose();
      icpt.close();
      process.env.HOME = sandboxHome;
    }
  };
  /** A raw DNS question to `server` (python3 in the image): `rcode <n>` of the answer, or `silent`. */
  const raw = (server: string, name: string) => `python3 -c 'import socket,sys
q=bytes([0x12,0x34,1,0,0,1,0,0,0,0,0,0])+b"".join(bytes([len(l)])+l.encode() for l in sys.argv[2].split("."))+bytes([0,0,1,0,1])
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(3)
try:
  s.sendto(q,(sys.argv[1],53));print("rcode",s.recv(512)[3]&15)
except Exception: print("silent")' ${server} ${name}`;

  it('observe: a denied name does not resolve, whichever resolver is asked; an allowed one resolves; the session cannot stop it', async () => {
    const out = await inMachine({ mode: 'observe', hosts: { allow: [], deny: ['example.org'] } }, [
      'getent hosts example.org >/dev/null && echo denied-resolved',
      'getent hosts nextjs.org >/dev/null || echo allowed-failed',
      // Every port-53 question is the machine's resolver's, wherever it was sent.
      `echo "smolvm's $(${raw("$(cat /run/agenfk/dns/upstream)", 'example.org')})"`,
      `echo "another $(${raw('1.1.1.1', 'example.org')})"`,
      `echo "allowed $(${raw("$(cat /run/agenfk/dns/upstream)", 'nextjs.org')})"`,
      // The resolver runs as its own user (997): the session's kill is refused. (Not pkill -f: it would match this very probe.)
      'kill $(pgrep -u 997) 2>/dev/null && echo resolver-killable',
      '{ echo 2000 > /proc/sys/net/ipv4/ip_unprivileged_port_start; } 2>/dev/null && echo port-threshold-writable',
    ].join('; '));
    expect(out.split('\n').filter(Boolean)).toEqual(["smolvm's rcode 3", 'another rcode 3', 'allowed rcode 0']);
  }, 600_000);

  it('enforce: a denied name under an allowed wildcard does not resolve; its allowed siblings do', async () => {
    const out = await inMachine({ mode: 'enforce', hosts: { allow: ['*.github.com'], deny: ['gist.github.com'] } }, [
      'getent hosts gist.github.com >/dev/null && echo denied-resolved',
      'getent hosts api.github.com >/dev/null || echo allowed-failed',
    ].join('; '));
    expect(out).toBe('');
  }, 600_000);
});

describe.skipIf(!smolvmHere || !baseImageArchive)('SmolvmRuntime against the real smolvm (AGENFK_SMOLVM_TESTS=1, AGENFK_AIRLOCK_TEST_IMAGE)', () => {
  it('runs a command in the workspace machine: exit code, writes, protections, hidden files', async () => {
    fs.mkdirSync(path.join(workspace, '.claude', 'commands', 'tool', '.agenfk'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'scripts'));
    fs.writeFileSync(path.join(workspace, 'scripts', 'pre-commit.sh'), '#!/bin/sh\n');
    fs.symlinkSync('../../scripts/pre-commit.sh', path.join(workspace, '.git', 'hooks', 'pre-commit'));
    const icpt = await allowAllInterceptor();
    const egress: EgressBroker = {
      ensure: async () => ({ address: icpt.address, token: icpt.token }),
      watch: () => () => undefined,
      stop: async () => undefined,
      routeSocket: () => path.join(fs.mkdtempSync(path.join('/tmp', 'agenfk-r-')), 's.sock'),
      addRoute: () => () => undefined,
    };
    // The AgEnFK base image: enforce needs node and iptables in it since CGLAB-696 task 8 (the machine's resolver).
    const rt = new SmolvmRuntime({ image: baseImageArchive!, egress, stateDir, isTTY: false, hostEnv: {} });
    // smolvm keeps its sockets under HOME, and a vitest worker's sandbox HOME is past the 103-byte socket path limit.
    const sandboxHome = process.env.HOME;
    process.env.HOME = os.userInfo().homedir;
    try {
      const probe = [
        'echo made > made-by-guest',
        `{ echo x > ${path.join(workspace, '.agenfk', 'planted')}; } 2>/dev/null && echo agenfk-writable`,
        `{ echo x > ${path.join(workspace, '.git', 'hooks', 'pre-commit')}; } 2>/dev/null && echo hooks-writable`,
        `grep -q fake ${path.join(agentDir, 'auth.json')} && echo auth-readable`,
        `test -e ${path.join(home, '.ssh', 'id_fake')} && echo ssh-visible`,
        // Moving .git aside to plant a fresh one around its read-only hooks.
        '{ mv .git .git-moved; } 2>/dev/null && echo git-renamed',
        // Moving a protected .agenfk's parent aside to plant a fresh one in its place.
        '{ mv packages/a packages/a-moved; } 2>/dev/null && echo ancestor-renamed',
        // The script a hook links to is read-only with the hook.
        `{ echo x >> ${path.join(workspace, 'scripts', 'pre-commit.sh')}; } 2>/dev/null && echo hook-target-writable`,
        // .claude/commands is read-only though a protected .agenfk lies below it.
        `{ echo x > ${path.join(workspace, '.claude', 'commands', 'planted.md')}; } 2>/dev/null && echo commands-writable`,
        'exit 7',
      ].join('; ');
      const out = path.join(workspace, 'probe.out');
      // auth.json in both deny lists: bound read-only AND hidden, and hidden it must stay.
      const base = specOf();
      const spec = { ...base, filesystem: { ...base.filesystem, denyWrite: [...base.filesystem.denyWrite, path.join(agentDir, 'auth.json')] } };
      const launched = await rt.launch(spec, { file: 'sh', args: ['-c', `(${probe}) > ${out} 2>&1`], cwd: workspace });
      const exit = await launched.exited;
      expect(exit.code).toBe(7);
      expect(fs.readFileSync(path.join(workspace, 'made-by-guest'), 'utf8')).toBe('made\n');
      expect(fs.readFileSync(out, 'utf8')).toBe('');
      expect(fs.existsSync(path.join(workspace, '.git', 'commondir'))).toBe(false);

      // A signal reaches the command inside the guest.
      const looping = await rt.launch(specOf(), { file: 'sh', args: ['-c', 'trap "exit 143" TERM; while :; do sleep 0.2; done'], cwd: workspace });
      await new Promise((r) => setTimeout(r, 1500));
      expect(looping.kill('SIGTERM')).toBe(true);
      const ended = await Promise.race([looping.exited, new Promise((r) => setTimeout(() => r('still running'), 20_000))]);
      expect(ended).toEqual({ code: 143, signal: null });
    } finally {
      await rt.reset(workspace).catch(() => undefined);
      await rt.dispose();
      icpt.close();
      process.env.HOME = sandboxHome;
    }
  }, 180_000);
});
