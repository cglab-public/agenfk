/**
 * CGLAB-625: a project's id lives in the git-ignored `.agenfk/local.json`, and
 * `.agenfk/project.json` - the shared settings - is optional. A project that
 * `agenfk init` set up has local.json and may have no project.json at all, so
 * the hooks that decide "is this inside a project" must recognise either file:
 * otherwise every edit in a freshly initialized project goes unguarded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const BIN = path.resolve(__dirname, '../../../../bin');
const GATEKEEPER = path.join(BIN, 'agenfk-gatekeeper.mjs');
const ENFORCER = path.join(BIN, 'agenfk-mcp-enforcer.mjs');
const ENFORCER_OPENCODE = path.join(BIN, 'agenfk-mcp-enforcer-opencode.mjs');

let home: string;
let project: string;
let file: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hooks-local-'));
  project = path.join(home, 'proj');
  file = path.join(project, 'src', 'a.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** Mark the project the way `agenfk init` now does: local.json, no project.json. */
const markLocalOnly = () => {
  fs.mkdirSync(path.join(project, '.agenfk'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agenfk', 'local.json'), JSON.stringify({ projectId: 'p1' }));
};

/** An API answering every /items query with no active card. */
function noActiveWork(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url?.startsWith('/items') ? 200 : 404, { 'content-type': 'application/json' });
      res.end(req.url?.startsWith('/items') ? '[]' : '');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('net').AddressInfo).port;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

function gatekeeper(port: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATEKEEPER], {
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENFK_API_URL: `http://127.0.0.1:${port}` },
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', () => resolve(stdout));
    child.stdin.write(JSON.stringify({ tool: 'Edit', tool_input: { file_path: file } }));
    child.stdin.end();
  });
}

const curl = 'curl -s http://localhost:3000/items';

function enforcer(): { decision: string } | null {
  const res = spawnSync(process.execPath, [ENFORCER], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: curl } }),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home, PWD: project },
  });
  const out = res.stdout.trim();
  return out ? JSON.parse(out) : null;
}

async function enforcerOpencode(): Promise<string | null> {
  try {
    const mod = await import(`${pathToFileURL(ENFORCER_OPENCODE).href}?t=${Date.now()}`);
    const hooks = await mod.default({ directory: project });
    await hooks['tool.execute.before']({ tool: 'bash', args: { command: curl } });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('the gatekeeper hook', () => {
  it('guards an edit in a project marked only by local.json', async () => {
    markLocalOnly();
    const api = await noActiveWork();
    try {
      expect(await gatekeeper(api.port)).toMatch(/"decision":\s*"block"/);
    } finally { await api.close(); }
  });

  it('still lets an edit through outside any project', async () => {
    const api = await noActiveWork();
    try {
      expect(await gatekeeper(api.port)).toBe('');
    } finally { await api.close(); }
  });
});

describe('the mcp enforcer', () => {
  it('blocks curl to the server inside a project marked only by local.json (Claude Code)', () => {
    markLocalOnly();
    expect(enforcer()?.decision).toBe('block');
  });

  it('blocks curl to the server inside a project marked only by local.json (OpenCode)', async () => {
    markLocalOnly();
    expect(await enforcerOpencode()).toMatch(/curl|3000|agenfk/i);
  });
});
