/**
 * @file GH-392 — the no-nonfunctional-comments check in the engine: it reads
 * the lines the step added (since the step's entry commit, plus untracked
 * files), names each comment with no function by file:line, names the files
 * whose type it has no rules for, and blocks or warns as the flow sets it.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveStepChecks } from '@agenfk/core';
import { EVALUATORS, evaluateChecks, type EngineContext } from '../checkEngine';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

import { card, flow, item, makeRepo, project, refused, s, useEngineServer, validate, write } from './helpers/engineTests';

useEngineServer('no-nonfunctional-comments-test-db.sqlite');

const ID = 'no-nonfunctional-comments';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const git = (dir: string) => (args: string[], opts?: { maxBuffer?: number }) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', ...(opts?.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}) });
const put = (dir: string, f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };

/** A repo whose entry commit holds `files`; returns it and the entry head. */
function repo(files: Record<string, string>): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gh392-'));
  dirs.push(dir);
  const g = git(dir);
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  for (const [f, t] of Object.entries(files)) put(dir, f, t);
  g(['add', '.']);
  g(['commit', '-qm', 'entry']);
  return { dir, head: g(['rev-parse', 'HEAD']).trim() };
}

const ctx = (dir: string | null, entryHead: string | null, over: Partial<EngineContext> = {}): EngineContext => ({
  root: dir, git: dir ? git(dir) : () => '', item: { id: 'A', type: 'TASK' }, cardBranch: null, cardKeys: [], testPaths: [], ignoredPaths: [],
  deferToCommand: [], children: [], capture: null, entry: null, entryHead, records: {}, ...over,
} as EngineContext);

const judge = (c: EngineContext) => EVALUATORS[ID](c, {});

describe('the evaluator', () => {
  it('passes when the step added no comment', () => {
    const { dir, head } = repo({ 'src/a.ts': '// an old note\nexport const a = 1;\n' });
    put(dir, 'src/a.ts', '// an old note\nexport const a = 1;\nexport const b = 2;\n');
    const r = judge(ctx(dir, head));
    expect(r.outcome).toBe('pass');
  });

  it('fails naming each added comment by file:line, never an existing one', () => {
    const { dir, head } = repo({ 'src/a.ts': '// an old note\nexport const a = 1;\n' });
    put(dir, 'src/a.ts', '// an old note\nexport const a = 1;\n// now add b\nexport const b = 2; // two\n');
    const r = judge(ctx(dir, head));
    expect(r.outcome).toBe('fail');
    expect(r.detail).toContain('src/a.ts:3');
    expect(r.detail).toContain('// now add b');
    expect(r.detail).toContain('src/a.ts:4');
    expect(r.detail).not.toContain('src/a.ts:1');
    expect(r.detail).not.toContain('an old note');
  });

  it('reads committed work since the entry, staged work and untracked files', () => {
    const { dir, head } = repo({ 'a.py': 'x = 1\n' });
    const g = git(dir);
    put(dir, 'a.py', 'x = 1\n# committed note\n');
    g(['commit', '-qam', 'more']);
    put(dir, 'b.sh', '#!/bin/sh\n# staged note\n');
    g(['add', 'b.sh']);
    put(dir, 'c.go', 'package c\n// untracked note\nfunc f() {}\n');
    const r = judge(ctx(dir, head));
    expect(r.outcome).toBe('fail');
    for (const at of ['a.py:2', 'b.sh:2', 'c.go:2']) expect(r.detail).toContain(at);
  });

  it('does not flag the existing comments of a moved file', () => {
    const body = Array.from({ length: 20 }, (_, i) => `// line ${i} of an old explanation\nexport const v${i} = ${i};`).join('\n') + '\n';
    const { dir, head } = repo({ 'src/old.ts': body });
    git(dir)(['mv', 'src/old.ts', 'src/new.ts']);
    expect(judge(ctx(dir, head)).outcome).toBe('pass');
  });

  it('does not flag an existing comment moved within its file, or reindented', () => {
    const { dir, head } = repo({
      'm.ts': '// first note\nexport function a() {\n  // inner a\n  return 1;\n}\n\nexport function b() {\n  // inner b\n  return 2;\n}\n',
      'r.py': 'def f():\n    # old note\n    return 1\n',
    });
    put(dir, 'm.ts', '// first note\nexport function b() {\n  // inner b\n  return 2;\n}\n\nexport function a() {\n  // inner a\n  return 1;\n}\n');
    put(dir, 'r.py', 'def f():\n    if True:\n        # old note\n        return 1\n');
    expect(judge(ctx(dir, head))).toMatchObject({ outcome: 'pass' });
  });

  it('does not flag a comment moved out of a deleted file into a new one, and still flags a new comment there', () => {
    const { dir, head } = repo({ 'old.go': 'package x\n\n// helper explains itself.\nfunc helper() {}\n' });
    git(dir)(['rm', '-q', 'old.go']);
    put(dir, 'new.go', 'package x\n\n// helper explains itself.\nfunc helper() {}\n\n// another note\nfunc other() {}\n');
    const r = judge(ctx(dir, head));
    expect(r.outcome).toBe('fail');
    expect(r.detail).toContain('new.go:6');
    expect(r.detail).not.toContain('new.go:3');
  });

  it('reads a step that adds hundreds of files without running out of git output buffer', () => {
    const { dir, head } = repo({ 'x.ts': 'export {};\n' });
    const body = Array.from({ length: 80 }, (_, k) => `export const v${k} = "// not a comment ${k} padding padding padding";`).join('\n');
    for (let i = 0; i < 600; i++) put(dir, `big/f${i}.ts`, `${i === 599 ? '// the one note\n' : ''}${body}\n`);
    git(dir)(['add', 'big']);
    git(dir)(['commit', '-qm', 'big']);
    const r = judge(ctx(dir, head));
    expect(r.outcome, r.detail).toBe('fail');
    expect(r.detail).toContain('big/f599.ts:1');
  });

  it('reads a step that modifies hundreds of files without running out of git output buffer', () => {
    const body = Array.from({ length: 80 }, (_, k) => `export const v${k} = "padding padding padding padding ${k}";`).join('\n') + '\n';
    const files: Record<string, string> = {};
    for (let i = 0; i < 400; i++) files[`big/f${i}.ts`] = body;
    const { dir, head } = repo(files);
    for (let i = 0; i < 400; i++) put(dir, `big/f${i}.ts`, body.replace(/padding/g, 'changed') + (i === 7 ? '// the one note\n' : ''));
    const r = judge(ctx(dir, head));
    expect(r.outcome, r.detail).toBe('fail');
    expect(r.detail).toContain('big/f7.ts:81');
  });

  it('never reads a symbolic link: it is named, and what it points at outside the tree stays out of the result', () => {
    const { dir, head } = repo({ 'x.ts': 'export {};\n' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gh392-out-'));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'secret.ts'), '// a secret outside the tree\n');
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(dir, 'leak.ts'));
    const r = judge(ctx(dir, head));
    expect(r.outcome).toBe('pass');
    expect(r.detail).not.toContain('secret');
    expect(r.detail).toContain('leak.ts (symbolic link)');
  });

  it('names a file it cannot read instead of failing the check', () => {
    const { dir, head } = repo({ 'x.ts': 'export {};\n' });
    put(dir, 'locked.ts', '// note\n');
    fs.chmodSync(path.join(dir, 'locked.ts'), 0o000);
    try {
      const r = judge(ctx(dir, head));
      if (process.getuid?.() === 0) return;
      expect(r.outcome).toBe('pass');
      expect(r.detail).toContain('locked.ts (unreadable)');
    } finally { fs.chmodSync(path.join(dir, 'locked.ts'), 0o644); }
  });

  it('reads a file whose git attributes mark it binary for diff (-diff) as text', () => {
    const { dir, head } = repo({ '.gitattributes': '*.ts -diff\n', 'a.ts': 'export const a = 1;\n' });
    put(dir, 'a.ts', 'export const a = 1;\n// a hidden note\n');
    const r = judge(ctx(dir, head));
    expect(r.outcome).toBe('fail');
    expect(r.detail).toContain('a.ts:2');
  });

  it('reads a file whose name git has to quote, emoji and tab included', () => {
    const name = 'x\u{1F600}\tname.ts';
    const { dir, head } = repo({ [name]: 'export const a = 1;\n' });
    git(dir)(['config', 'core.quotePath', 'false']);
    put(dir, name, 'export const a = 1;\n// a note\n');
    const r = judge(ctx(dir, head));
    expect(r.outcome).toBe('fail');
    expect(r.detail).toContain(`${name}:2`);
  });

  it('names a file the scanner cannot get through instead of failing the check', () => {
    const { dir, head } = repo({ 'x.ts': 'export {};\n' });
    let deep = 'x';
    for (let i = 0; i < 20000; i++) deep = `\`a \${${deep}}\``;
    put(dir, 'deep.ts', `export const d = ${deep};\n`);
    const r = judge(ctx(dir, head));
    expect(r.outcome).toBe('pass');
    expect(r.detail).toContain('deep.ts (could not be scanned)');
  });

  it('names the files whose type it has no rules for, and does not judge them', () => {
    const { dir, head } = repo({ 'x.ts': 'export {};\n' });
    put(dir, 'README.md', '<!-- a note -->\n# Title\n');
    put(dir, 'data.json', '{"a": "// no"}\n');
    const r = judge(ctx(dir, head));
    expect(r.outcome).toBe('pass');
    expect(r.detail).toContain('README.md');
    expect(r.detail).toContain('data.json');
  });

  it('leaves out the paths the engine ignores (the test report)', () => {
    const { dir, head } = repo({ 'x.ts': 'export {};\n' });
    put(dir, 'reports/out.js', '// written by the runner\n');
    expect(judge(ctx(dir, head, { ignoredPaths: ['reports'] })).outcome).toBe('pass');
  });

  it('allows the functional forms in added lines', () => {
    const { dir, head } = repo({ 'x.ts': 'export {};\n' });
    put(dir, 'src/b.ts', '/** Adds one. */\nexport function inc(n: number) { return n + 1; } // eslint-disable-line\n');
    put(dir, 'tool.py', '"""The tool."""\nimport os  # noqa: F401\n');
    expect(judge(ctx(dir, head)).outcome).toBe('pass');
  });

  it('names its known limits in the result text', () => {
    const { dir, head } = repo({ 'x.ts': 'export {};\n' });
    put(dir, 'x.ts', 'export {}; // note\n');
    const r = judge(ctx(dir, head));
    expect(r.detail).toMatch(/regex/i);
    expect(r.detail).toMatch(/heredoc/i);
  });

  it('cannot judge without an entry commit (a card that predates checks: soft) or without a tree', () => {
    const { dir } = repo({ 'x.ts': 'export {};\n' });
    expect(judge(ctx(dir, null))).toMatchObject({ outcome: 'unavailable', soft: true });
    expect(judge(ctx(null, 'abc'))).toMatchObject({ outcome: 'unavailable' });
    expect(judge(ctx(null, 'abc')).soft).not.toBe(true);
  });

  it('gives the same detail for the same tree, so an override given against it still covers it', () => {
    const { dir, head } = repo({ 'x.ts': 'export {};\n' });
    put(dir, 'b.ts', '// one\n');
    put(dir, 'a.ts', '// two\n');
    const one = judge(ctx(dir, head)).detail;
    expect(judge(ctx(dir, head)).detail).toBe(one);
    expect(one.indexOf('a.ts:1')).toBeLessThan(one.indexOf('b.ts:1'));
  });
});

describe('severity and overrides, as for any check', () => {
  const steps = (check: Record<string, unknown>) => [s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [check] }), s('END', 2, { isAnchor: true })];
  const dirty = () => {
    const { dir, head } = repo({ 'x.ts': 'export {};\n' });
    put(dir, 'x.ts', 'export {}; // note\n');
    return { dir, head };
  };

  it('blocks by default', () => {
    const { dir, head } = dirty();
    const out = evaluateChecks(resolveStepChecks(steps({ id: ID }), 'WORK').filter(c => c.id === ID), ctx(dir, head));
    expect(out.blocked).toBe(true);
    expect(out.results[0]).toMatchObject({ id: ID, outcome: 'fail', blocking: true });
  });

  it('only warns where the flow sets it to warn', () => {
    const { dir, head } = dirty();
    const out = evaluateChecks(resolveStepChecks(steps({ id: ID, severity: 'warn' }), 'WORK').filter(c => c.id === ID), ctx(dir, head));
    expect(out.blocked).toBe(false);
    expect(out.results[0]).toMatchObject({ outcome: 'fail', blocking: false, severity: 'warn' });
  });

  it("is lifted by a person's override of that result", () => {
    const { dir, head } = dirty();
    const resolved = resolveStepChecks(steps({ id: ID }), 'WORK').filter(c => c.id === ID);
    const detail = evaluateChecks(resolved, ctx(dir, head)).results[0].detail;
    const out = evaluateChecks(resolved, ctx(dir, head, { overrides: { [ID]: { id: 'o', by: 'p', at: 'now', reason: 'kept on purpose', detail } } }));
    expect(out.blocked).toBe(false);
    expect(out.results[0].overridden?.reason).toBe('kept on purpose');
  });
});

describe('through verify', () => {
  it('refuses a step whose work adds a narration comment, and lets it go once removed', async () => {
    const dir = makeRepo();
    const steps = [s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: ID }] }), s('NEXT', 2), s('END', 3, { isAnchor: true })];
    const id = await card(await project(await flow(steps), { projectRoot: dir, verifyCommand: 'node runner.cjs' }), 'START');
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await item(id)).status).toBe('WORK');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    write(dir, 'src/feature.js', 'module.exports = 1; // the answer\n');
    const c = await refused(id, ID);
    expect(c.detail).toContain('src/feature.js:1');
    write(dir, 'src/feature.js', 'module.exports = 1;\n');
    const ok = await validate(id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await item(id)).status).toBe('NEXT');
  });
});
