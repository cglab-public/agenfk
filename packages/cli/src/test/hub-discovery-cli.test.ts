/**
 * Story 76da75ea (INFRA-463), criterion 3: `agenfk hub login` with no --url
 * uses discovery, and `agenfk hub status` shows the source the URL came from.
 *
 * The discovery module is mocked here: its own behaviour is pinned in
 * hub-discovery.test.ts. These tests pin the wiring only:
 *  - login without --url asks discoverHub() and logs in to what it found;
 *  - login with --url does not consult discovery (the flag is the answer);
 *  - nothing found is a clear refusal that lists the reasons, writing nothing;
 *  - hub.json records the source, and status prints it.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-discovery-cli-')) };
});
const { mockGet, mockPost, mockDiscover } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockDiscover: vi.fn(),
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
vi.mock('../hub/discovery', () => ({ discoverHub: mockDiscover }));

import { registerHubCommands } from '../commands/hub';

const AGENFK_DIR = path.join(sandboxHome, '.agenfk');
const HUB_CONFIG = path.join(AGENFK_DIR, 'hub.json');
const VERIFY_TOKEN = path.join(AGENFK_DIR, 'verify-token');
const DISCOVERED = 'https://hub.acme.com';

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerHubCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await makeProgram().parseAsync(args, { from: 'user' });
}

/** Every GET healthy; /internal/hub/status answers a quiet outbox. */
function routeGets(): void {
  mockGet.mockImplementation(async (url: string) => {
    if (url.endsWith('/healthz')) return { status: 200, data: { ok: true, service: 'agenfk-hub' } };
    if (url.endsWith('/v1/ping')) return { status: 200, data: { ok: true } };
    if (url.includes('/internal/hub/status')) return { status: 200, data: { enabled: true, outboxDepth: 0, orgs: {} } };
    throw new Error(`unexpected GET ${url}`);
  });
}

/** Device flow approves at once, for whichever hub was contacted. */
function routeDeviceFlow(): void {
  mockPost.mockImplementation(async (url: string) => {
    if (url.endsWith('/hub/device/start')) {
      return { status: 200, data: { deviceCode: 'dc', userCode: 'UC-1', verificationUri: `${DISCOVERED}/hub/device`, interval: 1 } };
    }
    if (url.includes('/hub/device/poll')) {
      return { status: 200, data: { status: 'approved', token: 'tok-dev', orgId: 'acme', hubUrl: DISCOVERED } };
    }
    if (url.includes('/internal/hub/')) return { status: 200, data: { changed: true, rewritten: 0 } };
    throw new Error(`unexpected POST ${url}`);
  });
}

const out = (spy: any) => spy.mock.calls.flat().join('\n');

let exitSpy: any;
let logSpy: any;
let errSpy: any;
let savedHubUrl: string | undefined;

beforeEach(() => {
  fs.mkdirSync(AGENFK_DIR, { recursive: true });
  try { fs.unlinkSync(HUB_CONFIG); } catch { /* */ }
  fs.writeFileSync(VERIFY_TOKEN, 'verifytok');
  mockGet.mockReset(); mockPost.mockReset(); mockDiscover.mockReset();
  savedHubUrl = process.env.AGENFK_HUB_URL;
  delete process.env.AGENFK_HUB_URL;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  if (savedHubUrl === undefined) delete process.env.AGENFK_HUB_URL;
  else process.env.AGENFK_HUB_URL = savedHubUrl;
  vi.restoreAllMocks();
});

afterAll(() => {
  try { fs.rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* */ }
});

describe('hub login with no --url uses discovery', () => {
  it('device flow: logs in to the discovered hub and records the source in hub.json', async () => {
    mockDiscover.mockResolvedValue({ url: DISCOVERED, source: 'dns', orgId: 'acme', reasons: [] });
    routeGets();
    routeDeviceFlow();
    await run(['hub', 'login', '--no-open']);
    expect(mockDiscover).toHaveBeenCalledTimes(1);
    const started = mockPost.mock.calls.map(c => String(c[0])).filter(u => u.endsWith('/hub/device/start'));
    expect(started).toEqual([`${DISCOVERED}/hub/device/start`]);
    const cfg = JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'));
    expect(cfg).toEqual({ url: DISCOVERED, token: 'tok-dev', orgId: 'acme', source: 'dns' });
  });

  it('says where the URL came from before signing in', async () => {
    mockDiscover.mockResolvedValue({ url: DISCOVERED, source: 'managed', reasons: [] });
    routeGets();
    routeDeviceFlow();
    await run(['hub', 'login', '--no-open']);
    expect(out(logSpy)).toMatch(/hub\.acme\.com/);
    expect(out(logSpy)).toMatch(/managed/);
  });

  it('legacy --token path: pings the discovered hub and records the source', async () => {
    mockDiscover.mockResolvedValue({ url: DISCOVERED, source: 'managed', orgId: 'acme', reasons: [] });
    routeGets();
    mockPost.mockResolvedValue({ status: 200, data: { rewritten: 0, changed: false } });
    await run(['hub', 'login', '--token', 'tok', '--org', 'acme']);
    expect(mockGet.mock.calls.map(c => String(c[0]))).toContain(`${DISCOVERED}/v1/ping`);
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8')))
      .toEqual({ url: DISCOVERED, token: 'tok', orgId: 'acme', source: 'managed' });
  });

  it('nothing discovered: exits 1, lists every reason, points at --url, writes nothing', async () => {
    mockDiscover.mockResolvedValue({
      url: null,
      reasons: ['/etc/agenfk/managed.json: not present', '_agenfk-hub.acme.com: no TXT record'],
    });
    routeGets();
    await expect(run(['hub', 'login', '--no-open'])).rejects.toThrow('exit 1');
    const err = out(errSpy);
    expect(err).toContain('/etc/agenfk/managed.json: not present');
    expect(err).toContain('_agenfk-hub.acme.com: no TXT record');
    expect(err).toMatch(/--url/);
    expect(fs.existsSync(HUB_CONFIG)).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a discovery that throws is a refusal, not a stack trace', async () => {
    mockDiscover.mockRejectedValue(new Error('boom'));
    routeGets();
    await expect(run(['hub', 'login', '--no-open'])).rejects.toThrow('exit 1');
    expect(fs.existsSync(HUB_CONFIG)).toBe(false);
  });

  it('with --url, discovery is not consulted and the source is recorded as flag', async () => {
    routeGets();
    mockPost.mockResolvedValue({ status: 200, data: { rewritten: 0, changed: false } });
    await run(['hub', 'login', '--url', 'https://explicit.example.com/', '--token', 'tok', '--org', 'acme']);
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8')))
      .toEqual({ url: 'https://explicit.example.com', token: 'tok', orgId: 'acme', source: 'flag' });
  });
});

describe('hub status shows the source the URL came from', () => {
  function seed(cfg: Record<string, unknown>): void {
    fs.writeFileSync(HUB_CONFIG, JSON.stringify(cfg), { mode: 0o600 });
  }

  it('prints the recorded source', async () => {
    seed({ url: DISCOVERED, token: 'tok-12345678', orgId: 'acme', source: 'dns' });
    routeGets();
    await run(['hub', 'status']);
    expect(out(logSpy)).toMatch(/Source:\s+dns/);
  });

  it.each(['flag', 'env', 'managed', 'user'])('prints source %s', async (source) => {
    seed({ url: DISCOVERED, token: 'tok-12345678', orgId: 'acme', source });
    routeGets();
    await run(['hub', 'status']);
    expect(out(logSpy)).toMatch(new RegExp(`Source:\\s+${source}`));
  });

  it('a hub.json written before discovery existed says the source is unknown', async () => {
    seed({ url: DISCOVERED, token: 'tok-12345678', orgId: 'acme' });
    routeGets();
    await run(['hub', 'status']);
    expect(out(logSpy)).toMatch(/Source:\s+unknown/);
  });

  it('AGENFK_HUB_URL overrides hub.json (the server rule), so status shows that URL and source env', async () => {
    seed({ url: DISCOVERED, token: 'tok-12345678', orgId: 'acme', source: 'dns' });
    process.env.AGENFK_HUB_URL = 'https://env.example.com';
    routeGets();
    await run(['hub', 'status']);
    const log = out(logSpy);
    expect(log).toMatch(/Hub URL:\s+https:\/\/env\.example\.com/);
    expect(log).toMatch(/Source:\s+env/);
  });

  it('status does not run discovery (no DNS or network on a status read)', async () => {
    seed({ url: DISCOVERED, token: 'tok-12345678', orgId: 'acme', source: 'dns' });
    routeGets();
    await run(['hub', 'status']);
    expect(mockDiscover).not.toHaveBeenCalled();
  });
});

/** Review round 1 (FIX_FIRST): the paths that rewrite hub.json, and the org a discovery supplies. */
describe('hub.json source across the commands that rewrite it', () => {
  function seed(cfg: Record<string, unknown>): void {
    fs.writeFileSync(HUB_CONFIG, JSON.stringify(cfg), { mode: 0o600 });
  }
  const saved = () => JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'));

  it('--token without --org uses the org the discovered source names', async () => {
    mockDiscover.mockResolvedValue({ url: DISCOVERED, source: 'managed', orgId: 'acme-from-mdm', reasons: [] });
    routeGets();
    mockPost.mockResolvedValue({ status: 200, data: { rewritten: 0, changed: false } });
    await run(['hub', 'login', '--token', 'tok']);
    expect(saved()).toMatchObject({ url: DISCOVERED, orgId: 'acme-from-mdm', source: 'managed' });
  });

  it('join to another URL drops the recorded source, which named the old URL', async () => {
    seed({ url: 'https://old.acme.com', token: 'tok-old', orgId: 'acme', source: 'dns' });
    routeGets();
    mockPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/hub/invite/redeem')) return { status: 200, data: { token: 'tok-new', orgId: 'acme', hubUrl: DISCOVERED } };
      return { status: 200, data: { changed: true, rewritten: 0 } };
    });
    await run(['hub', 'join', DISCOVERED, 'invite-token']).catch(() => { /* exit after write is fine */ });
    expect(saved().url).toBe(DISCOVERED);
    expect(saved()).not.toHaveProperty('source');
  });

  it('join to the same URL keeps the recorded source', async () => {
    seed({ url: DISCOVERED, token: 'tok-old', orgId: 'acme', source: 'dns' });
    routeGets();
    mockPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/hub/invite/redeem')) return { status: 200, data: { token: 'tok-new', orgId: 'acme', hubUrl: DISCOVERED } };
      return { status: 200, data: { changed: true, rewritten: 0 } };
    });
    await run(['hub', 'join', 'invite-token']).catch(() => { /* exit after write is fine */ });
    expect(saved()).toMatchObject({ url: DISCOVERED, token: 'tok-new', source: 'dns' });
  });

  it('repoint keeps the recorded source', async () => {
    seed({ url: DISCOVERED, token: 'tok-12345678', orgId: 'acme', source: 'managed' });
    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/healthz')) return { status: 200, data: { ok: true, service: 'agenfk-hub' } };
      if (url.endsWith('/v1/ping')) return { status: 200, data: { ok: true, orgId: 'acme' } };
      return { status: 200, data: {} };
    });
    mockPost.mockResolvedValue({ status: 200, data: { changed: true, rewritten: 0 } });
    await run(['hub', 'repoint', '--token', 'tok-rotated', '--no-restart']).catch(() => { /* exit after write is fine */ });
    expect(saved()).toMatchObject({ token: 'tok-rotated', source: 'managed' });
  });
});

describe('hub status follows every override the server honours', () => {
  const keys = ['AGENFK_HUB_ORG', 'AGENFK_HUB_TOKEN'] as const;
  const before: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) { before[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of keys) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } });

  it('shows the org and token from AGENFK_HUB_ORG and AGENFK_HUB_TOKEN, as the server uses them', async () => {
    fs.writeFileSync(HUB_CONFIG, JSON.stringify({ url: DISCOVERED, token: 'tok-file-1234', orgId: 'org-file', source: 'dns' }), { mode: 0o600 });
    process.env.AGENFK_HUB_ORG = 'org-env';
    process.env.AGENFK_HUB_TOKEN = 'tok-env-9876';
    routeGets();
    await run(['hub', 'status']);
    const log = out(logSpy);
    expect(log).toMatch(/Org:\s+org-env/);
    expect(log).toMatch(/Token:\s+tok-env-/);
  });
});
