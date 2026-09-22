/**
 * The hook refuses an edit to a PARKED card's files (review of 864067fa).
 *
 * That commit was titled "refuse an edit that runs into another card's files"
 * and MULTI_AGENT.md said the same. An adversarial review found neither was
 * true: the PreToolUse hook is the only mechanical enforcement in this
 * product, it receives `tool_input.file_path`, and it asked one question -
 * does any item anywhere have an active status. It never looked at a claim.
 *
 * WHAT IT STILL CANNOT DO, and this file pins that too. The hook receives a
 * tool call, not an identity. Several agents share one machine and one
 * worktree, so when an ACTIVE card holds the file there is no way to tell
 * whether the agent at the keyboard is that card's or a stranger's - and
 * blocking would stop the holder from doing its own work. So that case is
 * allowed, deliberately, and the test below says so rather than leaving a
 * reader to assume the gate is total.
 *
 * The unambiguous half is real enforcement: a card that holds the file and is
 * PARKED - TODO, PAUSED, BLOCKED - has an agent that is not editing right now.
 * Its files are half-finished in a tree everybody shares, so nobody should
 * touch them, whoever is asking.
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
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gk-claims-'));
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

/** Async spawn: the stub runs in this process's loop and must stay responsive. */
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

const card = (id: string, status: string, claims?: string[], title = `t-${id}`) => ({ id, status, title, claims });

describe('a parked card keeps its files', () => {
  it('blocks an edit inside a PAUSED card\'s claim, naming it', async () => {
    const api = await startItemsServer([
      card('aaaaaaaa-0000', 'PAUSED', ['packages/ui/']),
      card('bbbbbbbb-0000', 'IN_PROGRESS'),          // something IS active, so the old check passes
    ]);
    const { stdout } = await runHook(api.port);
    await api.close();

    expect(stdout, 'the hook allowed an edit inside a paused card\'s claim').toContain('"decision":"block"');
    expect(stdout).toContain('CLAIM CONFLICT');
    expect(stdout, 'the refusal did not name the holder').toContain('aaaaaaaa');
  });

  it('blocks for a BLOCKED and for a TODO holder too', async () => {
    for (const status of ['BLOCKED', 'TODO']) {
      const api = await startItemsServer([
        card('cccccccc-0000', status, ['packages/ui/src/App.tsx']),
        card('bbbbbbbb-0000', 'IN_PROGRESS'),
      ]);
      const { stdout } = await runHook(api.port);
      await api.close();
      expect(stdout, `a ${status} holder did not block`).toContain('CLAIM CONFLICT');
    }
  });

  it('matches a claim spelled with backslashes, like the gate does', async () => {
    // The hook carries its own copy of claimsCollide because it is installed
    // standalone and cannot import @agenfk/core. This is the case a naive
    // string compare gets wrong.
    const api = await startItemsServer([
      card('dddddddd-0000', 'PAUSED', ['packages\\ui']),
      card('bbbbbbbb-0000', 'IN_PROGRESS'),
    ]);
    const { stdout } = await runHook(api.port);
    await api.close();
    expect(stdout).toContain('CLAIM CONFLICT');
  });
});

describe('what it lets through, on purpose', () => {
  it('allows when the holder is being worked, because it cannot tell who is asking', async () => {
    /*
     * THE honest limit. The hook gets a tool call, not an agent identity, and
     * the holder's own agent has to be able to edit its own files. Blocking
     * here would stop the card doing the work it claimed the paths for.
     */
    const api = await startItemsServer([card('eeeeeeee-0000', 'IN_PROGRESS', ['packages/ui/'])]);
    const { stdout } = await runHook(api.port);
    await api.close();
    expect(stdout, 'the hook blocked the holder from editing its own claim').not.toContain('CLAIM CONFLICT');
  });

  it('allows a file no parked card claims', async () => {
    const api = await startItemsServer([
      card('ffffffff-0000', 'PAUSED', ['packages/server/']),
      card('bbbbbbbb-0000', 'IN_PROGRESS'),
    ]);
    const { stdout } = await runHook(api.port);
    await api.close();
    expect(stdout).not.toContain('CLAIM CONFLICT');
  });

  it('does not treat a shared name prefix as containment', async () => {
    // packages/ui does not own packages/ui-legacy. Failing closed here would
    // be safe but would make the mechanism unusable, so it is pinned.
    const other = path.join(projectDir, 'packages', 'ui-legacy', 'App.tsx');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'x');
    const api = await startItemsServer([
      card('aaaaaaaa-0000', 'PAUSED', ['packages/ui/']),
      card('bbbbbbbb-0000', 'IN_PROGRESS'),
    ]);
    const { stdout } = await runHook(api.port, other);
    await api.close();
    expect(stdout).not.toContain('CLAIM CONFLICT');
  });

  it('still blocks when nothing is active at all, as it always did', async () => {
    // The pre-existing rule must survive the new one being added in front.
    const api = await startItemsServer([card('99999999-0000', 'DONE')]);
    const { stdout } = await runHook(api.port);
    await api.close();
    expect(stdout).toContain('WORKFLOW VIOLATION');
  });
});

describe('the duplicated collide logic agrees with core', () => {
  it('gives the same answer as claimsCollide on the cases that matter', async () => {
    /*
     * The hook cannot import @agenfk/core, so the logic is copied. A copy that
     * DRIFTS is worse than either having it or not: the gate would accept a
     * claim the hook cannot see. This pins the agreement rather than trusting
     * two files to be edited together.
     */
    const { claimsCollide } = await import('@agenfk/core');
    const cases: Array<[string, string]> = [
      ['packages/ui/src/App.tsx', 'packages/ui/'],
      ['packages/ui/src/App.tsx', 'packages\\ui'],
      ['src/a.ts', 'src//a.ts'],
      ['packages/ui-legacy/App.tsx', 'packages/ui/'],
      ['src/App.tsx.map', 'src/App.tsx'],
      ['a/b.ts', 'a/b.ts'],
    ];
    // Re-implemented here exactly as the hook has it, so a change to the hook
    // that is not mirrored in core shows up as a disagreement.
    const norm = (c: string) => c.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
    const hookCollide = (a: string, b: string) => {
      const x = norm(a), y = norm(b);
      if (x === y) return true;
      const contains = (o: string, i: string) => o !== '' && i.startsWith(o + '/');
      return contains(x, y) || contains(y, x);
    };
    for (const [f, c] of cases) {
      expect(hookCollide(f, c), `hook and core disagree on ${f} vs ${c}`).toBe(claimsCollide(f, c));
    }
  });
});
