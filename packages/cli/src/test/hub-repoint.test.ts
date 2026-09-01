import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-repoint-'));
const realHome = process.env.HOME;
process.env.HOME = sandboxHome;

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));
vi.mock('axios', () => ({ default: { get: mockGet, post: mockPost } }));
vi.mock('@agenfk/telemetry', () => ({
  getApiUrl: () => 'http://localhost:3000',
  getInstallationId: () => 'inst-test',
}));

const { registerHubCommands } = await import('../commands/hub.js');

const HUB_CONFIG = path.join(sandboxHome, '.agenfk', 'hub.json');
const VERIFY_TOKEN = path.join(sandboxHome, '.agenfk', 'verify-token');
const ORIGINAL = { url: 'https://afk-hub.stg.cglab.com', token: 'tok-stg', orgId: 'staging' };

function seedConfig(cfg: { url: string; token: string; orgId: string } = ORIGINAL): void {
  fs.mkdirSync(path.dirname(HUB_CONFIG), { recursive: true });
  fs.writeFileSync(HUB_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.writeFileSync(VERIFY_TOKEN, 'verifytok');
}

function mockHealthz(serviceField: string | undefined, version = '0.3.0'): void {
  // GET /healthz
  mockGet.mockImplementationOnce(async (url: string) => {
    if (!url.endsWith('/healthz')) throw new Error(`unexpected GET ${url}`);
    const body: any = { ok: true, version };
    if (serviceField !== undefined) body.service = serviceField;
    return { status: 200, data: body };
  });
}

function mockPing(orgId: string): void {
  // GET /v1/ping (auth)
  mockGet.mockImplementationOnce(async (url: string, _opts: any) => {
    if (!url.endsWith('/v1/ping')) throw new Error(`unexpected GET ${url}`);
    return { status: 200, data: { ok: true, orgId } };
  });
}

describe('agenfk hub repoint', () => {
  let program: Command;
  let exitSpy: any;
  let logSpy: any;
  let errSpy: any;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerHubCommands(program);
    try { fs.unlinkSync(HUB_CONFIG); } catch { /* */ }
    fs.mkdirSync(path.dirname(HUB_CONFIG), { recursive: true });
    fs.writeFileSync(VERIFY_TOKEN, 'verifytok');
    mockGet.mockReset();
    mockPost.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    try { fs.unlinkSync(HUB_CONFIG); } catch { /* */ }
  });

  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('refuses when no existing hub.json — directs user to login/join', async () => {
    await expect(program.parseAsync(['node', 'agenfk', 'hub', 'repoint', '--url', 'https://x', '--org-id', 'cglab']))
      .rejects.toThrow(/exit 1/);
    const err = errSpy.mock.calls.flat().join(' ');
    expect(err).toMatch(/no existing hub config|hub login|hub join/i);
  });

  it('refuses when /healthz does not announce service: "agenfk-hub"', async () => {
    seedConfig();
    mockHealthz(undefined);   // missing field
    await expect(program.parseAsync(['node', 'agenfk', 'hub', 'repoint', '--url', 'https://newhub', '--org-id', 'cglab']))
      .rejects.toThrow(/exit 1/);
    // hub.json untouched.
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'))).toEqual(ORIGINAL);
    const err = errSpy.mock.calls.flat().join(' ');
    expect(err).toMatch(/agenfk-hub|service/i);
  });

  it('refuses when /v1/ping orgId mismatches the requested org-id', async () => {
    seedConfig();
    mockHealthz('agenfk-hub');
    mockPing('something-else');     // server says different org
    await expect(program.parseAsync(['node', 'agenfk', 'hub', 'repoint', '--url', 'https://newhub', '--org-id', 'cglab']))
      .rejects.toThrow(/exit 1/);
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'))).toEqual(ORIGINAL);
  });

  it('happy path: rewrites local outbox via internal endpoint, then writes new hub.json', async () => {
    seedConfig();
    mockHealthz('agenfk-hub');
    mockPing('cglab');
    // POST /internal/hub/rewrite-outbox-org — we don't care if local API isn't
    // running in this test; the CLI must still tolerate a 4xx/missing server
    // by warning, not by failing the whole repoint. (Spec: outbox rewrite is
    // best-effort; if we can't reach the local server we skip it loudly.)
    mockPost.mockResolvedValueOnce({ status: 200, data: { rewritten: 3 } });

    await program.parseAsync([
      'node', 'agenfk', 'hub', 'repoint',
      '--url', 'https://afk-hub.prd.cglab.com',
      '--org-id', 'cglab',
      // CGLAB-117 story 4: the rewrite now requires an explicit opt-in
      // (--carry-over, --yes skips the typed confirmation). Spec-mandated.
      '--carry-over', '--yes',
      '--no-restart',
    ]);

    const cfg = JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'));
    expect(cfg).toEqual({
      url: 'https://afk-hub.prd.cglab.com',
      token: 'tok-stg',
      orgId: 'cglab',
    });
    // mode 0600 preserved (same convention as login/join).
    const stat = fs.statSync(HUB_CONFIG);
    expect(stat.mode & 0o777).toBe(0o600);

    // Outbox rewrite hit the internal endpoint with verify token + body.
    expect(mockPost).toHaveBeenCalledWith(
      'http://localhost:3000/internal/hub/rewrite-outbox-org',
      expect.objectContaining({ from: 'staging', to: 'cglab' }),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-agenfk-internal': 'verifytok' }) }),
    );
  });

  it('only --url change (orgId unchanged): does NOT call the outbox rewrite endpoint', async () => {
    seedConfig();
    mockHealthz('agenfk-hub');
    mockPing('staging');     // same org
    await program.parseAsync([
      'node', 'agenfk', 'hub', 'repoint',
      '--url', 'https://renamed-hub.example.com',
      '--no-restart',
    ]);
    const cfg = JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'));
    expect(cfg.url).toBe('https://renamed-hub.example.com');
    expect(cfg.orgId).toBe('staging');     // unchanged
    expect(cfg.token).toBe('tok-stg');     // carried over
    // No POST to rewrite endpoint when orgId didn't change.
    const rewriteCalls = mockPost.mock.calls.filter(c => String(c[0]).includes('/internal/hub/rewrite-outbox-org'));
    expect(rewriteCalls).toHaveLength(0);
  });

  it('tolerates a missing local API server during outbox rewrite (warns, still writes hub.json)', async () => {
    seedConfig();
    mockHealthz('agenfk-hub');
    mockPing('cglab');
    mockPost.mockRejectedValueOnce(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    await program.parseAsync([
      'node', 'agenfk', 'hub', 'repoint',
      '--url', 'https://prod', '--org-id', 'cglab', '--carry-over', '--yes', '--no-restart',
    ]);
    // hub.json IS updated even though outbox rewrite couldn't reach the local server.
    expect(JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8')).orgId).toBe('cglab');
    // …but the user is warned to run the rewrite manually after `agenfk up`.
    const allOut = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(' ');
    expect(allOut).toMatch(/outbox|agenfk up|repoint/i);
  });
});
