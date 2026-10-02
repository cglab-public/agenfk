/**
 * @file 26c059f6 — the PreToolUse hook no longer refuses an edit over claims.
 *
 * It blocked an edit inside a parked card's claimed paths (CLAIM CONFLICT).
 * With claims removed, the hook asks only what it asked before them: is there
 * a card to work under. A claim stored on an old card means nothing to it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOOK = path.resolve(__dirname, '../../../../bin/agenfk-gatekeeper.mjs');

let sandboxHome: string;
let projectDir: string;
let editedFile: string;

beforeAll(() => {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gk-noclaims-'));
  projectDir = path.join(sandboxHome, 'proj');
  editedFile = path.join(projectDir, 'packages', 'ui', 'src', 'App.tsx');
  fs.mkdirSync(path.join(projectDir, '.agenfk'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.agenfk', 'project.json'), '{"projectId":"p1"}');
  fs.mkdirSync(path.dirname(editedFile), { recursive: true });
  fs.writeFileSync(editedFile, 'x');
});
afterAll(() => { try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ } });

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

function runHook(port: number, file = editedFile): Promise<{ stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome, AGENFK_API_URL: `http://127.0.0.1:${port}` },
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', () => resolve({ stdout }));
    child.stdin.write(JSON.stringify({ tool: 'Edit', tool_input: { file_path: file } }));
    child.stdin.end();
  });
}

const card = (id: string, status: string, claims?: string[]) => ({ id, status, title: `t-${id}`, claims });

describe('an old claim on a parked card', () => {
  it('no longer blocks an edit inside it', async () => {
    for (const status of ['PAUSED', 'BLOCKED', 'TODO']) {
      const api = await startItemsServer([
        card('aaaaaaaa-0000', status, ['packages/ui/']),
        card('bbbbbbbb-0000', 'IN_PROGRESS'),
      ]);
      const { stdout } = await runHook(api.port);
      await api.close();
      expect(stdout, `a ${status} card's old claim still blocked the edit`).not.toContain('"decision":"block"');
      expect(stdout).not.toContain('CLAIM CONFLICT');
    }
  });
});
