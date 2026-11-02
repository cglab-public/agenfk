/**
 * @file GH-281 — the check evaluators' pure decisions, judged directly.
 *
 * The end-to-end tests (check-engine-tests*.test.ts) walk a real card through
 * git and HTTP to reach one evaluator call. Cases that only vary the input to
 * that call - a branch name, a legacy record shape - are judged here, with a
 * fake context, and each end-to-end file keeps one case for the wiring.
 */
import { describe, it, expect } from 'vitest';
import { EVALUATORS, type EngineContext, type CaptureRecord } from '../checkEngine';

type T = { name: string; file: string; status: 'passed' | 'failed' | 'skipped' };
const test = (file: string, name: string, status: T['status'] = 'passed'): T => ({ name: `${file} > ${name}`, file, status });
const capture = (tests: T[], over: Partial<CaptureRecord> = {}): CaptureRecord => ({
  step: 'S', exitCode: 0, format: 'vitest-json', available: true, tests, brokenFiles: [],
  surface: { files: { 'tests/a.test.js': 'h1' } }, surfaceComplete: true, surfaceScope: 'declared', surfaceDeclared: [], ...over,
} as CaptureRecord);
const ctx = (over: Partial<EngineContext> & Record<string, unknown> = {}): EngineContext => ({
  root: '/repo', git: () => '', item: { id: 'A', type: 'TASK' }, cardBranch: null, cardKeys: [], testPaths: [], ignoredPaths: [],
  deferToCommand: [], children: [], capture: null, entry: null, entryHead: null, records: {}, ...over,
} as unknown as EngineContext);

describe('on-card-branch with no branch recorded: judged by the key the branch name leads with', () => {
  /** The tree is on `branch`; the card carries `keys`. */
  const judge = (branch: string, keys: string[] = ['ABC-7']) =>
    EVALUATORS['on-card-branch'](ctx({ cardKeys: keys, git: () => `${branch}\n` }), {});

  it("fails on a branch named for another card's key, naming the branch and the card's key", () => {
    const r = judge('feat/OTHER-9_theirs');
    expect(r.outcome).toBe('fail');
    expect(r.detail).toMatch(/feat\/OTHER-9_theirs/);
    expect(r.detail).toMatch(/ABC-7/);
  });

  it("passes on a branch that carries the card's key, saying so", () => {
    const r = judge('feat/ABC-7_mine');
    expect(r.outcome).toBe('pass');
    expect(r.detail).toMatch(/ABC-7/);
  });

  it('does not take a GitHub issue number for a JIRA key', () => {
    expect(judge('feat/login-fix', ['42']).outcome).toBe('pass');
    // A card known only by an issue number has no JIRA key to hold a branch to: another key's branch is not judged.
    expect(judge('feat/OTHER-9_theirs', ['42']).outcome).toBe('pass');
  });

  it('does not judge a branch that names no key', () => {
    for (const b of ['release/v2.0.0-beta.7', 'develop']) expect(judge(b).outcome, b).toBe('pass');
  });

  it("does not read ordinary words or standards in a branch name as another card's key", () => {
    for (const b of ['feat/add-oauth-2-support', 'renovate/node-20', 'fix/utf-8-decoding', 'release/v2-3', 'fix/CVE-2024-1234', 'feat/UTF-8_support', 'hotfix/SHA-256_digest']) {
      expect(judge(b).outcome, b).toBe('pass');
    }
  });

  it('judges the key that leads the name, not one mentioned further along', () => {
    const r = judge('fix/OTHER-420_field-findings-abc-7');
    expect(r.outcome).toBe('fail');
    expect(r.detail).toMatch(/named for OTHER-420/);
  });

  it('matches the key as a whole token, in any case', () => {
    expect(judge('feat/abc-7_lowercase').outcome).toBe('pass');
    const r = judge('feat/ABC-70_a-longer-key');
    expect(r.outcome).toBe('fail');
    expect(r.detail).toMatch(/ABC-70/);
    // Further along the name, too: the key between separators is the card's, a longer word holding it is not.
    expect(judge('fix/login-abc-7').detail).toMatch(/carries ABC-7/);
    expect(judge('fix/login-xabc-7').detail).toMatch(/names no JIRA key/);
  });

  it('passes on the default branch before a card branch exists, saying it names no key', () => {
    const r = judge('main');
    expect(r.outcome).toBe('pass');
    expect(r.detail).toMatch(/'main', which names no JIRA key/);
  });
});

/*
 * CGLAB-418: a red set recorded before the reader knew vitest's import-failure
 * shape holds the file itself as a test, `F > F`. It stands for that file's
 * tests: it passes once the file reports tests and every one of them passes.
 */
describe('red-set-passes-by-name: an old import-failure entry in the red set (CGLAB-418)', () => {
  const judge = (red: string[], tests: T[]) =>
    EVALUATORS['red-set-passes-by-name'](ctx({ capture: capture(tests), records: { redSet: red } }), {});
  const PHANTOM = 'tests/mul.test.js > tests/mul.test.js';

  it('passes once its file loads and every test in it passes', () => {
    const r = judge([PHANTOM], [test('tests/mul.test.js', 'mul_works'), test('tests/mul.test.js', 'mul_again'), test('tests/a.test.js', 'add_works')]);
    expect(r.outcome, r.detail).toBe('pass');
  });

  it('does not pass while a test in its file fails, naming the file', () => {
    const r = judge([PHANTOM], [test('tests/mul.test.js', 'mul_works'), test('tests/mul.test.js', 'mul_again', 'failed')]);
    expect(r.outcome).toBe('fail');
    expect(r.detail).toMatch(/a test in tests\/mul\.test\.js is not passing/);
  });

  it('does not pass when its file reports no tests, naming the file', () => {
    const r = judge(['tests/gone.test.js > tests/gone.test.js'], [test('tests/a.test.js', 'add_works')]);
    expect(r.outcome).toBe('fail');
    expect(r.detail).toMatch(/tests\/gone\.test\.js reports no tests/);
  });
});

describe('test-surface-frozen: a record an older server wrote is not compared (9afdba7d)', () => {
  const soft = (r: any, why: RegExp) => {
    expect(r).toMatchObject({ outcome: 'unavailable', soft: true });
    expect(r.detail).toMatch(why);
  };

  it('warns, and does not compare, when the tests were frozen by an older server (a bare map, no scope)', () => {
    const r = EVALUATORS['test-surface-frozen'](ctx({ capture: capture([test('tests/a.test.js', 'add_works')]), records: { testSurface: {} } }), { mode: 'strict' });
    soft(r, /frozen by an older server/);
  });

  it('warns, and does not compare, when the entry surface was recorded by an older server (no scope)', () => {
    const entry = capture([test('tests/a.test.js', 'add_works')], { surface: { files: {} }, surfaceScope: undefined } as any);
    const r = EVALUATORS['test-surface-frozen'](ctx({ capture: capture([test('tests/a.test.js', 'add_works')]), entry }), { mode: 'strict', since: 'step-entry' });
    soft(r, /recorded by an older server/);
  });

  it('compares a current-shaped freeze: an edited file fails', () => {
    const r = EVALUATORS['test-surface-frozen'](ctx({
      capture: capture([test('tests/a.test.js', 'add_works')], { surface: { files: { 'tests/a.test.js': 'h2' } } }),
      records: { testSurface: { files: { 'tests/a.test.js': 'h1' }, scope: 'declared', complete: true, declared: [] } },
    }), { mode: 'strict' });
    expect(r.outcome).toBe('fail');
    expect(r.detail).toMatch(/edited tests\/a\.test\.js/);
  });
});
