/**
 * Airlock layer 2 (GH-294, L2-3): the launch gate. In enforce mode, a session
 * the policy covers that is NOT running inside the Airlock sandbox has every
 * tool call refused with "relaunch with agenfk airlock pi|opencode". Checked per
 * tool call, so switching mid-session to a covered model is caught.
 *
 * "Inside the sandbox" is the marker, the proxy env, and ~/.agenfk being
 * unwritable (the sandbox denies writes there; outside it is the user's own
 * directory): env vars alone do not make a session sandboxed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
// @ts-ignore — .ts extension is loaded by pi via jiti; here we import it directly.
import activate, { airlockSandboxed } from '../../../../bin/agenfk-pi-extension.ts';

const PLUGIN = path.resolve(__dirname, '../../../../bin/agenfk-airlock-opencode.mjs');
const REAL_SCRIPT = path.resolve(__dirname, '../../../../bin/agenfk-airlock.mjs');

const SANDBOX_ENV = { AGENFK_AIRLOCK_SANDBOX: 'pi', HTTPS_PROXY: 'http://u:p@localhost:5555' };
const eperm = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
const enoent = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

function ok(verdict: any, mode = 'enforce', applies = true) {
  return { status: 'ok', verdict, mode, applies, revision: 1, source: 'local' };
}
const ALLOW = { decision: 'allow', why: 'no-rule-matched' };

const CONFINED = () => ({ confined: true });
const NOT_CONFINED = () => ({ confined: false, reason: 'a direct connection was not refused' });

/** A fake net.connect: emits what the test says, or nothing (a timeout). */
function fakeConnect(outcome: { error?: string } | 'connect' | 'silent') {
  return vi.fn(() => {
    const sock = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    setImmediate(() => {
      if (outcome === 'connect') sock.emit('connect');
      else if (outcome !== 'silent') sock.emit('error', Object.assign(new Error(outcome.error), { code: outcome.error }));
    });
    return sock;
  });
}

describe('confinement proof (review fix 6)', () => {
  it('a direct connection refused by the sandbox proves confinement; anything else does not', async () => {
    const mod = await import(pathToFileURL(REAL_SCRIPT).href);
    const prove = (outcome: any, platform = 'darwin') => mod.proveConfinement({ connect: fakeConnect(outcome), timeoutMs: 50, platform });
    expect(await prove({ error: 'EPERM' })).toMatchObject({ confined: true });
    expect(await prove({ error: 'EACCES' })).toMatchObject({ confined: true });
    expect(await prove({ error: 'ENETUNREACH' }, 'darwin')).toMatchObject({ confined: false });
    expect(await prove({ error: 'ECONNREFUSED' })).toMatchObject({ confined: false });
    expect(await prove('connect')).toMatchObject({ confined: false });
    const silent = await prove('silent');
    expect(silent.confined).toBe(false);
    expect(silent.reason).toMatch(/no answer|offline/i);
  });

  // Linux is unmeasured on this Mac: the evidence follows bwrap --unshare-net,
  // whose fresh network namespace holds the loopback device and nothing else.
  const NETDEV = (...devs: string[]) => 'Inter-|   Receive\n face |bytes\n' + devs.map((d) => `  ${d}: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`).join('');
  it('Linux: kernel evidence, not a connect error: a network namespace holding only loopback', async () => {
    const mod = await import(pathToFileURL(REAL_SCRIPT).href);
    const connect = fakeConnect({ error: 'ENETUNREACH' });
    const linux = (netdev: string | null, extra: object = {}) => mod.proveConfinement({
      platform: 'linux', connect,
      readFile: () => { if (netdev === null) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return netdev; },
      readlink: () => 'net:[4026532301]',
      env: {},
      ...extra,
    });
    expect(await linux(NETDEV('lo'))).toMatchObject({ confined: true });
    // An offline host still lists its (down) devices; ENETUNREACH never counts.
    expect(await linux(NETDEV('lo', 'eth0'))).toMatchObject({ confined: false });
    expect(await linux(NETDEV('lo', 'wlan0'))).toMatchObject({ confined: false });
    const none = await linux(null);
    expect(none.confined).toBe(false);
    expect(none.reason).toMatch(/Linux.*refused|refused.*Linux/s);
    // The launcher's own namespace, when it passed it: the same one is not a sandbox.
    expect(await linux(NETDEV('lo'), { env: { AGENFK_AIRLOCK_HOST_NETNS: 'net:[4026532301]' } })).toMatchObject({ confined: false });
    expect(await linux(NETDEV('lo'), { env: { AGENFK_AIRLOCK_HOST_NETNS: 'net:[4026531840]' } })).toMatchObject({ confined: true });
    expect(connect).not.toHaveBeenCalled();
  });

  it('probes once per process', async () => {
    const mod = await import(pathToFileURL(REAL_SCRIPT).href);
    const connect = fakeConnect({ error: 'EPERM' });
    const once = mod.confinementOnce({ connect, timeoutMs: 50, platform: 'darwin' });
    expect(await once()).toMatchObject({ confined: true });
    expect(await once()).toMatchObject({ confined: true });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('the shared script (OpenCode): marker + proxy env + unwritable ~/.agenfk + confinement', async () => {
    const mod = await import(pathToFileURL(REAL_SCRIPT).href);
    const check = (env: any, access: any, prove: any) => mod.airlockSandboxCheck({ env, homeDir: '/h', access, prove });
    expect(await check(SANDBOX_ENV, eperm, CONFINED)).toEqual({ sandboxed: true });
    // Forged: env set and ~/.agenfk chmod-ed read-only, but the process is not confined.
    const forged = await check(SANDBOX_ENV, () => { throw Object.assign(new Error(''), { code: 'EACCES' }); }, NOT_CONFINED);
    expect(forged.sandboxed).toBe(false);
    expect(forged.reason).toMatch(/not refused/);
    expect((await check(SANDBOX_ENV, () => undefined, CONFINED)).sandboxed).toBe(false);
    expect((await check({ HTTPS_PROXY: 'x' }, eperm, CONFINED)).sandboxed).toBe(false);
    expect((await check({ AGENFK_AIRLOCK_SANDBOX: 'opencode' }, eperm, CONFINED)).sandboxed).toBe(false);
  });

  it('pi extension: the same rule', () => {
    expect(airlockSandboxed(SANDBOX_ENV, '/h', eperm, CONFINED)).toEqual({ sandboxed: true });
    expect(airlockSandboxed(SANDBOX_ENV, '/h', eperm, NOT_CONFINED).sandboxed).toBe(false);
    expect(airlockSandboxed(SANDBOX_ENV, '/h', () => undefined, CONFINED).sandboxed).toBe(false);
    expect(airlockSandboxed(SANDBOX_ENV, '/h', enoent, CONFINED).sandboxed).toBe(false);
    expect(airlockSandboxed({ HTTPS_PROXY: 'http://x' }, '/h', eperm, CONFINED).sandboxed).toBe(false);
    expect(airlockSandboxed({ AGENFK_AIRLOCK_SANDBOX: 'pi' }, '/h', eperm, CONFINED).sandboxed).toBe(false);
  });

  it('the real check, outside any sandbox: not sandboxed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-home-'));
    fs.mkdirSync(path.join(home, '.agenfk'));
    const mod = await import(pathToFileURL(REAL_SCRIPT).href);
    expect((await mod.airlockSandboxCheck({ env: SANDBOX_ENV, homeDir: home, prove: NOT_CONFINED })).sandboxed).toBe(false);
    expect(airlockSandboxed(SANDBOX_ENV, home, undefined, CONFINED).sandboxed).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// ── pi ──────────────────────────────────────────────────────────────────────

function makeFakePi() {
  const handlers: Record<string, Function> = {};
  const pi = { on: (event: string, h: Function) => { handlers[event] = h; }, sendMessage: () => {} };
  const fire = (event: string, payload: any, ctx: any = {}) => (handlers[event] ? handlers[event](payload, ctx) : undefined);
  return { pi, fire };
}
function piDeps(over: any = {}) {
  return {
    gatekeeperVerdict: vi.fn().mockReturnValue(null),
    enforcerVerdict: vi.fn().mockReturnValue(null),
    readVerdict: vi.fn().mockReturnValue(null),
    prReminder: vi.fn().mockReturnValue(null),
    readDefaultModel: () => null,
    readTranscriptModel: () => null,
    readEnvModel: () => null,
    airlockVerdict: vi.fn().mockReturnValue(ok(ALLOW)),
    readAirlockState: vi.fn().mockReturnValue(null),
    isSandboxed: vi.fn().mockReturnValue(false),
    ...over,
  };
}
const CMD = { toolName: 'bash', input: { command: 'ls' } };
const PLAIN = { toolName: 'todo_write', input: { todos: [] } };
const GLM = { model: { provider: 'cloudflare-workers-ai', id: '@cf/zai-org/glm-5.2' } };
const CLAUDE = { model: { provider: 'anthropic', id: 'claude-x' } };

describe('pi: launch gate', () => {
  it('enforce + covered + outside the sandbox: a call the policy allows is still refused, naming the relaunch', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, piDeps());
    const res = await fire('tool_call', CMD, GLM);
    expect(res?.block).toBe(true);
    expect(res?.reason).toMatch(/agenfk airlock pi/);
  });

  it('a sandbox that could not be confirmed says so', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, piDeps({ isSandboxed: vi.fn().mockReturnValue({ sandboxed: false, reason: 'no answer from the probe (offline?)' }) }));
    const res = await fire('tool_call', CMD, GLM);
    expect(res?.reason).toMatch(/could not be confirmed.*no answer/s);
    expect(res?.reason).toMatch(/agenfk airlock pi/);
  });

  it('inside the sandbox nothing is refused for that', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, piDeps({ isSandboxed: vi.fn().mockReturnValue(true) }));
    expect(await fire('tool_call', CMD, GLM)).toBeUndefined();
    expect(await fire('tool_call', PLAIN, GLM)).toBeUndefined();
  });

  it('every tool call: one that carries nothing Airlock judges is refused too', async () => {
    const { pi, fire } = makeFakePi();
    const deps = piDeps();
    activate(pi as any, deps);
    await fire('tool_call', CMD, GLM);
    const res = await fire('tool_call', PLAIN, GLM);
    expect(res?.block).toBe(true);
    expect(res?.reason).toMatch(/agenfk airlock pi/);
  });

  it('cold start: the state file decides for a call carrying nothing', async () => {
    const enforce = { mode: 'enforce', revision: 1, source: 'local', models: [{ provider: 'cloudflare-workers-ai' }], appliesWhenModelUnknown: true };
    for (const [state, model, blocked] of [
      [enforce, GLM, true],
      [enforce, CLAUDE, false],
      [{ ...enforce, mode: 'off' }, GLM, false],
      [{ ...enforce, mode: 'observe' }, GLM, false],
      [null, GLM, false],
    ] as const) {
      const { pi, fire } = makeFakePi();
      activate(pi as any, piDeps({ readAirlockState: vi.fn().mockReturnValue(state) }));
      const res = await fire('tool_call', PLAIN, model);
      expect(res?.block === true, JSON.stringify({ state, model })).toBe(blocked);
    }
  });

  it('not covered, or observe: never refused for that', async () => {
    for (const answer of [ok(ALLOW, 'enforce', false), ok(ALLOW, 'observe', true), ok(ALLOW, 'off', false)]) {
      const { pi, fire } = makeFakePi();
      activate(pi as any, piDeps({ airlockVerdict: vi.fn().mockReturnValue(answer) }));
      expect(await fire('tool_call', CMD, GLM)).toBeUndefined();
    }
  });

  it('a mid-session switch to a covered model is caught on the next call', async () => {
    const { pi, fire } = makeFakePi();
    const verdict = vi.fn((req: any) => ok(ALLOW, 'enforce', req.model?.provider === 'cloudflare-workers-ai'));
    activate(pi as any, piDeps({ airlockVerdict: verdict }));
    expect(await fire('tool_call', CMD, CLAUDE)).toBeUndefined();
    const res = await fire('tool_call', CMD, GLM);
    expect(res?.block).toBe(true);
    expect(res?.reason).toMatch(/agenfk airlock pi/);
  });

  it('a deny verdict is still reported as the deny', async () => {
    const { pi, fire } = makeFakePi();
    const DENY = { decision: 'deny', rule: 'upload-to-unlisted-host', reason: 'nope' };
    activate(pi as any, piDeps({ airlockVerdict: vi.fn().mockReturnValue(ok(DENY)) }));
    const res = await fire('tool_call', CMD, GLM);
    expect(res?.reason).toBe('[agenfk airlock] upload-to-unlisted-host: nope');
  });
});

// ── OpenCode ────────────────────────────────────────────────────────────────

const g = globalThis as any;
let stateFile: string;

describe('OpenCode: launch gate', () => {
  beforeAll(() => {
    expect(os.homedir()).not.toBe(process.env.AGENFK_REAL_HOME);
    const binDir = path.join(os.homedir(), '.agenfk', 'bin');
    stateFile = path.join(os.homedir(), '.agenfk', 'airlock-state.json');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'agenfk-airlock.mjs'), `export * from ${JSON.stringify(pathToFileURL(REAL_SCRIPT).href)};
export async function requestVerdict(payload) { globalThis.__airlockFake.calls.push(payload); return globalThis.__airlockFake.answer(payload); }
export async function airlockSandboxCheck() { return globalThis.__airlockFake.sandboxed ? { sandboxed: true } : { sandboxed: false }; }
`);
  });
  afterAll(() => {
    fs.rmSync(path.join(os.homedir(), '.agenfk', 'bin', 'agenfk-airlock.mjs'), { force: true });
    fs.rmSync(stateFile, { force: true });
    delete g.__airlockFake;
  });
  beforeEach(() => {
    fs.rmSync(stateFile, { force: true });
    g.__airlockFake = { calls: [] as any[], sandboxed: false, answer: () => ok(ALLOW) };
  });

  async function hooks() {
    const mod = await import(`${pathToFileURL(PLUGIN).href}?t=${Date.now()}-${Math.random()}`);
    const h = await mod.default({ directory: '/work' });
    await h['chat.params']({ sessionID: 's1', model: { providerID: 'cloudflare-workers-ai', id: 'glm' } });
    return h;
  }
  async function call(h: any, args: Record<string, unknown>, tool = 'bash') {
    try { await h['tool.execute.before']({ tool, sessionID: 's1', callID: 'c' }, { args }); return null; } catch (e) { return (e as Error).message; }
  }

  it('enforce + covered + outside: refused with the relaunch, inside: allowed', async () => {
    const h = await hooks();
    expect(await call(h, { command: 'ls' })).toMatch(/agenfk airlock opencode/);
    g.__airlockFake.sandboxed = true;
    expect(await call(h, { command: 'ls' })).toBeNull();
  });

  it('every tool call, after an enforce answer, including one carrying nothing Airlock judges', async () => {
    const h = await hooks();
    await call(h, { command: 'ls' });
    expect(await call(h, { todos: [] }, 'todowrite')).toMatch(/agenfk airlock opencode/);
  });

  it('cold start: the state file decides for a call carrying nothing', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ mode: 'enforce', revision: 1, source: 'local', models: [], appliesWhenModelUnknown: true }));
    expect(await call(await hooks(), { todos: [] }, 'todowrite')).toMatch(/agenfk airlock opencode/);
    fs.writeFileSync(stateFile, JSON.stringify({ mode: 'off', revision: 2, source: 'local', models: [], appliesWhenModelUnknown: true }));
    expect(await call(await hooks(), { todos: [] }, 'todowrite')).toBeNull();
  });

  it('not covered: allowed outside the sandbox', async () => {
    g.__airlockFake.answer = () => ok(ALLOW, 'enforce', false);
    const h = await hooks();
    expect(await call(h, { command: 'ls' })).toBeNull();
    expect(await call(h, { todos: [] }, 'todowrite')).toBeNull();
  });
});
