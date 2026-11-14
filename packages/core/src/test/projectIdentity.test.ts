/**
 * @vitest-environment node
 *
 * CGLAB-625: which project a folder belongs to.
 *
 * `projectId` is a row id in ONE machine's database, so it lives in the
 * git-ignored `.agenfk/local.json`. `.agenfk/project.json` carries the
 * repository's shared settings and is committed. A repository from before the
 * split still has the id in project.json: it keeps working, reported as legacy
 * so callers can say how to move it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveProjectIdentity, readLocalProjectFile, LOCAL_PROJECT_FILE } from '../projectIdentity';

let base: string;

const mark = (dir: string, files: { local?: unknown; project?: unknown }): string => {
  const agenfk = path.join(dir, '.agenfk');
  fs.mkdirSync(agenfk, { recursive: true });
  if (files.local !== undefined) fs.writeFileSync(path.join(agenfk, 'local.json'), typeof files.local === 'string' ? files.local : JSON.stringify(files.local));
  if (files.project !== undefined) fs.writeFileSync(path.join(agenfk, 'project.json'), JSON.stringify(files.project));
  return dir;
};

beforeEach(() => { base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agenfk-identity-')); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('resolveProjectIdentity', () => {
  it('names the machine-only file local.json', () => {
    expect(LOCAL_PROJECT_FILE).toBe('local.json');
  });

  it('takes the id from local.json, over any id project.json still carries', () => {
    mark(base, { local: { projectId: 'from-local' }, project: { projectId: 'from-project', verifyCommand: 'npm test' } });
    expect(resolveProjectIdentity(base)).toEqual({ root: base, projectId: 'from-local', source: 'local' });
  });

  it('reads local.json when the repository declares no settings at all', () => {
    mark(base, { local: { projectId: 'only-local' } });
    expect(resolveProjectIdentity(base)).toEqual({ root: base, projectId: 'only-local', source: 'local' });
  });

  it('falls back to a projectId in project.json, reported as legacy', () => {
    mark(base, { project: { projectId: 'legacy-id' } });
    expect(resolveProjectIdentity(base)).toEqual({ root: base, projectId: 'legacy-id', source: 'legacy' });
  });

  it('finds the project of a fresh clone - settings, no id yet - and says it has no id', () => {
    mark(base, { project: { verifyCommand: 'npm test' } });
    expect(resolveProjectIdentity(base)).toEqual({ root: base, projectId: null, source: null });
  });

  it('walks up from a subdirectory', () => {
    mark(base, { local: { projectId: 'p1' } });
    const deep = path.join(base, 'packages', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    expect(resolveProjectIdentity(deep)).toEqual({ root: base, projectId: 'p1', source: 'local' });
  });

  it('stops at the nearest project, not the outermost', () => {
    mark(base, { local: { projectId: 'outer' } });
    const inner = mark(path.join(base, 'services', 'api'), { local: { projectId: 'inner' } });
    expect(resolveProjectIdentity(inner)).toEqual({ root: inner, projectId: 'inner', source: 'local' });
  });

  it('passes over an .agenfk directory that holds neither file', () => {
    mark(base, { local: { projectId: 'real' } });
    const stray = path.join(base, 'sub');
    fs.mkdirSync(path.join(stray, '.agenfk'), { recursive: true });
    expect(resolveProjectIdentity(stray)).toEqual({ root: base, projectId: 'real', source: 'local' });
  });

  it('answers null outside any project', () => {
    expect(resolveProjectIdentity(base)).toBeNull();
  });

  it('falls back to the legacy id when local.json cannot be read, rather than losing the project', () => {
    mark(base, { local: '{ not json', project: { projectId: 'legacy-id' } });
    expect(resolveProjectIdentity(base)).toEqual({ root: base, projectId: 'legacy-id', source: 'legacy' });
  });

  it('ignores a local.json that is not a regular file', () => {
    // A FIFO would block a synchronous read for ever.
    mark(base, { project: { projectId: 'legacy-id' } });
    fs.mkdirSync(path.join(base, '.agenfk', 'local.json'));
    expect(resolveProjectIdentity(base)).toEqual({ root: base, projectId: 'legacy-id', source: 'legacy' });
  });
});

describe('resolveProjectIdentity in a linked worktree (CGLAB-625 review)', () => {
  // local.json is git-ignored, so a worktree never has one: the id is the
  // main checkout's, which is the same project on the same machine.
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const repoWithWorktree = (commitSettings: boolean) => {
    const main = path.join(base, 'main');
    fs.mkdirSync(main, { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.email', 't@t');
    git(main, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(main, '.gitignore'), '.agenfk/local.json\n');
    if (commitSettings) mark(main, { project: { verifyCommand: 'npm test' } });
    git(main, 'add', '-A');
    git(main, 'commit', '-qm', 'one');
    mark(main, { local: { projectId: 'p-main' } });
    const wt = path.join(base, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'card', wt);
    return { main, wt };
  };

  it('takes the main checkout\'s id when the worktree carries the committed settings only', () => {
    const { wt } = repoWithWorktree(true);
    expect(fs.existsSync(path.join(wt, '.agenfk', 'local.json'))).toBe(false);
    expect(resolveProjectIdentity(wt)).toEqual({ root: wt, projectId: 'p-main', source: 'local' });
  });

  it('takes the main checkout\'s id when the worktree has no .agenfk at all', () => {
    const { wt } = repoWithWorktree(false);
    const deep = path.join(wt, 'src');
    fs.mkdirSync(deep, { recursive: true });
    expect(resolveProjectIdentity(deep)).toEqual({ root: wt, projectId: 'p-main', source: 'local' });
  });

  it('prefers the main checkout over a project ENCLOSING the worktree', () => {
    // A worktree cut inside another project's folder: that folder's id is not this checkout's.
    const { main } = repoWithWorktree(false);
    const holder = path.join(base, 'holder');
    mark(holder, { local: { projectId: 'p-enclosing' } });
    const wt = path.join(holder, 'wt2');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'card2', wt], { cwd: main, stdio: 'pipe' });
    expect(resolveProjectIdentity(wt)).toEqual({ root: wt, projectId: 'p-main', source: 'local' });
  });

  it('keeps a worktree\'s own local.json when it has one', () => {
    const { wt } = repoWithWorktree(true);
    mark(wt, { local: { projectId: 'p-wt' } });
    expect(resolveProjectIdentity(wt)?.projectId).toBe('p-wt');
  });
});

describe('readLocalProjectFile', () => {
  it('reads the id, trimmed', () => {
    expect(readLocalProjectFile(JSON.stringify({ projectId: '  p1 ' }))).toBe('p1');
  });

  it('answers null for anything that names no id, never throwing', () => {
    expect(readLocalProjectFile('{ not json')).toBeNull();
    expect(readLocalProjectFile('[]')).toBeNull();
    expect(readLocalProjectFile(JSON.stringify({ projectId: '' }))).toBeNull();
    expect(readLocalProjectFile(JSON.stringify({ projectId: 7 }))).toBeNull();
  });
});
