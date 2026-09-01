/**
 * Story d9b756c0 (CGLAB-117): login healthz guard, stale-org detection on
 * login/join, repoint --carry-over gating, flush exit codes, status depths.
 *
 * The fixture clobber (31 Aug) began with a hub.json pointing at a URL that
 * was not an AgenFK Hub — everything after that was collateral. These tests
 * pin the gates that make that class of incident impossible:
 *  - login (both paths) refuses any endpoint whose /healthz does not say
 *    service=agenfk-hub, BEFORE anything is written;
 *  - login/join surface stale-org outbox rows with exact counts and the exact
 *    carry-over/deadletter commands, but NEVER auto-rewrite a non-empty org;
 *  - repoint rewrites the outbox only with --carry-over (+ confirmation),
 *    and that rewrite is audited like carry-over's;
 *  - flush exits non-zero on lastError instead of printing red as green;
 *  - status shows the stale-org and deadletter depths.
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
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-story4-')) };
});
const realHome = process.env.HOME;
beforeEach(() => { process.env.HOME = sandboxHome; });

const { mockGet, mockPost, askState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  askState: { answer: '', lastQuestion: '' },
}));
vi.mock('axios', () => ({ default: { get: mockGet, post: mockPost } }));
vi.mock('@agenfk/telemetry', () => ({
  getApiUrl: () => 'http://localhost:3000',
  getInstallationId: () => 'inst-test',
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});
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
const AUDIT = path.join(AGENFK_DIR, 'hub-audit.jsonl');

const ORIGINAL = { url: 'https://hub.stg.example.com', token: 'tok-stg', orgId: 'staging' };

function seed(): void {
  fs.mkdirSync(AGENFK_DIR, { recursive: true });
  fs.writeFileSync(HUB_CONFIG, JSON.stringify(ORIGINAL, null, 2), { mode: 0o600 });
  fs.writeFileSync(VERIFY_TOKEN, 'verifytok');
}
function clearConfig(): void {
  try { fs.unlinkSync(HUB_CONFIG); } catch { /* */ }
  try { fs.unlinkSync(AUDIT); } catch { /* */ }
}

/** GET router: which endpoints answer, and what /healthz and /status say. */
function route(opts: {
  healthz?: { service?: string } | null;          // null = unreachable
  ping?: (body: any) => any;
  status?: Record<string, unknown> | null;        // /internal/hub/status
  deviceStart?: any;
} = {}): void {
  mockGet.mockImplementation(async (url: string) => {
    if (url.endsWith('/healthz')) {
      if (opts.healthz === null) throw new Error('EAI_AGAIN hub.stg.example.com');
      return { status: 200, data: { ok: true, ...(opts.healthz ?? { service: 'agenfk-hub' }) } };
    }
    if (url.endsWith('/v1/ping')) {
      return { status: 200, data: opts.ping ? opts.ping({}) : { ok: true } };
    }
    if (url.includes('/internal/hub/status')) {
      if (opts.status === null) throw new Error('server not running');
      return { status: 200, data: { enabled: true, outboxDepth: 7, ...(opts.status ?? {}) } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

async function run(program: Command, args: string[]): Promise<void> {
  await program.parseAsync(args, { from: 'user' });
}

function rewritePosts(): Array<{ from: string; to: string }> {
  return mockPost.mock.calls
    .filter(c => String(c[0]).includes('/internal/hub/rewrite-outbox-org'))
    .map(c => c[1] as { from: string; to: string });
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerHubCommands(program);
  return program;
}

let exitSpy: any;
let logSpy: any;
let errSpy: any;
let warnSpy: any;

beforeEach(() => {
  clearConfig();
  seed();
  mockGet.mockReset(); mockPost.mockReset();
  askState.answer = ''; askState.lastQuestion = '';
  setTty(true);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (realIsTTY) Object.defineProperty(process.stdin, 'isTTY', realIsTTY);
  else delete (process.stdin as any).isTTY;
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
});

describe('(a) login healthz guard — the fixture-clobber regression gate', () => {
  it('legacy --token path refuses when /healthz does not identify agenfk-hub, writing nothing', async () => {
    clearConfig();
    route({ healthz: { service: 'something-else' } });
    await expect(run(makeProgram(), ['hub', 'login', '--url', 'https://evil.example.com', '--token', 't', '--org', 'acme'])).rejects.toThrow('exit 1');
    const err = errSpy.mock.calls.flat().join(' ');
    expect(err).toMatch(/did not identify as agenfk-hub \(got service=something-else\)/);
    expect(err).toMatch(/Nothing was written\. Confirm the Hub URL/);
    expect(fs.existsSync(HUB_CONFIG)).toBe(false);
    // Never even pinged with the token against an unverified endpoint.
    expect(mockGet.mock.calls.some(c => String(c[0]).includes('/v1/ping'))).toBe(false);
  });

  it('legacy path refuses when /healthz is unreachable (the clobber: non-resolving URL)', async () => {
    clearConfig();
    route({ healthz: null });
    await expect(run(makeProgram(), ['hub', 'login', '--url', 'https://does-not-resolve', '--token', 't', '--org', 'acme'])).rejects.toThrow('exit 1');
    const err = errSpy.mock.calls.flat().join(' ');
    expect(err).toMatch(/cannot reach https:\/\/does-not-resolve\/healthz/);
    expect(err).toMatch(/A hub that does not answer \/healthz is not a hub/);
    expect(fs.existsSync(HUB_CONFIG)).toBe(false);
  });

  it('device-code path refuses before /hub/device/start when healthz is not a hub', async () => {
    clearConfig();
    route({ healthz: { service: 'nginx' } });
    await expect(run(makeProgram(), ['hub', 'login', '--url', 'https://not-a-hub.example.com', '--no-open'])).rejects.toThrow('exit 1');
    expect(mockPost.mock.calls.some(c => String(c[0]).includes('/hub/device/start'))).toBe(false);
    expect(fs.existsSync(HUB_CONFIG)).toBe(false);
  });

  it('healthz-verified legacy login still writes hub.json', async () => {
    clearConfig();
    route({ healthz: { service: 'agenfk-hub' }, status: { orgs: {} } });
    mockPost.mockResolvedValue({ status: 200, data: { rewritten: 0, changed: false, enabled: true } });
    await run(makeProgram(), ['hub', 'login', '--url', 'https://hub.acme.com/', '--token', 'tok', '--org', 'acme']);
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'))).toEqual({ url: 'https://hub.acme.com', token: 'tok', orgId: 'acme' });
  });
});

describe('(b) stale-org detection on login/join — guidance, never auto-rewrite', () => {
  it('login prints exact per-org stale counts and the carry-over command, and does NOT rewrite', async () => {
    clearConfig();
    route({
      healthz: { service: 'agenfk-hub' },
      status: { orgs: { acme: { count: 5, firstOccurredAt: 'a', lastOccurredAt: 'b', types: {} }, 'old-corp': { count: 2, firstOccurredAt: 'c', lastOccurredAt: 'd', types: {} } } },
    });
    mockPost.mockResolvedValue({ status: 200, data: { rewritten: 0, changed: false } });
    await run(makeProgram(), ['hub', 'login', '--url', 'https://hub.acme.com', '--token', 'tok', '--org', 'acme']);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/holds events stamped for other orgs/);
    expect(out).toMatch(/2 event\(s\) still stamped "old-corp" → agenfk hub carry-over --from old-corp --to acme/);
    expect(out).toMatch(/Or drop them for good with `agenfk hub deadletter`/);
    // The sentinel stamp (from '') is allowed; NO cross-org rewrite ever.
    expect(rewritePosts().every(p => p.from === '')).toBe(true);
  });

  it('lists multiple stale orgs in descending count order', async () => {
    clearConfig();
    route({
      healthz: { service: 'agenfk-hub' },
      status: { orgs: {
        acme: { count: 5, firstOccurredAt: 'a', lastOccurredAt: 'b', types: {} },
        'small-corp': { count: 1, firstOccurredAt: 'e', lastOccurredAt: 'f', types: {} },
        'big-corp': { count: 7, firstOccurredAt: 'c', lastOccurredAt: 'd', types: {} },
      } },
    });
    mockPost.mockResolvedValue({ status: 200, data: { rewritten: 0, changed: false } });
    await run(makeProgram(), ['hub', 'login', '--url', 'https://hub.acme.com', '--token', 'tok', '--org', 'acme']);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/big-corp[\s\S]*small-corp/);
  });

  it('device-code: refuses when the hub returns a DIFFERENT hubUrl that is not a hub (token must not follow it)', async () => {
    clearConfig();
    route({ healthz: { service: 'agenfk-hub' } });
    const base = (mockGet as any).getMockImplementation();
    (mockGet as any).mockImplementation(async (url: string) => {
      if (url.includes('evil.example.com')) return { status: 200, data: { service: 'not-a-hub' } };
      return base(url);
    });
    (mockPost as any).mockImplementation(async (url: string) => {
      if (url.endsWith('/hub/device/start')) {
        return { status: 200, data: { deviceCode: 'dc', userCode: 'UC-1', verificationUrl: 'https://hub.acme.com/hub/device' } };
      }
      if (url.includes('/hub/device/poll')) {
        return { status: 200, data: { status: 'approved', token: 'tok', orgId: 'acme', hubUrl: 'https://evil.example.com' } };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    await expect(run(makeProgram(), ['hub', 'login', '--url', 'https://hub.acme.com'])).rejects.toThrow('exit 1');
    expect(fs.existsSync(HUB_CONFIG)).toBe(false);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/did not identify as agenfk-hub/);
  });

  it('join: refuses to persist a redeemed hubUrl that does not identify as agenfk-hub', async () => {
    clearConfig();
    route({ healthz: { service: 'not-a-hub' } });
    (mockPost as any).mockResolvedValue({ status: 200, data: { token: 'tok', orgId: 'acme', hubUrl: 'https://hub.acme.com' } });
    await expect(run(makeProgram(), ['hub', 'join', 'https://hub.acme.com', 'INVITE', '--no-restart'])).rejects.toThrow('exit 1');
    expect(fs.existsSync(HUB_CONFIG)).toBe(false);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/did not identify as agenfk-hub/);
  });

  it('device-code happy path: persists the returned config verbatim (url, token, org)', async () => {
    clearConfig();
    route({ healthz: { service: 'agenfk-hub' }, status: { orgs: {} } });
    (mockPost as any).mockImplementation(async (url: string) => {
      if (url.endsWith('/hub/device/start')) {
        return { status: 200, data: { deviceCode: 'dc', userCode: 'UC-1', verificationUri: 'https://hub.acme.com/hub/device', interval: 1 } };
      }
      if (url.includes('/hub/device/poll')) {
        return { status: 200, data: { status: 'approved', token: 'tok-dev', orgId: 'acme', hubUrl: 'https://hub.acme.com/' } };
      }
      if (url.includes('/internal/hub/reload')) return { status: 200, data: { changed: true } };
      throw new Error(`unexpected POST ${url}`);
    });
    await run(makeProgram(), ['hub', 'login', '--url', 'https://hub.acme.com', '--no-open']);
    const cfg = JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'));
    // Trailing slash stripped, returned hubUrl persisted — a mutation of
    // either lands here.
    expect(cfg).toEqual({ url: 'https://hub.acme.com', token: 'tok-dev', orgId: 'acme' });
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Hub configured at https:\/\/hub\.acme\.com \(org=acme\)/);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/pushing events with this config/);
  });

  it('join happy path: redeemed hubUrl is persisted after the gate', async () => {
    clearConfig();
    route({ healthz: { service: 'agenfk-hub' }, status: { orgs: {} } });
    (mockPost as any).mockImplementation(async (url: string) => {
      if (url.includes('/hub/invite/redeem')) {
        return { status: 200, data: { token: 'tok-join', orgId: 'acme', hubUrl: 'https://hub.acme.com' } };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    await run(makeProgram(), ['hub', 'join', 'https://hub.acme.com', 'INVITE', '--no-restart']);
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'))).toEqual({ url: 'https://hub.acme.com', token: 'tok-join', orgId: 'acme' });
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Joined https:\/\/hub\.acme\.com \(org=acme\)/);
  });

  it('stays silent when the outbox only holds the current org', async () => {
    clearConfig();
    route({ healthz: { service: 'agenfk-hub' }, status: { orgs: { acme: { count: 5, firstOccurredAt: 'a', lastOccurredAt: 'b', types: {} } } } });
    mockPost.mockResolvedValue({ status: 200, data: { rewritten: 0, changed: false } });
    await run(makeProgram(), ['hub', 'login', '--url', 'https://hub.acme.com', '--token', 'tok', '--org', 'acme']);
    expect(logSpy.mock.calls.flat().join(' ')).not.toMatch(/carry-over/);
  });

  it('survives an unreachable local server (guidance is best-effort)', async () => {
    clearConfig();
    route({ healthz: { service: 'agenfk-hub' }, status: null });
    mockPost.mockRejectedValue(new Error('ECONNREFUSED'));
    await run(makeProgram(), ['hub', 'login', '--url', 'https://hub.acme.com', '--token', 'tok', '--org', 'acme']);
    expect(fs.existsSync(HUB_CONFIG)).toBe(true);
  });

  it('join surfaces stale-org guidance without rewriting anything', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url.includes('/hub/invite/redeem')) return { status: 200, data: { hubUrl: 'https://hub.acme.com', token: 'tok-new', orgId: 'acme' } };
      return { status: 200, data: {} };
    });
    route({ status: { orgs: { 'old-corp': { count: 4, firstOccurredAt: 'c', lastOccurredAt: 'd', types: {} } } } });
    await run(makeProgram(), ['hub', 'join', 'https://hub.acme.com', 'invtok', '--no-restart']);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/4 event\(s\) still stamped "old-corp"/);
    expect(out).toMatch(/agenfk hub carry-over --from old-corp --to acme/);
    expect(rewritePosts()).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8')).orgId).toBe('acme');
  });
});

describe('(c) repoint --carry-over gating', () => {
  const repointArgs = (extra: string[] = []) => ['hub', 'repoint', '--org-id', 'cglab', ...extra];
  beforeEach(() => {
    route({
      healthz: { service: 'agenfk-hub' },
      ping: () => ({ ok: true, orgId: 'cglab' }),
      status: { orgs: {} },
    });
  });

  it('without --carry-over: config swaps, outbox is NOT rewritten, guidance points at carry-over', async () => {
    await run(makeProgram(), repointArgs(['--no-restart']));
    expect(rewritePosts()).toHaveLength(0);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/Outbox events stamped "staging" were left untouched/);
    expect(out).toMatch(/agenfk hub carry-over --from staging --to cglab/);
    expect(out).toMatch(/Or drop them: agenfk hub deadletter/);
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8')).orgId).toBe('cglab');
  });

  it('--carry-over --yes rewrites exactly staging->cglab and writes the audit line', async () => {
    mockPost.mockImplementation(async (url: string, body: any) => {
      if (url.includes('/internal/hub/reload')) return { status: 200, data: { changed: true } };
      expect(body).toEqual({ from: 'staging', to: 'cglab' });
      return { status: 200, data: { ok: true, rewritten: 9 } };
    });
    await run(makeProgram(), repointArgs(['--carry-over', '--yes', '--no-restart']));
    expect(rewritePosts()).toEqual([{ from: 'staging', to: 'cglab' }]);
    const audit = JSON.parse(fs.readFileSync(AUDIT, 'utf8').trim());
    expect(audit).toMatchObject({ from: 'staging', to: 'cglab', rewritten: 9 });
  });

  it('--carry-over without --yes demands the typed target org', async () => {
    mockPost.mockImplementation(async (url: string, body: any) => {
      if (url.includes('/internal/hub/reload')) return { status: 200, data: { changed: true } };
      return { status: 200, data: { ok: true, rewritten: 9 } };
    });
    askState.answer = 'wrong';
    await run(makeProgram(), repointArgs(['--carry-over', '--no-restart']));
    expect(askState.lastQuestion).toMatch(/cglab/);
    expect(rewritePosts()).toHaveLength(0);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Aborted/);
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8')).orgId).toBe('cglab');
  });

  it('--carry-over without a verify-token warns and still repoints', async () => {
    try { fs.unlinkSync(VERIFY_TOKEN); } catch { /* */ }
    await run(makeProgram(), repointArgs(['--carry-over', '--yes', '--no-restart']));
    expect(rewritePosts()).toHaveLength(0);
    expect(errSpy.mock.calls.flat().join(' ') + warnSpy.mock.calls.flat().join(' ')).toMatch(/No verify-token — skipping local outbox rewrite/);
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8')).orgId).toBe('cglab');
  });

  it('--carry-over tolerates an unreachable local server (warns, repoint stands)', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url.includes('/internal/hub/rewrite-outbox-org')) throw new Error('ECONNREFUSED');
      if (url.includes('/internal/hub/reload')) return { status: 200, data: { changed: true } };
      return { status: 200, data: {} };
    });
    await run(makeProgram(), repointArgs(['--carry-over', '--yes', '--no-restart']));
    expect(errSpy.mock.calls.flat().join(' ') + warnSpy.mock.calls.flat().join(' ') + logSpy.mock.calls.flat().join(' ')).toMatch(/Could not rewrite local outbox .*agenfk hub carry-over --from staging --to cglab/);
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8')).orgId).toBe('cglab');
  });

  it('--carry-over SHOUTS when the rewrite succeeded but the audit write fails', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url.includes('/internal/hub/reload')) return { status: 200, data: { changed: true } };
      return { status: 200, data: { ok: true, rewritten: 4 } };
    });
    fs.chmodSync(AGENFK_DIR, 0o500);
    try {
      await expect(run(makeProgram(), repointArgs(['--carry-over', '--yes', '--no-restart']))).rejects.toThrow('exit 1');
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/REWRITE SUCCEEDED \(4 event\(s\)\) BUT THE AUDIT LINE FAILED TO WRITE/);
    } finally {
      fs.chmodSync(AGENFK_DIR, 0o700);
    }
  });

  it('--carry-over without a TTY refuses the rewrite but still repoints', async () => {
    setTty(false);
    await run(makeProgram(), repointArgs(['--carry-over', '--no-restart']));
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/not a TTY/);
    expect(rewritePosts()).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8')).orgId).toBe('cglab');
  });

  it('same org (no org change) never rewrites or prompts', async () => {
    // A DIFFERENT url with the SAME org id: passes the "nothing to change"
    // guard, clears healthz+ping, and must still skip the whole carry-over
    // branch — the guard-return shortcut would make this vacuous otherwise.
    route({ healthz: { service: 'agenfk-hub' }, ping: () => ({ ok: true, orgId: 'staging' }), status: { orgs: {} } });
    await run(makeProgram(), ['hub', 'repoint', '--url', 'https://hub.new.example.com', '--no-restart']);
    expect(rewritePosts()).toHaveLength(0);
    expect(askState.lastQuestion).toBe('');
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8')).url).toBe('https://hub.new.example.com');
  });
});

describe('(d) flush reporting and exit codes', () => {
  it('exits 1 with a red diagnostic when the flush ended with lastError', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { outboxDepth: 12, lastError: 'hub rejected 5 of 12 events', staleOrgDepth: 0, deadletterDepth: 5 } });
    await expect(run(makeProgram(), ['hub', 'flush'])).rejects.toThrow('exit 1');
    const err = errSpy.mock.calls.flat().join(' ');
    expect(err).toMatch(/✗ Flush ended with an error: hub rejected 5 of 12 events/);
    expect(err).toMatch(/Outbox 12 pending, deadlettered 5/);
  });

  it('warns (not green, no exit) when stale-org rows remain', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { outboxDepth: 12, lastError: null, staleOrgDepth: 12, deadletterDepth: 0 } });
    await run(makeProgram(), ['hub', 'flush']);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/12 event\(s\) carry a stale org stamp and will not be delivered — agenfk hub carry-over/);
    expect(out).not.toMatch(/✓ Flush completed/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('is green and exit-free when everything drained', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { outboxDepth: 0, lastError: null, staleOrgDepth: 0, deadletterDepth: 0 } });
    await run(makeProgram(), ['hub', 'flush']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Flush completed/);
  });
});

describe('(e) status depths', () => {
  it('shows stale-org depth, deadletter depth and the per-org breakdown', async () => {
    route({
      status: {
        staleOrgDepth: 3, deadletterDepth: 2,
        orgs: {
          acme: { count: 4, firstOccurredAt: '2026-01-01T00:00:00Z', lastOccurredAt: '2026-01-02T00:00:00Z', types: { 'item.created': 4 } },
          'old-corp': { count: 3, firstOccurredAt: '2025-12-01T00:00:00Z', lastOccurredAt: '2025-12-30T00:00:00Z', types: { 'item.closed': 3 } },
          '': { count: 1, firstOccurredAt: '2025-11-01T00:00:00Z', lastOccurredAt: '2025-11-01T00:00:00Z', types: {} },
        },
        lastFlushAt: 'x', lastError: null, halted: false, consecutiveFailures: 0,
      },
    });
    await run(makeProgram(), ['hub', 'status']);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/By org:\s+acme: 4, old-corp: 3, \(pre-login\): 1/);
    expect(out).toMatch(/Stale-org rows: 3/);
    expect(out).toMatch(/different org — carry-over or discard/);
    expect(out).toMatch(/Deadlettered: 2/);
    expect(out).toMatch(/hub-rejected, preserved/);
  });
});
