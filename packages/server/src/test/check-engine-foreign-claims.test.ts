/**
 * @file 5b48b96b — per-test checks and other cards' claims, in one shared tree.
 *
 * A TDD simulation of three siblings in one tree (each claiming its own
 * <n>.js + <n>.test.js) found the per-test checks judging the whole tree:
 * - a sibling's legitimately red test blocked this card's suite-green, so only
 *   the last sibling to implement could leave its coding step;
 * - new-tests-exist / some-new-test-red counted every sibling's new tests, so a
 *   card that wrote no test passed on another card's red one.
 * only-test-files-changed already treats a foreign-claimed file as that card's.
 *
 * The rule: a test in a file another active card claims is that card's, except
 * a REGRESSION - it passed when this card entered the step and does not now -
 * which still blocks. test-surface-frozen is not relaxed at all: a new file
 * under a claim can still load on its own (a conftest.py, an init()) and mask
 * the tests, and the final verify would not see it.
 */
import { describe, it, expect } from 'vitest';
import { EVALUATORS, type EngineContext, type CaptureRecord } from '../checkEngine';

type T = { name: string; file: string; status: 'passed' | 'failed' | 'skipped'; failure?: 'assertion' | 'error' };
const t = (file: string, name: string, status: T['status'], failure?: T['failure']): T => ({ name: `${file} > ${name}`, file, status, ...(failure ? { failure } : {}) });

const surfaceOf = (tests: T[], extra: Record<string, string> = {}) => ({ files: { ...Object.fromEntries(tests.map(x => [x.file, `h-${x.file}`])), ...extra } });
const cap = (tests: T[], over: Partial<CaptureRecord> = {}): CaptureRecord => ({
  step: 'S', exitCode: tests.some(x => x.status === 'failed') || (over.brokenFiles?.length ?? 0) > 0 ? 1 : 0, format: 'vitest-json', available: true,
  tests, brokenFiles: [], surface: surfaceOf(tests), surfaceComplete: true, surfaceScope: 'declared', surfaceDeclared: [], ...over,
});

/** B claims b.js and b.test.js; this card is A. */
function ctx(entry: T[] | null, now: T[], over: Partial<EngineContext> = {}, capOver: Partial<CaptureRecord> = {}, entryOver: Partial<CaptureRecord> = {}): EngineContext {
  return {
    root: '/repo', git: () => '', item: { id: 'A', type: 'TASK' }, cardBranch: null, cardKeys: [], testPaths: [], ignoredPaths: [],
    foreignClaims: ['b.js', 'b.test.js'], deferToCommand: [], children: [],
    capture: cap(now, capOver), entry: entry ? cap(entry, entryOver) : null, entryHead: null, records: {}, ...over,
  } as EngineContext;
}
const run = (id: string, c: EngineContext, params: Record<string, string> = {}) => EVALUATORS[id](c, params);

const base = [t('sum.test.js', 'adds', 'passed')];

describe('5b48b96b: the new-test checks count only this card\'s own tests', () => {
  it('new-tests-exist counts its own new test, not a sibling\'s', () => {
    const v = run('new-tests-exist', ctx(base, [...base, t('a.test.js', 'aDouble', 'failed', 'assertion'), t('b.test.js', 'bDouble', 'failed', 'assertion')]));
    expect(v).toMatchObject({ outcome: 'pass', detail: '1 new test(s)' });
  });

  it('new-tests-exist fails a card that wrote none, even with a sibling\'s new test in the tree', () => {
    expect(run('new-tests-exist', ctx(base, [...base, t('b.test.js', 'bDouble', 'failed', 'assertion')])).outcome).toBe('fail');
  });

  it('some-new-test-red is not satisfied by a sibling\'s red test', () => {
    const v = run('some-new-test-red', ctx(base, [...base, t('a.test.js', 'aDouble', 'passed'), t('b.test.js', 'bDouble', 'failed', 'assertion')]));
    expect(v.outcome).toBe('fail');
  });

  it('some-new-test-red records only its own red set and authored tests', () => {
    const v = run('some-new-test-red', ctx(base, [...base, t('a.test.js', 'aDouble', 'failed', 'assertion'), t('b.test.js', 'bDouble', 'failed', 'assertion')]));
    expect(v.outcome).toBe('pass');
    expect(v.produces?.redSet).toEqual(['a.test.js > aDouble']);
    expect(v.produces?.authoredTests).toEqual(['sum.test.js > adds', 'a.test.js > aDouble']);
  });

  it('new-tests-born-green and red-is-assertion ignore a sibling\'s new tests', () => {
    const now = [...base, t('a.test.js', 'aDouble', 'failed', 'assertion'), t('b.test.js', 'green', 'passed'), t('b.test.js', 'errs', 'failed', 'error')];
    expect(run('new-tests-born-green', ctx(base, now)).outcome).toBe('pass');
    expect(run('red-is-assertion', ctx(base, now)).outcome).toBe('pass');
  });

  it('an unclaimed file is still the card\'s: a new test there counts', () => {
    const v = run('new-tests-exist', ctx(base, [...base, t('c.test.js', 'cDouble', 'failed', 'assertion')]));
    expect(v).toMatchObject({ outcome: 'pass', detail: '1 new test(s)' });
  });
});

describe('5b48b96b: suite-green and no-broken-test-files leave a sibling\'s unfinished tests to it', () => {
  it('a sibling\'s red test that was never green here does not block', () => {
    const entry = [...base, t('a.test.js', 'aDouble', 'failed', 'assertion')];
    const now = [...base, t('a.test.js', 'aDouble', 'passed'), t('b.test.js', 'bDouble', 'failed', 'assertion')];
    const v = run('suite-green', ctx(entry, now));
    expect(v.outcome, v.detail).toBe('pass');
    expect(v.detail).toMatch(/b\.test\.js/);
  });

  it('a sibling\'s test that passed when this step began and fails now is a regression: it blocks', () => {
    const entry = [...base, t('b.test.js', 'bDouble', 'passed')];
    const now = [...base, t('b.test.js', 'bDouble', 'failed', 'assertion')];
    expect(run('suite-green', ctx(entry, now)).outcome).toBe('fail');
  });

  it('its own red test, or an unclaimed one, still blocks', () => {
    expect(run('suite-green', ctx(base, [...base, t('a.test.js', 'aDouble', 'failed', 'assertion')])).outcome).toBe('fail');
    expect(run('suite-green', ctx(base, [t('sum.test.js', 'adds', 'failed', 'assertion')])).outcome).toBe('fail');
  });

  it('with no entry record there is nothing to tell a regression by: a sibling\'s red test blocks', () => {
    expect(run('suite-green', ctx(null, [...base, t('b.test.js', 'bDouble', 'failed', 'assertion')])).outcome).toBe('fail');
  });

  it('a non-zero exit is explained by a sibling\'s red test, but one with nothing failing still blocks', () => {
    expect(run('suite-green', ctx(base, [...base, t('b.test.js', 'bDouble', 'failed', 'assertion')], {}, { exitCode: 1 })).outcome).toBe('pass');
    expect(run('suite-green', ctx(base, base, {}, { exitCode: 1 })).outcome).toBe('fail');
  });

  // Review: a killed or timed-out run is never explained by what the report shows.
  it('a run with no exit code (killed, timed out) blocks, whatever else failed', () => {
    expect(run('suite-green', ctx(base, [...base, t('b.test.js', 'bDouble', 'failed', 'assertion')], {}, { exitCode: null })).outcome).toBe('fail');
  });

  it('with no claims at all nothing changes: a red test anywhere blocks', () => {
    expect(run('suite-green', ctx(base, [...base, t('b.test.js', 'bDouble', 'failed', 'assertion')], { foreignClaims: [] })).outcome).toBe('fail');
  });

  it('a sibling\'s test file that fails to load is its own, unless it loaded when this step began', () => {
    const broken = { brokenFiles: [{ file: 'b.test.js', message: 'SyntaxError' }] };
    expect(run('no-broken-test-files', ctx(base, base, {}, broken)).outcome).toBe('pass');
    expect(run('suite-green', ctx(base, base, {}, broken)).outcome).toBe('pass');
    const loaded = [...base, t('b.test.js', 'bDouble', 'passed')];
    expect(run('no-broken-test-files', ctx(loaded, base, {}, broken)).outcome).toBe('fail');
    expect(run('suite-green', ctx(loaded, base, {}, broken)).outcome).toBe('fail');
    expect(run('no-broken-test-files', ctx(base, base, {}, { brokenFiles: [{ file: 'a.test.js', message: 'SyntaxError' }] })).outcome).toBe('fail');
    // With no entry record, a sibling's broken file cannot be told apart from a regression: it blocks.
    expect(run('no-broken-test-files', ctx(null, base, {}, broken)).outcome).toBe('fail');
  });

  // Re-review: pytest's JUnit names a test by its class (tests.test_b), a broken file by its path (tests/test_b.py).
  it('a broken file is not excused when a passing test at entry cannot be tied to a file: it may have been this one', () => {
    const entry = [...base, { name: 'tests.test_b > test_one', file: 'tests.test_b', status: 'passed' as const }];
    const broken = { brokenFiles: [{ file: 'tests/test_b.py', message: 'ImportError' }] };
    const c = ctx(entry, base, { foreignClaims: ['tests/test_b.py'] }, broken, { surface: surfaceOf(base) });
    expect(run('no-broken-test-files', c).outcome).toBe('fail');
    expect(run('suite-green', c).outcome).toBe('fail');
  });
});

describe('5b48b96b: the refactoring and count checks compare this card\'s own tests', () => {
  it('test-set-identical ignores a sibling\'s new tests, never a test that passed here and went away', () => {
    expect(run('test-set-identical', ctx(base, [...base, t('b.test.js', 'bDouble', 'failed')])).outcome).toBe('pass');
    // Review blocker: a claim is free to make, so a missing test that was green here is a regression, whoever claims it.
    expect(run('test-set-identical', ctx([...base, t('b.test.js', 'old', 'passed')], base)).outcome).toBe('fail');
    expect(run('test-set-identical', ctx(base, [...base, t('a.test.js', 'new', 'passed')])).outcome).toBe('fail');
  });

  it('test-count-not-lower: a test that passed here and is gone counts, whoever claims its file', () => {
    // The review's probe: a card deletes its own green tests while a card it controls claims the file.
    const entry = [t('a.test.js', 'g1', 'passed'), t('a.test.js', 'g2', 'passed'), t('a.test.js', 'red', 'failed')];
    const records = { authoredTests: entry.map(x => x.name) };
    const c = ctx(entry, [t('a.test.js', 'red', 'passed')], { records, foreignClaims: ['a.test.js'] });
    expect(run('test-count-not-lower', c, { since: 'test-authoring' }).outcome).toBe('fail');
  });

  it('test-count-not-lower: a sibling\'s test that was never green here is its own to remove', () => {
    const entry = [...base, t('b.test.js', 'wip', 'failed')];
    const records = { authoredTests: ['sum.test.js > adds', 'b.test.js > wip'] };
    expect(run('test-count-not-lower', ctx(entry, base, { records }), { since: 'test-authoring' }).outcome).toBe('pass');
    expect(run('test-count-not-lower', ctx(base, [], { records: { authoredTests: ['sum.test.js > adds'] } }), { since: 'test-authoring' }).outcome).toBe('fail');
  });

  it('test-count-not-lower: a sibling adding tests does not make up for this card deleting its own', () => {
    const entry = [t('a.test.js', 'one', 'passed'), t('a.test.js', 'two', 'passed')];
    const now = [t('a.test.js', 'one', 'passed'), t('b.test.js', 'x', 'failed'), t('b.test.js', 'y', 'failed')];
    expect(run('test-count-not-lower', ctx(entry, now, { records: { authoredTests: entry.map(x => x.name) } }), { since: 'test-authoring' }).outcome).toBe('fail');
  });

  // Re-review: a new file under a free claim (a conftest.py, a Go init()) can mask the tests; nothing later sees it.
  it('test-surface-frozen is not relaxed by claims: a new file, an edit or a deletion all count, whoever claims them', () => {
    const strict = { mode: 'strict', since: 'step-entry' };
    expect(run('test-surface-frozen', ctx(base, [...base, t('b.test.js', 'bDouble', 'failed')]), strict).outcome).toBe('fail');
    const edited = ctx([...base, t('b.test.js', 'bDouble', 'passed')], [...base, t('b.test.js', 'bDouble', 'passed')], {}, { surface: { files: { 'sum.test.js': 'h-sum.test.js', 'b.test.js': 'CHANGED' } } });
    expect(run('test-surface-frozen', edited, strict).outcome).toBe('fail');
    expect(run('test-surface-frozen', ctx([...base, t('b.test.js', 'bDouble', 'passed')], base), strict).outcome).toBe('fail');
    expect(run('test-surface-frozen', ctx(base, [...base, t('a.test.js', 'x', 'passed')]), strict).outcome).toBe('fail');
  });

  it('existing-tests-still-green is unchanged: a sibling\'s test that went red is a regression', () => {
    expect(run('existing-tests-still-green', ctx([...base, t('b.test.js', 'bDouble', 'passed')], [...base, t('b.test.js', 'bDouble', 'failed')])).outcome).toBe('fail');
  });
});

describe('5b48b96b review: report paths and claims are compared in one frame', () => {
  // The report names files relative to the project root; claims are relative to the repository.
  const inSub = (claims: string[]) => ({ foreignClaims: claims, git: (args: string[]) => (args.includes('--show-prefix') ? 'app/\n' : '') });

  it('in a project inside a subdirectory, a repository-relative claim still makes the file foreign', () => {
    const v = run('new-tests-exist', ctx(base, [...base, t('b.test.js', 'bDouble', 'failed', 'assertion')], inSub(['app/b.test.js'])));
    expect(v.outcome).toBe('fail');
  });

  it('a top-level claim does not alias the same name inside the subdirectory', () => {
    const v = run('new-tests-exist', ctx(base, [...base, t('b.test.js', 'bDouble', 'failed', 'assertion')], inSub(['b.test.js'])));
    expect(v.outcome).toBe('pass');
  });

  it('a claim written with doubled or back-slashed separators is the same path', () => {
    for (const claim of ['app//b.test.js', 'app\\b.test.js']) {
      expect(run('new-tests-exist', ctx(base, [...base, t('b.test.js', 'bDouble', 'failed', 'assertion')], inSub([claim]))).outcome, claim).toBe('fail');
    }
  });
});

describe('5b48b96b re-review: the checks stay linear in the number of tests', () => {
  it('20,000 tests under a sibling\'s claim are judged in well under a second', () => {
    const entry = Array.from({ length: 20000 }, (_, i) => t('b.test.js', `n${i}`, 'failed'));
    const now = [...base, ...entry];
    const c = ctx(entry, now);
    const t0 = Date.now();
    for (const id of ['suite-green', 'test-set-identical']) run(id, c);
    run('test-count-not-lower', ctx(entry, now, { records: { authoredTests: entry.map(x => x.name) } }), { since: 'test-authoring' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
