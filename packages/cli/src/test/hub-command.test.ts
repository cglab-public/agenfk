import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Sandbox homedir via a CALL-TIME mock of os.homedir() (item 9c297075) —
// runner-independent. Replaces the old process.env.HOME override, which only
// works while libuv follows the JS env (not under Stryker's threads pool).
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-cli-'));
vi.mocked(os.homedir).mockReturnValue(sandboxHome);

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));
vi.mock('axios', () => ({
  default: { get: mockGet, post: mockPost },
}));

vi.mock('@agenfk/telemetry', () => ({
  getApiUrl: () => 'http://localhost:3000',
  getInstallationId: () => 'inst-test',
}));

const { registerHubCommands } = await import('../commands/hub.js');

const HUB_CONFIG = path.join(sandboxHome, '.agenfk', 'hub.json');
const VERIFY_TOKEN = path.join(sandboxHome, '.agenfk', 'verify-token');

describe('agenfk hub commands', () => {
  let program: Command;
  let exitSpy: any;
  let logSpy: any;
  let errSpy: any;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerHubCommands(program);
    fs.mkdirSync(path.dirname(HUB_CONFIG), { recursive: true });
    try { fs.unlinkSync(HUB_CONFIG); } catch { /* */ }
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
    vi.mocked(os.homedir).mockRestore();
    try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* */ }
  });

  describe('login', () => {
    it('writes hub.json with chmod 600 on successful ping', async () => {
      // CGLAB-117 story 4: the first GET is now the /healthz identity gate
      // (spec clause a); the endpoint must announce itself as agenfk-hub
      // before the token is sent anywhere. Same assertions as before.
      mockGet.mockResolvedValueOnce({ status: 200, data: { service: 'agenfk-hub' } });
      mockGet.mockResolvedValueOnce({ status: 200, data: {} });
      await program.parseAsync(['node', 'agenfk', 'hub', 'login', '--url', 'http://hub.test/', '--token', 'tok123', '--org', 'acme']);
      expect(fs.existsSync(HUB_CONFIG)).toBe(true);
      const cfg = JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'));
      expect(cfg).toEqual({ url: 'http://hub.test', token: 'tok123', orgId: 'acme' });
      const stat = fs.statSync(HUB_CONFIG);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(mockGet).toHaveBeenCalledWith(
        'http://hub.test/v1/ping',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok123' }) }),
      );
    });

    it('refuses to write hub.json when ping fails', async () => {
      // CGLAB-117 story 4 reordered the GETs: /healthz (identity gate) now
      // runs BEFORE /v1/ping, so the healthz answer must be queued first or
      // this test would exercise the healthz gate, not the ping gate.
      mockGet.mockResolvedValueOnce({ status: 200, data: { service: 'agenfk-hub' } });
      mockGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(program.parseAsync(['node', 'agenfk', 'hub', 'login', '--url', 'http://hub.test', '--token', 'x', '--org', 'a']))
        .rejects.toThrow(/exit 1/);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/Refusing to write hub\.json/);
      expect(fs.existsSync(HUB_CONFIG)).toBe(false);
    });
  });

  describe('logout', () => {
    it('removes hub.json', async () => {
      fs.writeFileSync(HUB_CONFIG, JSON.stringify({ url: 'http://hub', token: 't', orgId: 'o' }));
      await program.parseAsync(['node', 'agenfk', 'hub', 'logout']);
      expect(fs.existsSync(HUB_CONFIG)).toBe(false);
    });

    it('is a no-op when not configured', async () => {
      await expect(program.parseAsync(['node', 'agenfk', 'hub', 'logout'])).resolves.not.toThrow();
    });
  });

  describe('status', () => {
    it('reports not configured when hub.json absent', async () => {
      await program.parseAsync(['node', 'agenfk', 'hub', 'status']);
      expect(logSpy.mock.calls.flat().join(' ')).toMatch(/not configured/);
    });

    it('hits /internal/hub/status when configured', async () => {
      fs.writeFileSync(HUB_CONFIG, JSON.stringify({ url: 'http://hub.test', token: 'tok123', orgId: 'acme' }));
      mockGet.mockResolvedValueOnce({ data: { outboxDepth: 5, lastFlushAt: '2026-05-03', lastError: null, halted: false } });
      await program.parseAsync(['node', 'agenfk', 'hub', 'status']);
      expect(mockGet).toHaveBeenCalledWith(
        'http://localhost:3000/internal/hub/status',
        expect.objectContaining({ headers: expect.objectContaining({ 'x-agenfk-internal': 'verifytok' }) }),
      );
    });
  });

  describe('join', () => {
    it('accepts `hub join <url> <token>` and redeems against the URL even without prior config', async () => {
      mockPost.mockResolvedValueOnce({ data: { token: 'newtok', orgId: 'acme', hubUrl: 'https://hub.example.com' } });
      // CGLAB-117 story 4: join healthz-gates the target URL BEFORE the
      // invite token is posted, and again on the redeemed hubUrl.
      mockGet.mockResolvedValue({ status: 200, data: { service: 'agenfk-hub' } });
      // No AGENFK_HUB_URL, no existing hub.json; must still work because URL is on the CLI.
      const prevEnv = process.env.AGENFK_HUB_URL;
      delete process.env.AGENFK_HUB_URL;
      try {
        await program.parseAsync([
          'node', 'agenfk', 'hub', 'join',
          'https://hub.example.com', 'INVITE_TOK',
          '--no-restart',
        ]);
      } finally {
        if (prevEnv !== undefined) process.env.AGENFK_HUB_URL = prevEnv;
      }
      expect(mockPost).toHaveBeenCalledWith(
        'https://hub.example.com/hub/invite/redeem',
        expect.objectContaining({ inviteToken: 'INVITE_TOK' }),
        expect.any(Object),
      );
      const cfg = JSON.parse(fs.readFileSync(HUB_CONFIG, 'utf8'));
      expect(cfg.url).toBe('https://hub.example.com');
      expect(cfg.token).toBe('newtok');
    });

    it('single-arg form still works with an existing hub.json', async () => {
      fs.writeFileSync(HUB_CONFIG, JSON.stringify({ url: 'http://hub.test', token: 'old', orgId: 'acme' }));
      mockPost.mockResolvedValueOnce({ data: { token: 'newtok', orgId: 'acme', hubUrl: 'http://hub.test' } });
      // CGLAB-117 story 4: join healthz-gates the target URL BEFORE the
      // invite token is posted, and again on the redeemed hubUrl.
      mockGet.mockResolvedValue({ status: 200, data: { service: 'agenfk-hub' } });
      await program.parseAsync(['node', 'agenfk', 'hub', 'join', 'INVITE_TOK', '--no-restart']);
      expect(mockPost).toHaveBeenCalledWith(
        'http://hub.test/hub/invite/redeem',
        expect.objectContaining({ inviteToken: 'INVITE_TOK' }),
        expect.any(Object),
      );
    });
  });

  describe('flush', () => {
    it('calls /internal/hub/flush with verify token', async () => {
      mockPost.mockResolvedValueOnce({ data: { outboxDepth: 0, lastError: null } });
      await program.parseAsync(['node', 'agenfk', 'hub', 'flush']);
      expect(mockPost).toHaveBeenCalledWith(
        'http://localhost:3000/internal/hub/flush',
        {},
        expect.objectContaining({ headers: expect.objectContaining({ 'x-agenfk-internal': 'verifytok' }) }),
      );
    });
  });
});
