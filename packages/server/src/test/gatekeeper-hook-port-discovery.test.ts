/**
 * Behaviour test for the gatekeeper PreToolUse hook's port discovery.
 *
 * The gatekeeper hook (bin/agenfk-gatekeeper.mjs) blocks Edit/Write when no task
 * is in an active step. It learns that by asking the API server for /items. The
 * server binds to whatever port is free (bumping off 3000 when busy) and records
 * the ACTUAL port in ~/.agenfk/server-port. The hook must read that file — if it
 * hardcodes :3000 it reaches nothing, fails open (graceful skip), and silently
 * stops enforcing.
 *
 * We start a real API stub on an ephemeral port, point the sandbox port file at
 * it, and assert the hook's decision reflects what THAT server returns — proving
 * it discovered the right port.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// @ts-ignore — .mjs hook has no .d.ts; resolveApiUrl is a plain JS export.
import { resolveApiUrl } from '../../../../bin/agenfk-gatekeeper.mjs';

const HOOK = path.resolve(__dirname, '../../../../bin/agenfk-gatekeeper.mjs');

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gk-hook-'));
// A fake AgEnFK project so the hook decides the edited file is "managed".
const projectDir = path.join(sandboxHome, 'proj');
const editedFile = path.join(projectDir, 'src', 'foo.ts');
const portFile = path.join(sandboxHome, '.agenfk', 'server-port');

function writePort(port: number) {
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(portFile, String(port), 'utf8');
}

/** API stub that returns a fixed /items payload on an ephemeral port. */
function startItemsServer(items: unknown[]): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/items')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(items));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('net').AddressInfo).port;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

// Async spawn (NOT spawnSync): the API stub runs in THIS process's event loop,
// so a synchronous spawn would block it and the stub could never respond.
function runHook(): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        HOME: sandboxHome,
        USERPROFILE: sandboxHome,
        AGENFK_API_URL: '', // force file-based discovery
      },
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', (status) => resolve({ status, stdout }));
    child.stdin.write(JSON.stringify({ tool: 'Edit', tool_input: { file_path: editedFile } }));
    child.stdin.end();
  });
}

describe('gatekeeper hook resolveApiUrl precedence', () => {
  let home: string;

  beforeAll(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gk-resolve-')); });
  afterAll(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  const writeFile = (contents: string) => {
    fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agenfk', 'server-port'), contents);
  };
  const rmFile = () => { try { fs.rmSync(path.join(home, '.agenfk', 'server-port')); } catch { /* ignore */ } };

  it('prefers AGENFK_API_URL over everything', () => {
    writeFile('5151');
    expect(resolveApiUrl({ AGENFK_API_URL: 'http://example.com:9999', AGENFK_PORT: '4242' }, home))
      .toBe('http://example.com:9999');
  });

  it('prefers the server-port file over AGENFK_PORT/PORT env', () => {
    writeFile('5151');
    expect(resolveApiUrl({ AGENFK_PORT: '4242', PORT: '1234' }, home)).toBe('http://127.0.0.1:5151');
  });

  it('falls back to AGENFK_PORT/PORT env when no file exists', () => {
    rmFile();
    expect(resolveApiUrl({ AGENFK_PORT: '4242' }, home)).toBe('http://127.0.0.1:4242');
    expect(resolveApiUrl({ PORT: '1234' }, home)).toBe('http://127.0.0.1:1234');
  });

  it('ignores a garbage/out-of-range port file and falls through', () => {
    writeFile('not-a-port');
    expect(resolveApiUrl({ AGENFK_PORT: '4242' }, home)).toBe('http://127.0.0.1:4242');
    writeFile('70000'); // out of range
    expect(resolveApiUrl({}, home)).toBe('http://127.0.0.1:3000');
  });

  it('defaults to :3000 when nothing is set', () => {
    rmFile();
    expect(resolveApiUrl({}, home)).toBe('http://127.0.0.1:3000');
  });
});

describe('gatekeeper hook port discovery', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(projectDir, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.agenfk', 'project.json'), JSON.stringify({ id: 'p1' }));
    fs.mkdirSync(path.dirname(editedFile), { recursive: true });
  });

  afterAll(() => {
    try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('BLOCKS an edit when the discovered server reports no active task', async () => {
    const server = await startItemsServer([]); // no items → nothing active
    writePort(server.port);
    try {
      const { stdout } = await runHook();
      expect(stdout).toContain('block');
    } finally {
      await server.close();
    }
  });

  it('ALLOWS an edit when the discovered server reports an active task', async () => {
    const server = await startItemsServer([{ id: 'x', status: 'IN_PROGRESS' }]);
    writePort(server.port);
    try {
      const { stdout } = await runHook();
      expect(stdout).not.toContain('block');
    } finally {
      await server.close();
    }
  });
});
