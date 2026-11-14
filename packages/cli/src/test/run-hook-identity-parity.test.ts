/**
 * @vitest-environment node
 *
 * CGLAB-625 review: the run hook is a standalone script, so it carries its own
 * copy of core's project-id resolution. The two must answer alike, or a run is
 * attributed to one project while the CLI names another.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { resolveProjectIdentity } from '@agenfk/core';
// @ts-ignore - plain .mjs module
import { projectIdFromCwd } from '../../../../bin/agenfk-run-hook.mjs';

let base: string;
beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-parity-'))); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

const put = (dir: string, name: string, body: string | null) => {
  fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
  const f = path.join(dir, '.agenfk', name);
  if (body === null) fs.mkdirSync(f); else fs.writeFileSync(f, body);
};

const cases: Array<[string, (root: string) => string]> = [
  ['local.json', (r) => { put(r, 'local.json', '{"projectId":"p-local"}'); return r; }],
  ['legacy id', (r) => { put(r, 'project.json', '{"projectId":"p-legacy"}'); return r; }],
  ['local over legacy', (r) => { put(r, 'project.json', '{"projectId":"p-legacy"}'); put(r, 'local.json', '{"projectId":"p-local"}'); return r; }],
  ['unlinked clone inside a project', (r) => { put(r, 'local.json', '{"projectId":"outer"}'); const c = path.join(r, 'c'); put(c, 'project.json', '{"flow":"x"}'); return c; }],
  ['stray .agenfk passed over', (r) => { put(r, 'local.json', '{"projectId":"real"}'); const s = path.join(r, 's'); fs.mkdirSync(path.join(s, '.agenfk'), { recursive: true }); return s; }],
  ['local.json that is a directory', (r) => { put(r, 'project.json', '{"projectId":"p-legacy"}'); put(r, 'local.json', null); return r; }],
  ['unreadable local.json', (r) => { put(r, 'project.json', '{"projectId":"p-legacy"}'); put(r, 'local.json', '{ nope'); return r; }],
  ['oversized project.json above a project', (r) => { put(r, 'local.json', '{"projectId":"outer"}'); const c = path.join(r, 'c'); put(c, 'project.json', ' '.repeat(70 * 1024)); return c; }],
  ['nothing', (r) => r],
  ['worktree of a linked checkout', (r) => {
    const main = path.join(r, 'main');
    fs.mkdirSync(main);
    const g = (...a: string[]) => execFileSync('git', a, { cwd: main, stdio: 'pipe' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
    fs.writeFileSync(path.join(main, 'f'), 'x'); g('add', '-A'); g('commit', '-qm', 'one');
    put(main, 'local.json', '{"projectId":"p-main"}');
    const wt = path.join(r, 'wt'); g('worktree', 'add', '-q', '-b', 'card', wt);
    return wt;
  }],
];

describe('run hook and core resolve the same project id', () => {
  it.each(cases)('%s', (_name, setup) => {
    const cwd = setup(base);
    expect(projectIdFromCwd(cwd)).toBe(resolveProjectIdentity(cwd)?.projectId ?? null);
  });
});
