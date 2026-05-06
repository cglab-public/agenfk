import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

// Sandbox HOME so the tests never touch the developer's real ~/.agenfk/server-port.
// Must run BEFORE the module under test resolves SERVER_PORT_FILE at import time.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-serverport-'));
const realHome = process.env.HOME;
process.env.HOME = sandboxHome;

// Import after HOME is overridden.
const mod = await import('../serverPort.js');
const {
  SERVER_PORT_FILE,
  DEFAULT_API_PORT,
  isPortAvailable,
  findAvailablePort,
  writeServerPortFile,
  removeServerPortFile,
  readServerPort,
  getApiUrl,
} = mod;

describe('serverPort', () => {
  let occupiers: net.Server[] = [];
  const occupy = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.once('listening', () => { occupiers.push(s); resolve(); });
      s.listen(port, '127.0.0.1');
    });

  const originalEnv = { ...process.env };

  afterEach(async () => {
    await Promise.all(occupiers.map(s => new Promise<void>(r => s.close(() => r()))));
    occupiers = [];
    // Restore env but keep HOME pointed at the sandbox.
    process.env = { ...originalEnv, HOME: sandboxHome };
    removeServerPortFile();
  });

  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('isPortAvailable', () => {
    it('returns true for a free port', async () => {
      // Pick a high port unlikely to be used.
      expect(await isPortAvailable(54_321)).toBe(true);
    });

    it('returns false for an occupied port', async () => {
      await occupy(54_322);
      expect(await isPortAvailable(54_322)).toBe(false);
    });
  });

  describe('findAvailablePort', () => {
    it('returns the starting port when free', async () => {
      const p = await findAvailablePort(54_400);
      expect(p).toBe(54_400);
    });

    it('skips occupied ports and returns the next free one', async () => {
      await occupy(54_500);
      await occupy(54_501);
      const p = await findAvailablePort(54_500);
      expect(p).toBe(54_502);
    });

    it('throws when no free port is found within maxAttempts', async () => {
      await occupy(54_600);
      await expect(findAvailablePort(54_600, '127.0.0.1', 1)).rejects.toThrow(/No free port/);
    });
  });

  describe('persistence', () => {
    it('round-trips port via write/read', () => {
      writeServerPortFile(45_678);
      expect(readServerPort()).toBe(45_678);
    });

    it('writes to ~/.agenfk/server-port (sandbox-scoped HOME)', () => {
      writeServerPortFile(31_415);
      const expected = path.join(sandboxHome, '.agenfk', 'server-port');
      expect(SERVER_PORT_FILE).toBe(expected);
      expect(fs.readFileSync(expected, 'utf8').trim()).toBe('31415');
    });

    it('removeServerPortFile is idempotent', () => {
      removeServerPortFile();
      expect(() => removeServerPortFile()).not.toThrow();
      expect(readServerPort()).toBeNull();
    });

    it('readServerPort returns null for invalid contents', () => {
      fs.mkdirSync(path.dirname(SERVER_PORT_FILE), { recursive: true });
      fs.writeFileSync(SERVER_PORT_FILE, 'not-a-port');
      expect(readServerPort()).toBeNull();
    });
  });

  describe('getApiUrl', () => {
    it('prefers AGENFK_API_URL when set', () => {
      process.env.AGENFK_API_URL = 'http://example.com:9999';
      expect(getApiUrl()).toBe('http://example.com:9999');
    });

    it('falls back to AGENFK_PORT env var', () => {
      delete process.env.AGENFK_API_URL;
      delete process.env.PORT;
      process.env.AGENFK_PORT = '4242';
      expect(getApiUrl()).toBe('http://localhost:4242');
    });

    it('falls back to persisted port file when env unset', () => {
      delete process.env.AGENFK_API_URL;
      delete process.env.AGENFK_PORT;
      delete process.env.PORT;
      writeServerPortFile(5151);
      expect(getApiUrl()).toBe('http://localhost:5151');
    });

    it('falls back to default port last', () => {
      delete process.env.AGENFK_API_URL;
      delete process.env.AGENFK_PORT;
      delete process.env.PORT;
      removeServerPortFile();
      expect(getApiUrl()).toBe(`http://localhost:${DEFAULT_API_PORT}`);
    });
  });
});
