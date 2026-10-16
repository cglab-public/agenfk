/**
 * #223: REAL action tests for `agenfk hub deadletter requeue`, the sticky
 * `Refused` line of `agenfk hub status`, and the deadletter list footer.
 *
 * Same harness as hub-carryover-actions.test.ts: sandboxed HOME, mocked axios
 * (the local server's /internal routes and the hub's /v1/ping) and readline.
 *
 * The requeue is a two-call conversation with the local server — a dry run to
 * show what would move, then the real run — wrapped in a pre-flight check of
 * the hub binding: requeueing into a binding the hub will refuse again only
 * puts the same events straight back in the deadletter.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerHubCommands } from '../commands/hub';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-requeue-')) };
});

const { mockGet, mockPost, askState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  askState: { answer: '', lastQuestion: '' },
}));
vi.mock('axios', () => ({ default: { get: mockGet, post: mockPost } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});
vi.mock('@agenfk/telemetry', () => ({
  getApiUrl: () => 'http://localhost:3000',
  getInstallationId: () => 'inst-local',
}));
vi.mock('readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => { askState.lastQuestion = _q; cb(askState.answer); },
    close: () => { /* noop */ },
  }),
}));

const realIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
function setTty(v: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
}

const AGENFK_DIR = path.join(sandboxHome, '.agenfk');
const HUB_CONFIG = path.join(AGENFK_DIR, 'hub.json');
const VERIFY_TOKEN = path.join(AGENFK_DIR, 'verify-token');
const DEADLETTER = path.join(AGENFK_DIR, 'hub-deadletter.jsonl');
const AUDIT = path.join(AGENFK_DIR, 'hub-audit.jsonl');
const CURRENT = { url: 'https://hub.acme.com', token: 'tok-acme', orgId: 'acme' };
const REQUEUE = 'http://localhost:3000/internal/hub/requeue-deadletter';
const PING = 'https://hub.acme.com/v1/ping';

function seed(opts: { config?: boolean; token?: boolean } = {}): void {
  fs.mkdirSync(AGENFK_DIR, { recursive: true });
  if (opts.config !== false) fs.writeFileSync(HUB_CONFIG, JSON.stringify(CURRENT, null, 2), { mode: 0o600 });
  if (opts.token !== false) fs.writeFileSync(VERIFY_TOKEN, 'verifytok\n');
}

function blockAuditWrites(): () => void {
  if (process.platform !== 'win32') {
    fs.chmodSync(AGENFK_DIR, 0o500);
    return () => fs.chmodSync(AGENFK_DIR, 0o700);
  }
  if (!fs.existsSync(AUDIT)) fs.writeFileSync(AUDIT, '');
  fs.chmodSync(AUDIT, 0o444);
  return () => fs.chmodSync(AUDIT, 0o600);
}

const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

interface Summary {
  count: number; firstAt: string | null; lastAt: string | null;
  byReason: Record<string, number>; byType: Record<string, number>;
  byOrg: Record<string, number>; byInstallation: Record<string, number>;
}
const SUMMARY: Summary = {
  count: 2, firstAt: '2026-10-06T22:37:09.924Z', lastAt: '2026-10-09T22:23:17.006Z',
  byReason: { foreign_installation: 2 }, byType: { 'pr.opened': 1, 'item.closed': 1 },
  byOrg: { acme: 2 }, byInstallation: { 'inst-local': 2 },
};

/**
 * Wire the two calls. `dry` is the dry-run reply; `real` the real one (or an
 * Error to throw). `ping` is the hub's /v1/ping reply (or an Error).
 */
function wire(opts: {
  dry?: Partial<{ summary: Summary; excluded: Record<string, number>; eventIds: string[] }>;
  real?: Record<string, unknown> | Error;
  ping?: Record<string, unknown> | Error;
} = {}) {
  const dry = {
    dryRun: true, requeued: 0, alreadyQueued: 0, remaining: 2,
    summary: SUMMARY, excluded: {}, eventIds: ['e1', 'e2'], ...opts.dry,
  };
  mockPost.mockImplementation(async (url: string, body: any, cfg: any) => {
    if (url !== REQUEUE) throw new Error(`unexpected POST ${url}`);
    if (cfg?.headers?.['x-agenfk-internal'] !== 'verifytok') throw new Error('bad internal token');
    if (body?.dryRun) return { status: 200, data: dry };
    if (opts.real instanceof Error) throw opts.real;
    return { status: 200, data: opts.real ?? { dryRun: false, requeued: dry.summary.count, alreadyQueued: 0, remaining: 0, summary: dry.summary, excluded: dry.excluded, eventIds: dry.eventIds } };
  });
  mockGet.mockImplementation(async (url: string, cfg: any) => {
    if (url !== PING) throw new Error(`unexpected GET ${url}`);
    expect(cfg?.headers?.Authorization).toBe('Bearer tok-acme');
    if (opts.ping instanceof Error) throw opts.ping;
    return { status: 200, data: opts.ping ?? { ok: true, orgId: 'acme', installationId: 'inst-local' } };
  });
}

const realPosts = () => mockPost.mock.calls.filter(c => c[0] === REQUEUE && !c[1]?.dryRun);
const dryPosts = () => mockPost.mock.calls.filter(c => c[0] === REQUEUE && c[1]?.dryRun);

describe('agenfk hub deadletter requeue (#223)', () => {
  let program: Command;
  let exitSpy: any;
  let logSpy: any;
  let errSpy: any;
  const out = () => plain([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n'));

  function fresh(): Command {
    const p = new Command();
    p.exitOverride();
    registerHubCommands(p);
    return p;
  }
  const run = (args: string[]) => program.parseAsync(['hub', 'deadletter', 'requeue', ...args], { from: 'user' });

  beforeEach(() => {
    program = fresh();
    for (const f of [HUB_CONFIG, VERIFY_TOKEN, DEADLETTER, AUDIT]) { try { fs.unlinkSync(f); } catch { /* */ } }
    seed();
    mockGet.mockReset(); mockPost.mockReset();
    askState.answer = ''; askState.lastQuestion = '';
    setTty(true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (realIsTTY) Object.defineProperty(process.stdin, 'isTTY', realIsTTY);
    else delete (process.stdin as any).isTTY;
    try { fs.rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* */ }
  });

  describe('preconditions', () => {
    it('refuses without hub.json and touches nothing', async () => {
      fs.unlinkSync(HUB_CONFIG);
      wire();
      await expect(run(['--yes'])).rejects.toThrow('exit 1');
      expect(out()).toMatch(/agenfk hub join/);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('refuses without the verify-token', async () => {
      fs.unlinkSync(VERIFY_TOKEN);
      wire();
      await expect(run(['--yes'])).rejects.toThrow('exit 1');
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('refuses org_mismatch without --org before calling anything, pointing to carry-over', async () => {
      wire();
      await expect(run(['--reason', 'org_mismatch', '--yes'])).rejects.toThrow('exit 1');
      expect(out()).toMatch(/carry-over/);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('refuses a malformed --since', async () => {
      wire();
      await expect(run(['--since', 'last tuesday', '--yes'])).rejects.toThrow('exit 1');
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  it('happy path: dry run, ping, real run, audit line, flush hint', async () => {
    wire();
    await run(['--yes']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(dryPosts()).toHaveLength(1);
    expect(dryPosts()[0][1]).toEqual({ filters: {}, dryRun: true });
    expect(realPosts()).toHaveLength(1);
    // Only the events the person just confirmed (review finding 3).
    expect(realPosts()[0][1]).toEqual({ filters: {}, dryRun: false, eventIds: ['e1', 'e2'] });

    const text = out();
    expect(text).toMatch(/2 event\(s\)/);
    expect(text).toMatch(/foreign_installation \(2\)/);
    expect(text).toMatch(/pr\.opened \(1\)/);
    expect(text).toMatch(/2026-10-06T22:37:09\.924Z/);
    expect(text).toMatch(/Requeued 2/);
    expect(text).toMatch(/agenfk hub flush/);

    const audit = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'deadletter-requeue', filters: {}, requeued: 2, eventIds: ['e1', 'e2'] });
    expect(typeof audit[0].at).toBe('string');
    expect(typeof audit[0].osUser).toBe('string');
  });

  it('passes the filters through, splitting comma lists', async () => {
    wire();
    await run(['--reason', 'foreign_installation,unknown', '--type', 'pr.opened', '--org', 'acme', '--since', '2026-10-06T00:00:00Z', '--yes']);
    const filters = { reasons: ['foreign_installation', 'unknown'], types: ['pr.opened'], org: 'acme', since: '2026-10-06T00:00:00Z' };
    expect(dryPosts()[0][1]).toEqual({ filters, dryRun: true });
    expect(realPosts()[0][1]).toEqual({ filters, dryRun: false, eventIds: ['e1', 'e2'] });
  });

  it('nothing selected: says why, and neither pings nor requeues', async () => {
    wire({ dry: { summary: { ...SUMMARY, count: 0, byReason: {}, byType: {}, byOrg: {}, byInstallation: {} }, excluded: { 'reason:hidden_user': 3, unparseable: 1 }, eventIds: [] } });
    await run(['--yes']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(out()).toMatch(/Nothing to requeue/);
    expect(out()).toMatch(/hidden_user.*3/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(realPosts()).toHaveLength(0);
  });

  describe('hub binding pre-check (/v1/ping)', () => {
    it('aborts when the hub answers for another org; --force overrides', async () => {
      wire({ ping: { ok: true, orgId: 'other-org', installationId: 'inst-local' } });
      await expect(run(['--yes'])).rejects.toThrow('exit 1');
      expect(out()).toMatch(/other-org/);
      expect(realPosts()).toHaveLength(0);

      program = fresh();
      await run(['--yes', '--force']);
      expect(realPosts()).toHaveLength(1);
    });

    it('aborts when the key is bound to another installation, naming hub join; --force overrides', async () => {
      wire({ ping: { ok: true, orgId: 'acme', installationId: 'inst-other' } });
      await expect(run(['--yes'])).rejects.toThrow('exit 1');
      expect(out()).toMatch(/inst-other/);
      expect(out()).toMatch(/agenfk hub join/);
      expect(realPosts()).toHaveLength(0);

      program = fresh();
      await run(['--yes', '--force']);
      expect(realPosts()).toHaveLength(1);
    });

    it('aborts when the selected events were recorded by an installation the key is not bound to', async () => {
      wire({ dry: { summary: { ...SUMMARY, byInstallation: { 'inst-old': 2 } } } });
      await expect(run(['--yes'])).rejects.toThrow('exit 1');
      expect(out()).toMatch(/inst-old/);
      expect(realPosts()).toHaveLength(0);

      program = fresh();
      await run(['--yes', '--force']);
      expect(realPosts()).toHaveLength(1);
    });

    it('aborts on 401/403 from the hub', async () => {
      wire({ ping: Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }) });
      await expect(run(['--yes'])).rejects.toThrow('exit 1');
      expect(out()).toMatch(/401/);
      expect(realPosts()).toHaveLength(0);
    });

    it('only warns for an unbound key (installationId null)', async () => {
      wire({ ping: { ok: true, orgId: 'acme', installationId: null } });
      await run(['--yes']);
      expect(out()).toMatch(/not bound/i);
      expect(realPosts()).toHaveLength(1);
    });

    it('only warns for an older hub that does not report the binding', async () => {
      wire({ ping: { ok: true, orgId: 'acme' } });
      await run(['--yes']);
      expect(out()).toMatch(/cannot verify/i);
      expect(realPosts()).toHaveLength(1);
    });

    it('only warns when the hub is unreachable: the events wait in the outbox', async () => {
      wire({ ping: Object.assign(new Error('getaddrinfo ENOTFOUND hub.acme.com'), { code: 'ENOTFOUND' }) });
      await run(['--yes']);
      expect(out()).toMatch(/ENOTFOUND/);
      expect(out()).toMatch(/cannot verify/i);
      expect(realPosts()).toHaveLength(1);
    });
  });

  describe('confirmation', () => {
    it('asks and proceeds on y', async () => {
      wire();
      askState.answer = 'y';
      await run([]);
      expect(askState.lastQuestion).toMatch(/\[y\/N\]/);
      expect(realPosts()).toHaveLength(1);
    });

    it('aborts on anything else, with no real run and no audit line', async () => {
      wire();
      askState.answer = '';
      await run([]);
      expect(out()).toMatch(/Aborted/);
      expect(realPosts()).toHaveLength(0);
      expect(fs.existsSync(AUDIT)).toBe(false);
    });

    it('refuses without a TTY unless --yes', async () => {
      wire();
      setTty(false);
      await expect(run([])).rejects.toThrow('exit 1');
      expect(out()).toMatch(/--yes/);
      expect(realPosts()).toHaveLength(0);
    });
  });

  it('warns that events stamped with another org will wait as stale rows, and names carry-over', async () => {
    wire({ dry: { summary: { ...SUMMARY, byOrg: { acme: 1, 'old-corp': 1 } } } });
    await run(['--yes']);
    expect(out()).toMatch(/old-corp/);
    expect(out()).toMatch(/carry-over --from old-corp --to acme/);
  });

  it('records a --force override in the audit line (review finding 4)', async () => {
    wire({ ping: { ok: true, orgId: 'acme', installationId: 'inst-other' } });
    await run(['--yes', '--force']);
    const [audit] = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(audit.force).toBe(true);
    expect(audit.overridden.join(' ')).toMatch(/inst-other/);
  });

  it('an audit line without an override carries no force field', async () => {
    wire();
    await run(['--yes']);
    const [audit] = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(audit).not.toHaveProperty('force');
  });

  it('says when refusals that arrived during the prompt were left for the next run', async () => {
    wire({ real: { dryRun: false, requeued: 2, alreadyQueued: 0, remaining: 1, summary: SUMMARY, excluded: { unconfirmed: 1 }, eventIds: ['e1', 'e2'] } });
    await run(['--yes']);
    expect(out()).toMatch(/1 more were refused while you confirmed/);
  });

  it('notes when the real run moved a different number than the dry run showed', async () => {
    wire({ real: { dryRun: false, requeued: 1, alreadyQueued: 0, remaining: 1, summary: { ...SUMMARY, count: 1 }, excluded: {}, eventIds: ['e1'] } });
    await run(['--yes']);
    expect(out()).toMatch(/summary showed 2.*1/);
  });

  it('a failed real run exits 1 and says how many were already inserted', async () => {
    wire({ real: Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: { error: 'EPERM', inserted: 2 } } }) });
    await expect(run(['--yes'])).rejects.toThrow('exit 1');
    expect(out()).toMatch(/EPERM/);
    expect(out()).toMatch(/2/);
    expect(out()).toMatch(/run the same command again/i);
  });

  it('an audit write failure after a successful requeue is loud and exits 1', async () => {
    wire();
    const restore = blockAuditWrites();
    try {
      await expect(run(['--yes'])).rejects.toThrow('exit 1');
    } finally {
      restore();
    }
    expect(realPosts()).toHaveLength(1);
    expect(out()).toMatch(/REQUEUE SUCCEEDED \(2 event\(s\)\) BUT THE AUDIT LINE FAILED/);
  });
});

describe('agenfk hub status — sticky Refused line (#223)', () => {
  let exitSpy: any;
  let logSpy: any;
  let errSpy: any;
  const out = () => plain([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n'));
  const runStatus = async () => {
    const p = new Command();
    p.exitOverride();
    registerHubCommands(p);
    await p.parseAsync(['hub', 'status'], { from: 'user' });
  };
  const IND = { count: 204, actionable: 204, since: '2026-10-06T22:37:15.885Z', reasons: { foreign_installation: 204 }, unparseable: 0 };

  beforeEach(() => {
    for (const f of [HUB_CONFIG, VERIFY_TOKEN, DEADLETTER, AUDIT]) { try { fs.unlinkSync(f); } catch { /* */ } }
    mockGet.mockReset(); mockPost.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('prints the indicator from the server, with the reason-specific fix', async () => {
    seed();
    mockGet.mockResolvedValue({ status: 200, data: { outboxDepth: 0, deadletterDepth: 204, lastError: null, halted: false, consecutiveFailures: 0, deadletter: IND } });
    await runStatus();
    const text = out();
    expect(text).toMatch(/Deadlettered: 204/);
    expect(text).toMatch(/Refused:\s+204 since 2026-10-06T22:37:15\.885Z \(foreign_installation 204\)/);
    expect(text).toMatch(/agenfk hub join/);
    expect(text).toMatch(/agenfk hub deadletter requeue/);
  });

  it('prints no Refused line when nothing was refused', async () => {
    seed();
    mockGet.mockResolvedValue({ status: 200, data: { outboxDepth: 0, deadletterDepth: 0, lastError: null, halted: false, consecutiveFailures: 0, deadletter: { count: 0, actionable: 0, since: null, reasons: {}, unparseable: 0 } } });
    await runStatus();
    expect(out()).not.toMatch(/Refused:/);
  });

  it('still reports refusals from the local file when the hub is not configured', async () => {
    fs.mkdirSync(AGENFK_DIR, { recursive: true });
    fs.writeFileSync(DEADLETTER, JSON.stringify({
      eventId: 'e1', occurredAt: '2026-10-07T00:00:00Z', deadletteredAt: '2026-10-07T00:00:05Z',
      reason: 'foreign_installation', payload: { eventId: 'e1', orgId: 'acme' },
    }) + '\n');
    await runStatus();
    const text = out();
    expect(text).toMatch(/not configured/);
    expect(text).toMatch(/Refused:\s+1 since 2026-10-07T00:00:05Z \(foreign_installation 1\)/);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('falls back to the local file when the local server is unreachable', async () => {
    seed();
    fs.writeFileSync(DEADLETTER, JSON.stringify({
      eventId: 'e1', occurredAt: '2026-10-07T00:00:00Z', deadletteredAt: '2026-10-07T00:00:05Z',
      reason: 'hidden_user', payload: { eventId: 'e1', orgId: 'acme' },
    }) + '\n');
    mockGet.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await runStatus();
    expect(out()).toMatch(/Refused:\s+1 since 2026-10-07T00:00:05Z \(hidden_user 1\)/);
  });
});

describe('agenfk hub deadletter — list footer (#223)', () => {
  it('points at requeue as well as discard', async () => {
    fs.mkdirSync(AGENFK_DIR, { recursive: true });
    fs.writeFileSync(DEADLETTER, JSON.stringify({
      eventId: 'e1', occurredAt: '2026-10-07T00:00:00Z', deadletteredAt: '2026-10-07T00:00:05Z',
      reason: 'foreign_installation', payload: { eventId: 'e1', orgId: 'acme' },
    }) + '\n');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Command();
    p.exitOverride();
    registerHubCommands(p);
    await p.parseAsync(['hub', 'deadletter'], { from: 'user' });
    const text = plain(logSpy.mock.calls.flat().join('\n'));
    logSpy.mockRestore();
    expect(text).toMatch(/agenfk hub deadletter requeue/);
    expect(text).toMatch(/agenfk hub deadletter discard/);
  });
});

// #223 review finding 2: a way out for the lines a requeue can never move.
describe('agenfk hub deadletter discard --reason / --unparseable (#223)', () => {
  it('removes only the named reasons and the unreadable lines, keeping requeueable events', async () => {
    const keep = JSON.stringify({ eventId: 'fi', occurredAt: '2026-10-07T00:00:00Z', deadletteredAt: '2026-10-07T00:00:05Z', reason: 'foreign_installation', payload: { eventId: 'fi', orgId: 'acme' } });
    const hidden = JSON.stringify({ eventId: 'hu', occurredAt: '2026-10-07T00:00:00Z', deadletteredAt: '2026-10-07T00:00:05Z', reason: 'hidden_user', payload: { eventId: 'hu', orgId: 'acme' } });
    fs.mkdirSync(AGENFK_DIR, { recursive: true });
    fs.writeFileSync(DEADLETTER, [keep, hidden, 'TORN'].join('\n') + '\n');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const p = new Command();
      p.exitOverride();
      registerHubCommands(p);
      await p.parseAsync(['hub', 'deadletter', 'discard', '--reason', 'hidden_user', '--unparseable'], { from: 'user' });
    } finally {
      logSpy.mockRestore();
    }
    expect(fs.readFileSync(DEADLETTER, 'utf8')).toBe(keep + '\n');
  });

  // Second review round: --reason naming a requeueable reason would delete
  // exactly the events requeue exists to save.
  describe('naming a reason that can still be requeued', () => {
    const fi = JSON.stringify({ eventId: 'fi', occurredAt: '2026-10-07T00:00:00Z', deadletteredAt: '2026-10-07T00:00:05Z', reason: 'foreign_installation', payload: { eventId: 'fi', orgId: 'acme' } });
    let exitSpy: any;
    let logSpy: any;
    let errSpy: any;
    const discard = async (...extra: string[]) => {
      const p = new Command();
      p.exitOverride();
      registerHubCommands(p);
      await p.parseAsync(['hub', 'deadletter', 'discard', '--reason', 'foreign_installation', ...extra], { from: 'user' });
    };
    beforeEach(() => {
      fs.mkdirSync(AGENFK_DIR, { recursive: true });
      fs.writeFileSync(DEADLETTER, fi + '\n');
      askState.answer = ''; askState.lastQuestion = '';
      setTty(true);
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore(); });

    it('asks, and keeps the events unless the person types discard', async () => {
      await discard();
      expect(askState.lastQuestion).toMatch(/Type 'discard'/);
      expect(plain(logSpy.mock.calls.flat().join(' '))).toMatch(/could still send to the hub/);
      expect(fs.readFileSync(DEADLETTER, 'utf8')).toBe(fi + '\n');
    });

    it('discards on a typed confirmation', async () => {
      askState.answer = 'discard';
      await discard();
      expect(fs.existsSync(DEADLETTER)).toBe(false);
    });

    it('refuses without a TTY unless --yes', async () => {
      setTty(false);
      await expect(discard()).rejects.toThrow('exit 1');
      expect(fs.readFileSync(DEADLETTER, 'utf8')).toBe(fi + '\n');
      await discard('--yes');
      expect(fs.existsSync(DEADLETTER)).toBe(false);
    });
  });
});
