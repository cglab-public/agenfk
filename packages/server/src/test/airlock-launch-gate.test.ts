/**
 * Airlock layer 2 (GH-294, L2-3): the launch gate. In enforce mode, a session
 * the policy covers that is NOT running inside the Airlock sandbox has every
 * tool call refused with "relaunch with agenfk airlock pi|opencode". Checked per
 * tool call, so switching mid-session to a covered model is caught.
 *
 * "Inside the sandbox" is the marker env, ~/.agenfk being unwritable (root's
 * in the machine; outside it is the user's own directory), and the machine's
 * root-owned marker file (CGLAB-696 task 9): env vars alone do not make a
 * session sandboxed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
// @ts-ignore — .ts extension is loaded by pi via jiti; here we import it directly.
import activate, { airlockSandboxed } from '../../../../bin/agenfk-pi-extension.ts';

const PLUGIN = path.resolve(__dirname, '../../../../bin/agenfk-airlock-opencode.mjs');
const REAL_SCRIPT = path.resolve(__dirname, '../../../../bin/agenfk-airlock.mjs');

const SANDBOX_ENV = { AGENFK_AIRLOCK_SANDBOX: 'pi' };
const eperm = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
const enoent = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

function ok(verdict: any, mode = 'enforce', applies = true) {
  return { status: 'ok', verdict, mode, applies, revision: 1, source: 'local' };
}
const ALLOW = { decision: 'allow', why: 'no-rule-matched' };

const CONFINED = () => ({ confined: true });
const NOT_CONFINED = () => ({ confined: false, reason: 'this process is not in an Airlock machine' });

describe('confinement proof: the Airlock machine (CGLAB-696 task 9)', () => {
  // What the machine's root setup leaves at /run/agenfk/machine: a root-owned file nobody else can write.
  const MARKER = { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100444 };
  // /proc/self/uid_map of the machine's (initial) user namespace: every uid, mapped to itself.
  const INITIAL_USERNS = '         0          0 4294967295\n';
  const statOf = (st: object | null) => vi.fn(() => {
    if (!st) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return st;
  });
  const prove = async (over: object = {}) => {
    const mod = await import(pathToFileURL(REAL_SCRIPT).href);
    return mod.proveConfinement({ platform: 'linux', lstat: statOf(MARKER), getuid: () => 501, readFile: () => INITIAL_USERNS, ...over });
  };

  it('the machine\'s marker, root-owned and unwritable to others, proves confinement for a session that is not root', async () => {
    expect(await prove()).toEqual({ confined: true });
  });

  it('anything less does not: no marker, another owner, writable by others, a link, a session running as root', async () => {
    const missing = await prove({ lstat: statOf(null) });
    expect(missing.confined).toBe(false);
    expect(missing.reason).toMatch(/Airlock machine/);
    expect((await prove({ lstat: statOf({ ...MARKER, uid: 501 }) })).confined).toBe(false);
    expect((await prove({ lstat: statOf({ ...MARKER, mode: 0o100666 }) })).confined).toBe(false);
    expect((await prove({ lstat: statOf({ ...MARKER, mode: 0o100464 }) })).confined).toBe(false);
    expect((await prove({ lstat: statOf({ ...MARKER, isFile: () => false, isSymbolicLink: () => true }) })).confined).toBe(false);
    expect((await prove({ getuid: () => 0 })).confined).toBe(false);
  });

  // Review (task 9): in a user namespace of its own, a host process is "root" to make the marker
  // and another uid to check it. The machine's processes are in the initial user namespace.
  it('a marker made in a user namespace of its own does not: the process must be in the initial one', async () => {
    const forged = await prove({ readFile: () => '         0       1000          1\n      501     100000      65536\n' });
    expect(forged.confined).toBe(false);
    expect(forged.reason).toMatch(/user namespace/);
    expect((await prove({ readFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); } })).confined).toBe(false);
  });

  it('never outside Linux: sessions run in a Linux machine', async () => {
    const r = await prove({ platform: 'darwin' });
    expect(r.confined).toBe(false);
    expect(r.reason).toMatch(/Linux/);
  });

  it('proves once per process', async () => {
    const mod = await import(pathToFileURL(REAL_SCRIPT).href);
    const lstat = statOf(MARKER);
    const once = mod.confinementOnce({ platform: 'linux', lstat, getuid: () => 501, readFile: () => INITIAL_USERNS });
    expect(await once()).toEqual({ confined: true });
    expect(await once()).toEqual({ confined: true });
    expect(lstat).toHaveBeenCalledTimes(1);
  });

  it('the shared script (OpenCode): the marker env + unwritable ~/.agenfk + confinement; no proxy env is needed', async () => {
    const mod = await import(pathToFileURL(REAL_SCRIPT).href);
    const check = (env: any, access: any, proof: any) => mod.airlockSandboxCheck({ env, homeDir: '/h', access, prove: proof });
    expect(await check(SANDBOX_ENV, eperm, CONFINED)).toEqual({ sandboxed: true });
    expect(await check({ AGENFK_AIRLOCK_SANDBOX: 'opencode' }, eperm, CONFINED)).toEqual({ sandboxed: true });
    // Forged: env set and ~/.agenfk chmod-ed read-only, but the process is not in a machine.
    const forged = await check(SANDBOX_ENV, () => { throw Object.assign(new Error(''), { code: 'EACCES' }); }, NOT_CONFINED);
    expect(forged.sandboxed).toBe(false);
    expect(forged.reason).toMatch(/not in an Airlock machine/);
    expect((await check(SANDBOX_ENV, () => undefined, CONFINED)).sandboxed).toBe(false);
    expect((await check({ HTTPS_PROXY: 'x' }, eperm, CONFINED)).sandboxed).toBe(false);
  });

  it('pi extension: the same rule', () => {
    expect(airlockSandboxed(SANDBOX_ENV, '/h', eperm, CONFINED)).toEqual({ sandboxed: true });
    expect(airlockSandboxed(SANDBOX_ENV, '/h', eperm, NOT_CONFINED).sandboxed).toBe(false);
    expect(airlockSandboxed(SANDBOX_ENV, '/h', () => undefined, CONFINED).sandboxed).toBe(false);
    expect(airlockSandboxed(SANDBOX_ENV, '/h', enoent, CONFINED).sandboxed).toBe(false);
    expect(airlockSandboxed({ HTTPS_PROXY: 'http://x' }, '/h', eperm, CONFINED).sandboxed).toBe(false);
  });

  it('the real check, outside any machine: not sandboxed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-home-'));
    fs.mkdirSync(path.join(home, '.agenfk'));
    const mod = await import(pathToFileURL(REAL_SCRIPT).href);
    expect((await mod.airlockSandboxCheck({ env: SANDBOX_ENV, homeDir: home })).sandboxed).toBe(false);
    expect(airlockSandboxed(SANDBOX_ENV, home, undefined, CONFINED).sandboxed).toBe(false);
    expect((await mod.proveConfinement()).confined).toBe(false);
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
