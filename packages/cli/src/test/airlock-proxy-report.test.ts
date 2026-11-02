/**
 * Sandbox egress decisions reported to the server (GH-294, TEL-1).
 *
 * The decisions reach the AgEnFK server through the launcher's
 * ProxyDecisionReporter: batched, deduplicated, fire-and-forget with a timeout.
 * The verdict never waits on, or depends on, the report: a slow, failing or
 * absent server changes nothing about what the sandbox lets through. Where the
 * decisions come from (the machine's egress decider) is tested in
 * airlock-egress.test.ts and airlock-smolvm-runtime.test.ts.
 *
 * The report carries the report token (~/.agenfk/airlock/report-token, sent as
 * x-agenfk-airlock-report), read by the launcher outside the sandbox; the
 * sandbox cannot read that directory, and the token never reaches its env or argv.
 * verify-token stays readable there: the agent's own workflow needs it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeAirlockPolicy, verifyAirlockSessionMarker } from '@agenfk/core';
import { buildSandboxSpec, type SandboxSpec } from '../airlock/spec';
import type { ProxyDecision, SandboxCommand, LaunchHooks } from '../airlock/runtime';
import {
  ProxyDecisionReporter,
  PROXY_REPORT_FLUSH_MS,
  PROXY_REPORT_DEDUPE_MS,
  PROXY_REPORT_MAX_QUEUE,
  PROXY_REPORT_TIMEOUT_MS,
} from '../airlock/proxyReport';
import { runAirlockLaunch, type LaunchDeps } from '../airlock/launch';
import { ensurePrivateDir } from '../commands/airlock';
import fs from 'fs';
import os from 'os';
import path from 'path';

const deny: ProxyDecision = { host: 'evil.example', port: 443, decision: 'deny', rule: 'not-on-allow-list' };
const allow: ProxyDecision = { host: 'api.openai.com', port: 443, decision: 'allow', rule: 'allow-list' };

describe('ProxyDecisionReporter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = (post: (body: any, signal: AbortSignal) => Promise<unknown>) =>
    new ProxyDecisionReporter({ post, client: 'pi', model: 'openai/gpt-x', sessionId: 'sess-1' });

  it('batches what is reported within the flush interval into one post', async () => {
    const post = vi.fn(async () => undefined);
    const r = make(post);
    r.report(deny);
    r.report(allow);
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_FLUSH_MS);
    expect(post).toHaveBeenCalledTimes(1);
    const [body] = post.mock.calls[0] as unknown as [any];
    expect(body).toMatchObject({ client: 'pi', model: 'openai/gpt-x', sessionId: 'sess-1' });
    expect(body.decisions.map((d: any) => [d.host, d.port, d.decision, d.rule])).toEqual([
      ['evil.example', 443, 'deny', 'not-on-allow-list'],
      ['api.openai.com', 443, 'allow', 'allow-list'],
    ]);
    expect(typeof body.decisions[0].ts).toBe('string');
  });

  it('report returns at once and never throws, even when the post never answers', async () => {
    const post = vi.fn(() => new Promise<unknown>(() => {}));
    const r = make(post);
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) expect(() => r.report({ ...deny, host: `h${i}.example` })).not.toThrow();
    expect(Date.now() - t0).toBe(0);
  });

  it('a post that fails is dropped quietly: no throw, no unhandled rejection, later reports still go', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const post = vi.fn()
        .mockImplementationOnce(async () => { throw new Error('ECONNREFUSED'); })
        .mockImplementation(async () => undefined);
      const r = make(post);
      r.report(deny);
      await vi.advanceTimersByTimeAsync(PROXY_REPORT_FLUSH_MS);
      r.report(allow);
      await vi.advanceTimersByTimeAsync(PROXY_REPORT_FLUSH_MS);
      expect(post).toHaveBeenCalledTimes(2);
      expect((post.mock.calls[1][0] as any).decisions[0].host).toBe('api.openai.com');
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a post that hangs is aborted after the timeout, and the next batch is sent', async () => {
    const signals: AbortSignal[] = [];
    const post = vi.fn((_b: unknown, signal: AbortSignal) => { signals.push(signal); return new Promise<unknown>(() => {}); });
    const r = make(post);
    r.report(deny);
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_FLUSH_MS);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_TIMEOUT_MS);
    expect(signals[0].aborted).toBe(true);
    r.report(allow);
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_FLUSH_MS);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('close sends what is queued and resolves within the timeout even when the server never answers', async () => {
    const post = vi.fn(() => new Promise<unknown>(() => {}));
    const r = make(post);
    r.report(deny);
    let closed = false;
    void r.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_TIMEOUT_MS);
    expect(closed).toBe(true);
  });

  it('an identical decision repeated within the dedupe window is sent once', async () => {
    const post = vi.fn(async () => undefined);
    const r = make(post);
    for (let i = 0; i < 100; i++) r.report(deny);
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_FLUSH_MS);
    r.report(deny);
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_DEDUPE_MS - PROXY_REPORT_FLUSH_MS - 1);
    const sent = post.mock.calls.flatMap(c => (c[0] as any).decisions);
    expect(sent).toHaveLength(1);
  });

  it('after the window the same decision is sent again; a different one is never held back', async () => {
    const post = vi.fn(async () => undefined);
    const r = make(post);
    r.report(deny);
    r.report({ ...deny, port: 80 });
    r.report({ ...deny, rule: 'deny-list' });
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_DEDUPE_MS);
    r.report(deny);
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_FLUSH_MS);
    const sent = post.mock.calls.flatMap(c => (c[0] as any).decisions);
    expect(sent).toHaveLength(4);
  });

  it('the queue is bounded: past the cap a decision is dropped, not buffered without end', async () => {
    const post = vi.fn(async () => undefined);
    const r = make(post);
    for (let i = 0; i < PROXY_REPORT_MAX_QUEUE + 50; i++) r.report({ ...deny, host: `h${i}.example` });
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_FLUSH_MS);
    const sent = post.mock.calls.flatMap(c => (c[0] as any).decisions);
    expect(sent).toHaveLength(PROXY_REPORT_MAX_QUEUE);
    for (const c of post.mock.calls) expect((c[0] as any).decisions.length).toBeLessThanOrEqual(PROXY_REPORT_MAX_QUEUE);
  });

  it('a decision the server could not take is dropped here, and the rest are sent (ASRT\'s 255-character host limit)', async () => {
    const post = vi.fn(async () => undefined);
    const r = make(post);
    const host255 = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`;
    r.report({ ...deny, host: host255 });
    r.report({ ...deny, host: `${host255}e` });
    r.report({ ...deny, host: 'bad host\u0000.example' });
    r.report({ ...deny, host: 'p.example', port: 70000 });
    r.report({ ...deny, host: 'r.example', rule: '' });
    r.report({ ...deny, host: 'ok.example' });
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_FLUSH_MS);
    const sent = post.mock.calls.flatMap(c => (c[0] as any).decisions).map((d: any) => d.host);
    expect(sent).toEqual([host255, 'ok.example']);
  });

  it('nothing reported, nothing posted', async () => {
    const post = vi.fn(async () => undefined);
    const r = make(post);
    await vi.advanceTimersByTimeAsync(PROXY_REPORT_FLUSH_MS * 4);
    await r.close();
    expect(post).not.toHaveBeenCalled();
  });
});

// --- The launcher: the reporter is wired to the server, and never in the way. ---

const TOKEN = 'airlock-report-token-0123456789abcdef';

/** The relay the launcher starts (SX-1), recorded instead of listening. */
const relayStub = {
  opts: null as null | { target: string; marker: () => string | null; requireMarker: boolean },
  close: vi.fn(async () => undefined),
  start: vi.fn(async (opts: any) => { relayStub.opts = opts; return { host: '127.0.0.1', port: 47002, close: relayStub.close }; }),
};

function launchDeps(over: Partial<LaunchDeps> = {}) {
  relayStub.opts = null;
  relayStub.close.mockClear();
  relayStub.start.mockClear();
  let hooks: LaunchHooks | undefined;
  let release: () => void = () => {};
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { release = () => resolve({ code: 5, signal: null }); });
  const runtime = {
    id: 'fake',
    check: vi.fn(async () => ({ ok: true as const, warnings: [] })),
    launch: vi.fn(async (_s: SandboxSpec, _c: SandboxCommand, h?: LaunchHooks) => { hooks = h; return { pid: 1, kill: vi.fn(() => true), exited }; }),
    dispose: vi.fn(async () => undefined),
  };
  const d: LaunchDeps = {
    fetchPolicy: vi.fn(async () => ({ effective: { mode: 'enforce', hosts: { allow: ['api.github.com'], deny: [] } }, source: 'local', revision: 3, capabilities: ['sandboxed-commands', 'machine-image'] })),
    runtime,
    reportToken: () => TOKEN,
    startRelay: relayStub.start,
    env: { OPENAI_API_KEY: 'sk-real', AGENFK_SESSION_ID: 'sess-9' },
    home: '/home/u',
    cwd: '/work/repo',
    tmpDir: '/tmp/t',
    apiUrl: 'http://127.0.0.1:3123',
    readJson: () => null,
    exists: () => false,
    runtimePackageDir: '/home/u/.agenfk/smolvm/1.32.4',
    installDirs: ['/home/u/.agenfk-system'],
    log: vi.fn(),
    warn: vi.fn(),
    onSignal: vi.fn(() => () => undefined),
    listDir: () => [],
    realpath: (p: string) => p,
    isDirectory: () => false,
    platform: 'darwin',
    ensurePrivateDir: vi.fn(),
    agenfkVersion: () => '2.1.0-test.1',
    ...over,
  };
  return { d, runtime, hooks: () => hooks, exit: () => release() };
}

describe('runAirlockLaunch: proxy decisions reach the server', () => {
  it('hands the runtime a hook, and posts the denials with the session\'s client, model, session id and the token', async () => {
    const post = vi.fn(async (_b: unknown, _s: AbortSignal, _t: string) => undefined);
    const h = launchDeps({ postProxyDecisions: post });
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.hooks()?.onProxyDecision).toBeTypeOf('function'));
    h.hooks()!.onProxyDecision!(deny);
    h.hooks()!.onProxyDecision!({ ...deny, host: '10.1.2.3', port: 22, rule: 'deny-list' });
    h.exit();
    expect(await run).toBe(5);
    // The last batch is sent when the session ends.
    const bodies = post.mock.calls.map(c => c[0] as any);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[0]).toMatchObject({ client: 'pi', model: 'openai/gpt-x', sessionId: 'sess-9' });
    expect(bodies.flatMap(b => b.decisions).map((x: any) => x.host)).toEqual(['evil.example', '10.1.2.3']);
    // Second review: the launch it reports for - the one the relay marks the sandbox's requests
    // with - so the server finds the card that launch's sandbox recorded.
    expect(bodies[0].launch).toBe(verifyAirlockSessionMarker(TOKEN, relayStub.opts!.marker()));
    expect(post.mock.calls.every(c => c[2] === TOKEN)).toBe(true);
  });

  it('the report token never reaches the sandbox: not its env, its argv or its command line, and its file is unreadable there', async () => {
    const post = vi.fn(async () => undefined);
    const h = launchDeps({ postProxyDecisions: post, env: { OPENAI_API_KEY: 'sk-real', AGENFK_SESSION_ID: 'sess-9', SOME: TOKEN.slice(0, 4) } });
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.runtime.launch).toHaveBeenCalled());
    const [launchedSpec, launchedCmd, hooks] = h.runtime.launch.mock.calls[0] as unknown as [SandboxSpec, SandboxCommand, LaunchHooks];
    h.exit();
    await run;
    expect(JSON.stringify(launchedSpec)).not.toContain(TOKEN);
    expect(JSON.stringify(launchedCmd)).not.toContain(TOKEN);
    expect(Object.keys(hooks)).toEqual(['onProxyDecision']);
    // The whole directory, so its temp files are covered too.
    expect(launchedSpec.filesystem.denyRead).toContain(path.join('/home/u', '.agenfk', 'airlock'));
  });

  it('verify-token stays readable in the sandbox: the agent\'s own agenfk verify and review record need it', async () => {
    const h = launchDeps({ postProxyDecisions: vi.fn(async () => undefined) });
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.runtime.launch).toHaveBeenCalled());
    const [launchedSpec] = h.runtime.launch.mock.calls[0] as unknown as [SandboxSpec];
    h.exit();
    await run;
    const unreadable = launchedSpec.filesystem.denyRead;
    expect(unreadable.some(p => p.includes('verify-token'))).toBe(false);
    expect(unreadable.some(p => p === path.join('/home/u', '.agenfk') || p === path.join('/home/u', '.agenfk', '*'))).toBe(false);
  });

  it('a token the server replaces mid-session: the next batch carries the new one, so reports keep landing', async () => {
    const post = vi.fn(async (_b: unknown, _s: AbortSignal, _t: string) => undefined);
    let current = TOKEN;
    const h = launchDeps({ postProxyDecisions: post, reportToken: () => current });
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.hooks()?.onProxyDecision).toBeTypeOf('function'));
    h.hooks()!.onProxyDecision!(deny);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1), { timeout: 3000 });
    current = 'replaced-token-fedcba9876543210';
    h.hooks()!.onProxyDecision!({ ...deny, host: 'second.example' });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2), { timeout: 3000 });
    h.exit();
    expect(await run).toBe(5);
    expect(post.mock.calls.map(c => c[2])).toEqual([TOKEN, 'replaced-token-fedcba9876543210']);
  });

  it('the token gone mid-session: that batch is not sent (it would be refused), and the session goes on', async () => {
    const post = vi.fn(async () => undefined);
    let current: string | null = TOKEN;
    const h = launchDeps({ postProxyDecisions: post, reportToken: () => current });
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.hooks()?.onProxyDecision).toBeTypeOf('function'));
    current = null;
    h.hooks()!.onProxyDecision!(deny);
    h.exit();
    expect(await run).toBe(5);
    expect(post).not.toHaveBeenCalled();
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform}: ~/.agenfk/airlock is made private before the sandbox is built, so its deny covers a directory that exists`, async () => {
      const order: string[] = [];
      const h = launchDeps({ platform, ensurePrivateDir: vi.fn((dir: string) => { order.push(`dir ${dir}`); }) });
      h.runtime.launch.mockImplementationOnce(async (...args: any[]) => {
        order.push('launch');
        return (h.runtime.launch.getMockImplementation() as any)?.(...args) ?? { pid: 1, kill: () => true, exited: Promise.resolve({ code: 0, signal: null }) };
      });
      const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
      await vi.waitFor(() => expect(h.runtime.launch).toHaveBeenCalled());
      h.exit();
      await run;
      expect(order).toEqual([`dir ${path.join('/home/u', '.agenfk', 'airlock')}`, 'launch']);
    });
  }

  it('a ~/.agenfk/airlock that cannot be made private: nothing is launched, and the user is told why', async () => {
    const h = launchDeps({ ensurePrivateDir: vi.fn(() => { throw new Error('EACCES: permission denied'); }) });
    await expect(runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d))
      .rejects.toThrow(/\.agenfk[\\/]airlock.*private.*nothing was launched/s);
    expect(h.runtime.launch).not.toHaveBeenCalled();
  });

  // SX-1: with no token an ENFORCE launch is refused (see the relay tests below); observe still runs, unreported.
  it('no token (observe): nothing is posted (the server would refuse it), the session runs, and the user is told', async () => {
    const post = vi.fn(async () => undefined);
    const h = launchDeps({
      postProxyDecisions: post,
      reportToken: () => null,
      fetchPolicy: vi.fn(async () => ({ effective: { mode: 'observe', hosts: { allow: ['api.github.com'], deny: [] } }, source: 'local', revision: 3, capabilities: ['sandboxed-commands', 'machine-image'] })),
    });
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.runtime.launch).toHaveBeenCalled());
    expect(h.hooks()).toBeUndefined();
    h.exit();
    expect(await run).toBe(5);
    expect(post).not.toHaveBeenCalled();
    expect(h.d.warn).toHaveBeenCalledWith(expect.stringMatching(/airlock\/report-token.*not reported/));
  });

  it('server down: the session runs and exits exactly as it would, with no report', async () => {
    const post = vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3123'); });
    const h = launchDeps({ postProxyDecisions: post });
    const run = runAirlockLaunch('opencode', ['-m', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.hooks()?.onProxyDecision).toBeTypeOf('function'));
    expect(() => h.hooks()!.onProxyDecision!(deny)).not.toThrow();
    h.exit();
    expect(await run).toBe(5);
    expect(h.runtime.dispose).toHaveBeenCalled();
    expect((post.mock.calls[0][0] as any).client).toBe('opencode');
  });

  it('a server that never answers holds the exit for at most the report timeout', async () => {
    const post = vi.fn(() => new Promise<unknown>(() => {}));
    const h = launchDeps({ postProxyDecisions: post });
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.hooks()?.onProxyDecision).toBeTypeOf('function'));
    h.hooks()!.onProxyDecision!(deny);
    const t0 = Date.now();
    h.exit();
    expect(await run).toBe(5);
    expect(Date.now() - t0).toBeLessThan(PROXY_REPORT_TIMEOUT_MS + 1000);
  });

  it('no session id in the environment: reported with none', async () => {
    const post = vi.fn(async () => undefined);
    const h = launchDeps({ postProxyDecisions: post, env: { OPENAI_API_KEY: 'sk-real' } });
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.hooks()?.onProxyDecision).toBeTypeOf('function'));
    h.hooks()!.onProxyDecision!(deny);
    h.exit();
    await run;
    expect((post.mock.calls[0][0] as any).sessionId).toBeNull();
  });
});

// POSIX modes and symlinks: not on Windows, where the sandbox refuses to launch before this runs.
describe.skipIf(process.platform === 'win32')('ensurePrivateDir (the real launcher\'s)', () => {
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-airlock-dir-'));
  it('a missing directory is created 0700', () => {
    const dir = path.join(tmpDir(), '.agenfk', 'airlock');
    ensurePrivateDir(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('a looser one is tightened to 0700', () => {
    const dir = path.join(tmpDir(), 'airlock');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  for (const mode of [0o600, 0o000, 0o711]) {
    it(`a directory at 0${mode.toString(8).padStart(3, '0')} is set to exactly 0700, so the owner can use it`, () => {
      const dir = path.join(tmpDir(), 'airlock');
      fs.mkdirSync(dir);
      fs.chmodSync(dir, mode);
      ensurePrivateDir(dir);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    });
  }

  it('a file, or a symlink, in its place throws', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'file'), 'x');
    expect(() => ensurePrivateDir(path.join(root, 'file'))).toThrow();
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    expect(() => ensurePrivateDir(path.join(root, 'link'))).toThrow(/not a directory/);
  });
});

describe('runAirlockLaunch: the relay to the server (SX-1, 8dd7c7c0)', () => {
  it('enforce: the relay goes to the server, requires the marker, and its marker verifies with the report token', async () => {
    const h = launchDeps();
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.runtime.launch).toHaveBeenCalled());
    const [spec] = h.runtime.launch.mock.calls[0] as unknown as [SandboxSpec];
    h.exit();
    await run;
    expect(relayStub.opts).toMatchObject({ target: 'http://127.0.0.1:3123', requireMarker: true });
    const m = relayStub.opts!.marker();
    expect(verifyAirlockSessionMarker(TOKEN, m)).not.toBeNull();
    expect(verifyAirlockSessionMarker(TOKEN, relayStub.opts!.marker())).toBe(verifyAirlockSessionMarker(TOKEN, m));
    expect(m).not.toContain(TOKEN);
    expect(spec.network.allow).toEqual(expect.arrayContaining(['127.0.0.1:47002', 'localhost:47002']));
    expect(spec.network.allow.some((x) => x.endsWith(':3123'))).toBe(false);
    expect(spec.env.AGENFK_API_URL).toBe('http://127.0.0.1:47002');
  });

  it('the relay is closed when the session ends', async () => {
    const h = launchDeps();
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.runtime.launch).toHaveBeenCalled());
    expect(relayStub.close).not.toHaveBeenCalled();
    h.exit();
    await run;
    expect(relayStub.close).toHaveBeenCalledTimes(1);
  });

  it('a launch that fails after the relay started closes it', async () => {
    const h = launchDeps();
    h.runtime.launch.mockRejectedValueOnce(new Error('sandbox refused'));
    await expect(runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d)).rejects.toThrow(/sandbox refused/);
    expect(relayStub.close).toHaveBeenCalledTimes(1);
  });

  it('a token the server replaces: the next marker is keyed by the new one', async () => {
    let current = TOKEN;
    const h = launchDeps({ reportToken: () => current });
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.runtime.launch).toHaveBeenCalled());
    h.exit();
    await run;
    current = 'replaced-token-fedcba9876543210';
    expect(verifyAirlockSessionMarker(current, relayStub.opts!.marker())).not.toBeNull();
    expect(verifyAirlockSessionMarker(TOKEN, relayStub.opts!.marker())).toBeNull();
  });

  it('enforce with no report token: nothing is launched or relayed, and the error says how to fix it', async () => {
    const h = launchDeps({ reportToken: () => null });
    await expect(runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d)).rejects.toThrow(/report-token.*agenfk restart/s);
    expect(h.runtime.launch).not.toHaveBeenCalled();
    expect(relayStub.start).not.toHaveBeenCalled();
  });

  it('observe with no report token: it launches, relayed unmarked, and says so', async () => {
    const warn = vi.fn();
    const h = launchDeps({
      reportToken: () => null,
      warn,
      fetchPolicy: vi.fn(async () => ({ effective: { mode: 'observe', hosts: { allow: ['api.github.com'], deny: [] } }, source: 'local', revision: 3, capabilities: ['sandboxed-commands', 'machine-image'] })),
    });
    const run = runAirlockLaunch('pi', ['--model', 'openai/gpt-x'], { keyEnv: [] }, h.d);
    await vi.waitFor(() => expect(h.runtime.launch).toHaveBeenCalled());
    h.exit();
    await run;
    expect(relayStub.opts).toMatchObject({ requireMarker: false });
    expect(relayStub.opts!.marker()).toBeNull();
    expect(warn.mock.calls.flat().join('\n')).toMatch(/not marked/);
  });
});
