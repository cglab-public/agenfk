import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

// Sandbox homedir via a CALL-TIME mock of os.homedir() (item 9c297075).
//
// The previous mechanism was a process.env.HOME override. That depends on
// libuv picking up the mutated env — and under the Stryker child-process
// runner that linkage is broken on this machine: os.homedir() kept returning
// the machine home, so the real-fs writes in this file (writeServerPortFile /
// removeServerPortFile) landed in the REAL ~/.agenfk and a dry run deleted
// the live server-port file. A mocked homedir pins every path in this file to
// the sandbox in every runner environment — the same guarantee the vitest
// HOME pin gives for the other test files.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-serverport-'));
vi.mocked(os.homedir).mockReturnValue(sandboxHome);

// net.createServer is wrapped (real implementation by default) so the EACCES
// cases can hand serverPort.ts a server whose listen() is refused the way a
// winnat/Hyper-V excluded port refuses it (GH-307). An ESM namespace cannot be
// vi.spyOn'd, hence the partial module mock.
vi.mock('net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('net')>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
});
const realNet = await vi.importActual<typeof import('net')>('net');
const restoreCreateServer = () =>
  vi.mocked(net.createServer).mockImplementation(realNet.createServer);

// Import after the mock is armed. Paths resolve at CALL time (item 9c297075),
// so the mock is effective regardless of import order.
const mod = await import('../serverPort.js');
const {
  serverPortFile,
  DEFAULT_API_PORT,
  isPortAvailable,
  findAvailablePort,
  writeServerPortFile,
  removeServerPortFile,
  readServerPort,
  getApiUrl,
} = mod;

// The spec binds no fixed port (GH-307): on Windows, winnat/Hyper-V/WSL/Docker
// reserve dynamic port ranges that move on every boot, and a hardcoded port
// inside one fails with listen EACCES. Ports come from the OS (listen on 0).
// Ports near the top of the range are re-drawn so `findAvailablePort` always
// has room to probe upwards without hitting the 65535 ceiling: with ports kept
// <= 64535, the widest probe here (maxAttempts 1000, start..start+999) ends at
// 65534 at most. Keep this margin >= the largest maxAttempts passed below.
const PORT_CEILING_MARGIN = 1000;
const SKIP_MAX_ATTEMPTS = 1000;

/** Binds port 0 on loopback and returns the listening server and its port. */
const listenEphemeral = (): Promise<{ server: net.Server; port: number }> =>
  new Promise((resolve, reject) => {
    const s = realNet.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      resolve({ server: s, port: (s.address() as net.AddressInfo).port });
    });
  });

const closeServer = (s: net.Server): Promise<void> => new Promise(r => s.close(() => r()));

/** An OS-assigned port that was free a moment ago (its socket is closed). */
const getFreePort = async (): Promise<number> => {
  for (;;) {
    const { server, port } = await listenEphemeral();
    await closeServer(server);
    if (port <= 65535 - PORT_CEILING_MARGIN) return port;
  }
};

/**
 * A stand-in for net.Server whose listen() is refused with `code` on the next
 * tick — what a port inside a Windows excluded range does (EACCES) — unless
 * `refuse` says the port is fine, in which case it emits 'listening'.
 */
class FakeServer extends EventEmitter {
  constructor(private readonly refuse: (port: number) => boolean, private readonly code = 'EACCES') {
    super();
  }
  unref() { return this; }
  listen(port: number) {
    process.nextTick(() => {
      if (this.refuse(port)) {
        const err = Object.assign(new Error(`listen ${this.code}: permission denied 127.0.0.1:${port}`), {
          code: this.code, errno: -4092, syscall: 'listen', address: '127.0.0.1', port,
        });
        this.emit('error', err);
      } else {
        this.emit('listening');
      }
    });
    return this;
  }
  close(cb?: () => void) { if (cb) process.nextTick(cb); return this; }
}

const stubCreateServer = (refuse: (port: number) => boolean) => {
  const created: FakeServer[] = [];
  vi.mocked(net.createServer).mockImplementation((() => {
    const s = new FakeServer(refuse);
    created.push(s);
    return s as unknown as net.Server;
  }) as typeof net.createServer);
  return created;
};

describe('serverPort', () => {
  let occupiers: net.Server[] = [];
  /** Holds an OS-assigned port open for the rest of the test; returns it. */
  const occupyEphemeral = async (): Promise<number> => {
    for (;;) {
      const { server, port } = await listenEphemeral();
      if (port <= 65535 - PORT_CEILING_MARGIN) { occupiers.push(server); return port; }
      await closeServer(server);
    }
  };
  /** Tries to hold `port` open; resolves false (no throw) if it cannot be bound. */
  const tryOccupy = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const s = realNet.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => { occupiers.push(s); resolve(true); });
      s.listen(port, '127.0.0.1');
    });

  const originalEnv = { ...process.env };

  afterEach(async () => {
    restoreCreateServer();
    await Promise.all(occupiers.map(s => new Promise<void>(r => s.close(() => r()))));
    occupiers = [];
    // Restore env vars the getApiUrl tests mutate (HOME is irrelevant — the
    // homedir mock owns path resolution in this file).
    process.env = { ...originalEnv };
    removeServerPortFile();
  });

  afterAll(() => {
    vi.mocked(os.homedir).mockRestore();
    try { fs.rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
  });

  describe('isPortAvailable', () => {
    it('returns true for a free port', async () => {
      const port = await getFreePort();
      expect(await isPortAvailable(port)).toBe(true);
    });

    it('returns false for an occupied port', async () => {
      const port = await occupyEphemeral();
      expect(await isPortAvailable(port)).toBe(false);
    });

    it('returns false when listen is refused with EACCES (excluded/forbidden port)', async () => {
      const port = await getFreePort();
      const created = stubCreateServer(() => true);
      expect(await isPortAvailable(port)).toBe(false);
      expect(created).toHaveLength(1);
    });
  });

  describe('findAvailablePort', () => {
    it('returns the starting port when free', async () => {
      const port = await getFreePort();
      expect(await findAvailablePort(port)).toBe(port);
    });

    it('skips occupied ports and returns the next free one', async () => {
      // Hold an OS-assigned port, and its neighbour when that can be bound too,
      // so the probe must step over at least one occupied port. Nothing assumes
      // start + 1 (or + 2) is free: the result is only required to lie past
      // every port held here and to be bindable.
      const start = await occupyEphemeral();
      const heldNext = await tryOccupy(start + 1);
      // start may sit just below a Windows excluded block (100 wide; two
      // contiguous make 200), so probe further than the default to clear it.
      const p = await findAvailablePort(start, '127.0.0.1', SKIP_MAX_ATTEMPTS);
      expect(p).toBeGreaterThan(heldNext ? start + 1 : start);
      expect(await isPortAvailable(p)).toBe(true);
      // Only the ports held here are asserted unavailable: a port in between
      // held by another process (e.g. a sibling worker's port-0 bind) may free
      // up at any time. The strict "next" contract is pinned deterministically
      // by the EACCES case below (probed === [P, P + 1]).
      expect(await isPortAvailable(start)).toBe(false);
      if (heldNext) expect(await isPortAvailable(start + 1)).toBe(false);
    });

    it('throws when no free port is found within maxAttempts', async () => {
      const port = await occupyEphemeral();
      await expect(findAvailablePort(port, '127.0.0.1', 1)).rejects.toThrow(/No free port/);
    });

    it('skips a port refused with EACCES and returns the next candidate', async () => {
      const start = await getFreePort();
      const probed: number[] = [];
      stubCreateServer((port) => { probed.push(port); return port === start; });
      expect(await findAvailablePort(start)).toBe(start + 1);
      expect(probed).toEqual([start, start + 1]);
    });
  });

  describe('persistence', () => {
    it('round-trips port via write/read', () => {
      writeServerPortFile(45_678);
      expect(readServerPort()).toBe(45_678);
    });

    it('writes to ~/.agenfk/server-port (sandbox-scoped homedir)', () => {
      writeServerPortFile(31_415);
      const expected = path.join(sandboxHome, '.agenfk', 'server-port');
      expect(serverPortFile()).toBe(expected);
      expect(fs.readFileSync(expected, 'utf8').trim()).toBe('31415');
    });

    it('removeServerPortFile is idempotent', () => {
      removeServerPortFile();
      expect(() => removeServerPortFile()).not.toThrow();
      expect(readServerPort()).toBeNull();
    });

    it('readServerPort returns null for invalid contents', () => {
      fs.mkdirSync(path.dirname(serverPortFile()), { recursive: true });
      fs.writeFileSync(serverPortFile(), 'not-a-port');
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

    it('prefers the server-written port file over PORT/AGENFK_PORT env', () => {
      // The env vars carry the REQUESTED port; the file carries the ACTUAL bound
      // port (the server bumps off a busy requested port). The actual port must
      // win so clients reach the running server, not a port nothing listens on.
      delete process.env.AGENFK_API_URL;
      process.env.AGENFK_PORT = '4242';
      process.env.PORT = '1234';
      writeServerPortFile(5151);
      expect(getApiUrl()).toBe('http://localhost:5151');
    });

    it('still lets AGENFK_API_URL override the port file', () => {
      process.env.AGENFK_API_URL = 'http://example.com:9999';
      writeServerPortFile(5151);
      expect(getApiUrl()).toBe('http://example.com:9999');
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
