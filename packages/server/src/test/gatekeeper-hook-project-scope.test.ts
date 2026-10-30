/**
 * The gatekeeper PreToolUse hook must only count active tasks of the edited
 * file's own project.
 *
 * It used to ask for /items across every project, so an active task in repo A
 * authorized edits in repo B, which had no task at all. The hooks are installed
 * globally, so one open task anywhere switched enforcement off everywhere — while
 * the CLI's `agenfk gatekeeper`, run from B, already refused the same edit.
 *
 * The hook is copied to ~/.agenfk/bin and cannot import @agenfk/core, so it
 * restates core's resolveProjectIdentity (local.json, else a legacy projectId in
 * project.json, else the main checkout's id for a linked worktree). The parity
 * block below keeps the two from drifting apart.
 *
 * The stub returns every project's items and IGNORES ?projectId=, so these tests
 * also prove the hook filters on its own side (it may outlive the server it was
 * installed with).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveProjectIdentity } from '@agenfk/core';
import { makeUnreadable, readsThroughDenials } from './helpers/unreadableDir';
// @ts-ignore — .mjs hook has no .d.ts; findAgenFKProject is a plain JS export.
import { findAgenFKProject } from '../../../../bin/agenfk-gatekeeper.mjs';

const HOOK = path.resolve(__dirname, '../../../../bin/agenfk-gatekeeper.mjs');

// realpath: on macOS the tmpdir is a /var -> /private/var symlink, and the roots
// compared below must be spelled the same way on both sides.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gk-scope-')));

/** A project dir with the given .agenfk files; returns a source file inside it. */
const makeProject = (name: string, files: { local?: object; shared?: object }) => {
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  if (files.local) fs.writeFileSync(path.join(dir, '.agenfk', 'local.json'), JSON.stringify(files.local));
  if (files.shared) fs.writeFileSync(path.join(dir, '.agenfk', 'project.json'), JSON.stringify(files.shared));
  return path.join(dir, 'src', 'app.ts');
};

// What `agenfk init` writes today: the id in the git-ignored local.json.
const fileInA = makeProject('repo-a', { local: { projectId: 'proj-a' } });
const fileInB = makeProject('repo-b', { local: { projectId: 'proj-b' }, shared: { verifyCommand: 'npm test' } });
// A repository from before CGLAB-625, its id still in the shared project.json.
const fileInLegacy = makeProject('repo-legacy', { shared: { projectId: 'proj-legacy' } });
// A fresh clone this machine has not linked: a project, but no id.
const fileInUnlinked = makeProject('repo-unlinked', { shared: { verifyCommand: 'npm test' } });
const fileOutside = path.join(home, 'not-a-project', 'x.ts');

// A linked worktree of repo-a. local.json is git-ignored, so it never travels
// into one: the worktree has only the shared project.json, and its id comes
// from the main checkout. Built from files, as git lays them out.
const worktreeTop = path.join(home, 'repo-a-feature');
const fileInWorktree = path.join(worktreeTop, 'src', 'app.ts');
fs.mkdirSync(path.join(home, 'repo-a', '.git', 'worktrees', 'feature'), { recursive: true });
fs.writeFileSync(path.join(home, 'repo-a', '.git', 'config'), '[core]\n\tbare = false\n');
fs.mkdirSync(path.join(worktreeTop, '.agenfk'), { recursive: true });
fs.mkdirSync(path.join(worktreeTop, 'src'), { recursive: true });
fs.writeFileSync(path.join(worktreeTop, '.git'), `gitdir: ${path.join(home, 'repo-a', '.git', 'worktrees', 'feature')}\n`);
fs.writeFileSync(path.join(worktreeTop, '.agenfk', 'project.json'), JSON.stringify({ verifyCommand: 'npm test' }));

// A linked worktree of a checkout this machine has not linked either: no id anywhere.
const unlinkedMain = path.join(home, 'repo-unlinked-main');
const unlinkedWorktree = path.join(home, 'repo-unlinked-feature');
const fileInUnlinkedWorktree = path.join(unlinkedWorktree, 'src', 'app.ts');
fs.mkdirSync(path.join(unlinkedMain, '.agenfk'), { recursive: true });
fs.writeFileSync(path.join(unlinkedMain, '.agenfk', 'project.json'), JSON.stringify({ verifyCommand: 'npm test' }));
fs.mkdirSync(path.join(unlinkedMain, '.git', 'worktrees', 'feature'), { recursive: true });
fs.writeFileSync(path.join(unlinkedMain, '.git', 'config'), '[core]\n\tbare = false\n');
fs.mkdirSync(path.join(unlinkedWorktree, '.agenfk'), { recursive: true });
fs.mkdirSync(path.join(unlinkedWorktree, 'src'), { recursive: true });
fs.writeFileSync(path.join(unlinkedWorktree, '.git'), `gitdir: ${path.join(unlinkedMain, '.git', 'worktrees', 'feature')}\n`);
fs.writeFileSync(path.join(unlinkedWorktree, '.agenfk', 'project.json'), JSON.stringify({ verifyCommand: 'npm test' }));

// A linked project D with an unusable local.json in a subdirectory. Core skips a
// marker it cannot read and resolves D; the hook must too, not stop at the
// subdirectory with no id. The oversized and unreadable markers name a VALID id,
// so reading them anyway would also land on the wrong project.
makeProject('repo-d', { local: { projectId: 'proj-d' } });
const brokenMarker = (sub: string, write: (localJson: string) => void) => {
  const dir = path.join(home, 'repo-d', sub);
  fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
  write(path.join(dir, '.agenfk', 'local.json'));
  return path.join(dir, 'app.ts');
};
const fileUnderDirMarker = brokenMarker('as-directory', (f) => fs.mkdirSync(f));
const fileUnderBigMarker = brokenMarker('oversized', (f) =>
  fs.writeFileSync(f, JSON.stringify({ projectId: 'proj-big', pad: 'x'.repeat(64 * 1024) })));
const fileUnderLockedMarker = brokenMarker('unreadable', (f) => fs.writeFileSync(f, JSON.stringify({ projectId: 'proj-locked' })));
const lockedMarker = path.join(home, 'repo-d', 'unreadable', '.agenfk', 'local.json');

let items: unknown[] = [];
let requested: string[] = [];
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requested.push(req.url ?? '');
    if (req.url?.startsWith('/items')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(items));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as import('net').AddressInfo).port;
  fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agenfk', 'server-port'), String(port));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => { requested = []; });

// Async spawn (NOT spawnSync): the stub runs in this process's event loop.
// The payload is what Claude Code sends before an Edit. Resolves with the block
// reason, or null when the edit is let through.
function hookReason(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENFK_API_URL: '' },
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', () => resolve(stdout.includes('"decision":"block"') ? JSON.parse(stdout).reason : null));
    child.stdin.write(JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: filePath },
    }));
    child.stdin.end();
  });
}
const edit = async (filePath: string) => ((await hookReason(filePath)) === null ? 'allowed' : 'blocked');

const activeInA = [
  { id: 't1', projectId: 'proj-a', status: 'IN_PROGRESS' },
  { id: 't2', projectId: 'proj-b', status: 'DONE' },
];

describe('gatekeeper hook — project scope', () => {
  it('blocks an edit in B while the only active task belongs to A', async () => {
    items = activeInA;
    expect(await edit(fileInB)).toBe('blocked');
  });

  it('still allows the edit in A, where the active task lives', async () => {
    items = activeInA;
    expect(await edit(fileInA)).toBe('allowed');
  });

  it('works the other way round too', async () => {
    items = [{ id: 't3', projectId: 'proj-b', status: 'REVIEW' }];
    expect(await edit(fileInA)).toBe('blocked');
    expect(await edit(fileInB)).toBe('allowed');
  });

  it("asks the server for the edited file's project only", async () => {
    items = activeInA;
    await edit(fileInB);
    expect(requested).toEqual(['/items?projectId=proj-b']);
  });

  it("lets a linked worktree work under its main checkout's task, and only that one", async () => {
    items = activeInA;
    expect(await edit(fileInWorktree)).toBe('allowed');
    expect(requested).toEqual(['/items?projectId=proj-a']);
    items = [{ id: 't4', projectId: 'proj-b', status: 'IN_PROGRESS' }];
    expect(await edit(fileInWorktree)).toBe('blocked');
  });

  it('scopes a legacy project by the id in its project.json', async () => {
    items = activeInA;
    expect(await edit(fileInLegacy)).toBe('blocked');
    items = [{ id: 't5', projectId: 'proj-legacy', status: 'IN_PROGRESS' }];
    expect(await edit(fileInLegacy)).toBe('allowed');
  });

  it('blocks a project this machine has not linked, without asking the server, and says how to link it', async () => {
    // A task elsewhere used to authorize this: with no id, every project's items counted.
    items = activeInA;
    const reason = await hookReason(fileInUnlinked);
    expect(reason).toMatch(/^AgenFK WORKFLOW VIOLATION: /);
    expect(reason).toContain(`${path.join(home, 'repo-unlinked')} is an AgEnFK project not linked on this machine`);
    expect(reason).toContain('agenfk init --project <id>');
    expect(reason).toContain('agenfk list-projects');
    expect(requested).toEqual([]);
  });

  it('blocks a worktree of a checkout this machine has not linked, pointing at the main checkout', async () => {
    items = activeInA;
    const reason = await hookReason(fileInUnlinkedWorktree);
    expect(reason).toContain(`this is a git worktree of ${unlinkedMain}, which is not linked`);
    expect(reason).toContain(`cd ${unlinkedMain} && agenfk init --project <id>`);
    expect(requested).toEqual([]);
  });

  it("skips an unusable marker in a subdirectory and scopes to the real project above it", async () => {
    for (const file of [fileUnderDirMarker, fileUnderBigMarker]) {
      items = activeInA;
      requested = [];
      expect(await edit(file), file).toBe('blocked');
      expect(requested).toEqual(['/items?projectId=proj-d']);
      items = [{ id: 't6', projectId: 'proj-d', status: 'IN_PROGRESS' }];
      expect(await edit(file), file).toBe('allowed');
    }
  });

  it.skipIf(readsThroughDenials())('skips an unreadable marker too', async () => {
    const restore = makeUnreadable(lockedMarker);
    try {
      items = [{ id: 't7', projectId: 'proj-d', status: 'IN_PROGRESS' }];
      expect(await edit(fileUnderLockedMarker)).toBe('allowed');
      expect(requested).toEqual(['/items?projectId=proj-d']);
    } finally {
      restore();
    }
  });

  it('does not enforce, or even ask, outside an AgEnFK project', async () => {
    items = [];
    expect(await edit(fileOutside)).toBe('allowed');
    expect(requested).toEqual([]);
  });
});

describe("the hook's project resolution matches @agenfk/core", () => {
  it.each([
    ['local.json', fileInA],
    ['local.json beside a shared project.json', fileInB],
    ['legacy projectId in project.json', fileInLegacy],
    ['unlinked project', fileInUnlinked],
    ['linked worktree', fileInWorktree],
    ['worktree of an unlinked checkout', fileInUnlinkedWorktree],
    ['a directory named local.json in a subdirectory', fileUnderDirMarker],
    ['an oversized local.json in a subdirectory', fileUnderBigMarker],
    ['outside any project', fileOutside],
  ])('%s', (_label, file) => {
    const core = resolveProjectIdentity(path.dirname(file));
    const hook = findAgenFKProject(file);
    expect(hook && { root: hook.root, projectId: hook.projectId })
      .toEqual(core && { root: core.root, projectId: core.projectId });
  });

  it.skipIf(readsThroughDenials())('an unreadable local.json in a subdirectory', () => {
    const restore = makeUnreadable(lockedMarker);
    try {
      const core = resolveProjectIdentity(path.dirname(fileUnderLockedMarker));
      expect(findAgenFKProject(fileUnderLockedMarker)).toEqual({ root: core!.root, projectId: core!.projectId });
      expect(core).toMatchObject({ root: path.join(home, 'repo-d'), projectId: 'proj-d' });
    } finally {
      restore();
    }
  });

  it('still treats an unparsable local.json as a managed project, as core does', () => {
    const file = makeProject('repo-broken', {});
    fs.writeFileSync(path.join(home, 'repo-broken', '.agenfk', 'local.json'), '{ not json');
    // Readable, so it marks the project; it names no id, so the project is unlinked.
    expect(findAgenFKProject(file)).toEqual({ root: path.join(home, 'repo-broken'), projectId: null });
    expect(resolveProjectIdentity(path.dirname(file))).toMatchObject({ root: path.join(home, 'repo-broken'), projectId: null });
  });
});
