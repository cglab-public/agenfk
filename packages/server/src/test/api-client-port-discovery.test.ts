/**
 * Behaviour test for the MCP server's API client port discovery.
 *
 * The AgEnFK API server binds to whatever port is free (bumping off 3000 when it
 * is busy) and records the ACTUAL port in ~/.agenfk/server-port. The MCP server
 * is a long-lived stdio process, so its axios client must resolve that port on
 * EVERY request — not cache it once at startup. Otherwise it keeps talking to a
 * stale port after the API server (re)starts on a different one.
 *
 * These tests spin up real HTTP servers on ephemeral ports and assert the client
 * routes to whichever port the file currently names — including after the file
 * changes mid-session.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Sandbox homedir via a CALL-TIME mock of os.homedir() (item 9c297075), armed
// BEFORE importing the API client — runner-independent (an env override only
// works while libuv follows the JS env — not under Stryker's threads pool).
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-apiclient-'));
vi.mocked(os.homedir).mockReturnValue(sandboxHome);
delete process.env.AGENFK_API_URL;
delete process.env.AGENFK_PORT;
delete process.env.PORT;

// Import after the homedir mock is armed so getApiUrl reads the sandbox port file.
const { createApiClient } = await import('../apiClient.js');

const portFile = path.join(sandboxHome, '.agenfk', 'server-port');
function writePort(port: number) {
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(portFile, String(port), 'utf8');
}

/** Start an HTTP server on an ephemeral port that echoes a fixed id at /whoami. */
function startServer(id: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id }));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('net').AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('MCP api client port discovery', () => {
  let serverA: { port: number; close: () => Promise<void> };
  let serverB: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    serverA = await startServer('A');
    serverB = await startServer('B');
  });

  afterAll(async () => {
    await serverA.close();
    await serverB.close();
    vi.mocked(os.homedir).mockRestore();
    try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    delete process.env.AGENFK_API_URL;
    delete process.env.AGENFK_PORT;
    delete process.env.PORT;
  });

  it('routes requests to the port named by the server-port file', async () => {
    writePort(serverA.port);
    const api = createApiClient();
    const { data } = await api.get('/whoami');
    expect(data.id).toBe('A');
  });

  it('re-resolves the port on every request (no stale caching)', async () => {
    writePort(serverA.port);
    const api = createApiClient();
    expect((await api.get('/whoami')).data.id).toBe('A');

    // The API server "restarts" on a different port mid-session.
    writePort(serverB.port);
    expect((await api.get('/whoami')).data.id).toBe('B');
  });
});
