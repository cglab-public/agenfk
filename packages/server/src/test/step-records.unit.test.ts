/**
 * @file CGLAB-379 (S3) — the report readers and the test-surface hash.
 *
 * These turn a runner's report into per-test names, statuses and failure
 * classes, which is what later checks compare by NAME (the red set must pass
 * by name; a skipped or missing test is not a pass). A file that fails to load
 * has no test names, so it is reported separately as a broken file.
 *
 * Imported dynamically so a missing module fails an assertion, not the file.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const load = async (): Promise<any> => {
  const mod = await import('../stepRecords').catch(() => null);
  expect(mod, 'packages/server/src/stepRecords.ts is missing').not.toBeNull();
  return mod;
};

describe('CGLAB-379: test report readers', () => {
  it('exists', async () => {
    await load();
  });

  describe('vitest JSON', () => {
    const root = '/repo';
    const report = {
      testResults: [
        {
          name: '/repo/tests/a.test.ts', status: 'failed', message: '',
          assertionResults: [
            { fullName: 'a works', status: 'passed', failureMessages: [] },
            { fullName: 'a fails', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2'] },
            { fullName: 'a throws', status: 'failed', failureMessages: ['TypeError: x is not a function'] },
            { fullName: 'a skipped', status: 'skipped', failureMessages: [] },
          ],
        },
        { name: '/repo/tests/broken.test.ts', status: 'failed', message: "Cannot find module '../nope'", assertionResults: [] },
      ],
    };

    it('names each test by file and full name, with its status', async () => {
      const mod = await load();
      const r = mod.parseVitestJson(JSON.stringify(report), root);
      const byName = Object.fromEntries(r.tests.map((t: any) => [t.name, t]));
      expect(byName['tests/a.test.ts > a works'].status).toBe('passed');
      expect(byName['tests/a.test.ts > a fails'].status).toBe('failed');
      expect(byName['tests/a.test.ts > a skipped'].status).toBe('skipped');
      expect(r.tests.every((t: any) => t.file === 'tests/a.test.ts')).toBe(true);
    });

    it('tells an assertion failure from an error', async () => {
      const mod = await load();
      const r = mod.parseVitestJson(JSON.stringify(report), root);
      const byName = Object.fromEntries(r.tests.map((t: any) => [t.name, t]));
      expect(byName['tests/a.test.ts > a fails'].failure).toBe('assertion');
      expect(byName['tests/a.test.ts > a throws'].failure).toBe('error');
      expect(byName['tests/a.test.ts > a works'].failure).toBeUndefined();
    });

    it('reports a file that failed to load as broken, with no test names', async () => {
      const mod = await load();
      const r = mod.parseVitestJson(JSON.stringify(report), root);
      expect(r.brokenFiles).toEqual([{ file: 'tests/broken.test.ts', message: "Cannot find module '../nope'" }]);
      expect(r.tests.some((t: any) => t.file === 'tests/broken.test.ts')).toBe(false);
    });

    it('reports a file that failed with passing tests (an afterAll that threw) as broken', async () => {
      const mod = await load();
      const r = mod.parseVitestJson(JSON.stringify({ testResults: [{
        name: '/repo/tests/c.test.ts', status: 'failed', message: 'Error: afterAll hook failed',
        assertionResults: [{ fullName: 'c works', status: 'passed', failureMessages: [] }],
      }] }), '/repo');
      expect(r.brokenFiles).toEqual([{ file: 'tests/c.test.ts', message: 'Error: afterAll hook failed' }]);
    });

    it('lists names that occur more than once, so a check cannot read the wrong one', async () => {
      const mod = await load();
      const r = mod.parseVitestJson(JSON.stringify({ testResults: [{
        name: '/repo/tests/d.test.ts', status: 'failed', message: '',
        assertionResults: [
          { fullName: 'd x', status: 'failed', failureMessages: ['AssertionError: no'] },
          { fullName: 'd x', status: 'passed', failureMessages: [] },
        ],
      }] }), '/repo');
      expect(r.duplicateNames).toEqual(['tests/d.test.ts > d x']);
    });

    it('throws on something that is not a vitest report', async () => {
      const mod = await load();
      expect(() => mod.parseVitestJson('not json', root)).toThrow();
      expect(() => mod.parseVitestJson('{"foo":1}', root)).toThrow();
    });
  });

  describe('JUnit XML', () => {
    // node --test --test-reporter=junit writes every failure as <failure
    // type="testCodeFailure">; the class is in the body's `cause:` line, and a
    // file that fails to load is one testcase named after the file.
    const nodeCase = (name: string, body: string) =>
      `<testcase name="${name}" classname="test" failure="x"><failure type="testCodeFailure" message="x">\n${body}\n</failure></testcase>`;
    const ASSERT = "[Error [ERR_TEST_FAILURE]: 1 !== 2] {\n  code: 'ERR_TEST_FAILURE',\n  failureType: 'testCodeFailure',\n  cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n    code: 'ERR_ASSERTION'\n  }\n}";
    const THROW = "[Error [ERR_TEST_FAILURE]: Cannot read properties of null] {\n  code: 'ERR_TEST_FAILURE',\n  failureType: 'testCodeFailure',\n  cause: TypeError: Cannot read properties of null (reading 'x')\n}";
    const BROKEN = "[Error: test failed] { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', exitCode: 1, signal: null }";

    /*
     * c77c1bd3: pytest 9.1.1 writes a test module that fails to import as ONE
     * testcase with an empty classname, named after the module, holding
     * <error message="collection failure">, and stops the run there. Read as
     * a test, it was a new red test that could start the TDD cycle.
     */
    const PYTEST_COLLECTION = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="0" skipped="0" tests="1" time="0.039"><testcase classname="" name="tests.test_broken" time="0.000"><error message="collection failure">ImportError while importing test module '/p/tests/test_broken.py'.
Hint: make sure your test modules/packages have valid Python names.
Traceback:
/usr/lib/python3.11/importlib/__init__.py:126: in import_module
    return _bootstrap._gcd_import(name[level:], package, level)
tests/test_broken.py:1: in &lt;module&gt;
    import nope
E   ModuleNotFoundError: No module named 'nope'</error></testcase></testsuite></testsuites>`;

    it('pytest: a module that fails to collect is a broken file, never a test', async () => {
      const mod = await load();
      const r = mod.parseJunitXml(PYTEST_COLLECTION, '/p');
      expect(r.tests).toEqual([]);
      expect(r.brokenFiles).toEqual([{ file: 'tests/test_broken.py', message: "ModuleNotFoundError: No module named 'nope'" }]);
    });

    it('pytest: a real test that errors in setup stays a test, with an error', async () => {
      const mod = await load();
      const xml = '<testsuite><testcase classname="tests.test_a" name="test_x"><error message="failed on setup with &quot;fixture \'db\' not found&quot;">E   fixture \'db\' not found</error></testcase></testsuite>';
      const r = mod.parseJunitXml(xml, '/p');
      expect(r.brokenFiles).toEqual([]);
      expect(r.tests).toEqual([{ name: 'tests.test_a > test_x', file: 'tests.test_a', status: 'failed', failure: 'error' }]);
    });

    it("node:test: reads an assertion failure from the body's cause line", async () => {
      const mod = await load();
      const r = mod.parseJunitXml(`<testsuites>${nodeCase('asserts', ASSERT)}</testsuites>`, '/repo');
      expect(r.tests[0]).toMatchObject({ status: 'failed', failure: 'assertion' });
    });

    it('node:test: reads a thrown error as an error, not an assertion', async () => {
      const mod = await load();
      const r = mod.parseJunitXml(`<testsuites>${nodeCase('throws', THROW)}</testsuites>`, '/repo');
      expect(r.tests[0]).toMatchObject({ status: 'failed', failure: 'error' });
    });

    it('node:test: a test file that fails to load is a broken file, not a (red) test', async () => {
      const mod = await load();
      const r = mod.parseJunitXml(`<testsuites>${nodeCase('asserts', ASSERT)}${nodeCase('test/broken.test.js', BROKEN)}</testsuites>`, '/repo');
      expect(r.tests.map((t: any) => t.name)).toEqual(['test > asserts']);
      expect(r.brokenFiles).toEqual([{ file: 'test/broken.test.js', message: expect.stringMatching(/exited \(code 1\)/) }]);
    });

    // Real node shapes: the message comes FIRST, then the wrapper's failureType/cause.
    const wrap = (message: string, failureType: string, cause: string) =>
      `[Error [ERR_TEST_FAILURE]: ${message}] {\n  code: 'ERR_TEST_FAILURE',\n  failureType: '${failureType}',\n  cause: ${cause}\n}`;

    it('node:test: text in the message cannot decide the class; the wrapper cause line does (review)', async () => {
      const mod = await load();
      const diffMentionsTypeError = wrap("Expected values to be strictly deep-equal:\n+   cause: TypeError: a\n-   cause: 1", 'testCodeFailure', 'AssertionError [ERR_ASSERTION]: Expected values');
      const errorMentionsAssertion = wrap('root cause: AssertionError: nope', 'testCodeFailure', 'RangeError: root cause: AssertionError: nope');
      const r = mod.parseJunitXml(`<testsuites>${nodeCase('deep', diffMentionsTypeError)}${nodeCase('range', errorMentionsAssertion)}</testsuites>`, '/repo');
      expect(r.tests.map((t: any) => t.failure)).toEqual(['assertion', 'error']);
    });

    it('node:test: a timeout or a thrown non-Error is an error, not an assertion (review)', async () => {
      const mod = await load();
      const r = mod.parseJunitXml(`<testsuites>${nodeCase('slow', wrap('test timed out after 10ms', 'testTimeoutFailure', "'test timed out after 10ms'"))}${nodeCase('str', wrap('boom', 'testCodeFailure', "'boom'"))}</testsuites>`, '/repo');
      expect(r.tests.map((t: any) => t.failure)).toEqual(['error', 'error']);
    });

    it('node:test: a real test whose error mentions an exit code stays a test (review)', async () => {
      const mod = await load();
      const body = wrap('Command failed with exit code 2', 'testCodeFailure', "Error: Command failed with exit code 2\n    exitCode: 2,\n    signal: null");
      const r = mod.parseJunitXml(`<testsuites>${nodeCase('spawns bin/cli.js', body)}</testsuites>`, '/repo');
      expect(r.tests.map((t: any) => t.name)).toEqual(['test > spawns bin/cli.js']);
      expect(r.brokenFiles).toEqual([]);
    });

    it('node:test: a broken file is named relative to the repository, from its file attribute (review)', async () => {
      const mod = await load();
      const tc = `<testcase name="test/broken.test.js" time="0.01" classname="test" failure="test failed" file="/repo/pkg/test/broken.test.js"><failure type="testCodeFailure" message="test failed">\n${BROKEN}\n</failure></testcase>`;
      const r = mod.parseJunitXml(`<testsuites>${tc}</testsuites>`, '/repo');
      expect(r.brokenFiles).toEqual([{ file: 'pkg/test/broken.test.js', message: expect.stringMatching(/exited \(code 1\)/) }]);
    });

    it('other JUnit producers are unchanged: a <failure> without a cause line is an assertion, <error> an error', async () => {
      const mod = await load();
      const r = mod.parseJunitXml('<testsuite><testcase classname="c" name="a"><failure message="m">stack</failure></testcase><testcase classname="c" name="b"><error/></testcase></testsuite>', '/repo');
      expect(r.tests.map((t: any) => t.failure)).toEqual(['assertion', 'error']);
      expect(r.brokenFiles).toEqual([]);
    });

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="4">
    <testcase classname="tests.test_a" name="test_ok" file="tests/test_a.py" time="0.01"/>
    <testcase classname="tests.test_a" name="test_bad" file="tests/test_a.py"><failure message="assert 1 == 2">trace</failure></testcase>
    <testcase classname="tests.test_b" name="test_err" file="tests/test_b.py"><error message="ImportError">trace</error></testcase>
    <testcase classname="tests.test_b" name="test_skip &amp; more" file="tests/test_b.py"><skipped message="later"/></testcase>
  </testsuite>
</testsuites>`;

    it('names each test by file and name, with its status and failure class', async () => {
      const mod = await load();
      const r = mod.parseJunitXml(xml, '/repo');
      const byName = Object.fromEntries(r.tests.map((t: any) => [t.name, t]));
      expect(byName['tests/test_a.py > test_ok']).toMatchObject({ status: 'passed', file: 'tests/test_a.py' });
      expect(byName['tests/test_a.py > test_bad']).toMatchObject({ status: 'failed', failure: 'assertion' });
      expect(byName['tests/test_b.py > test_err']).toMatchObject({ status: 'failed', failure: 'error' });
      expect(byName['tests/test_b.py > test_skip & more']).toMatchObject({ status: 'skipped' });
      expect(r.tests).toHaveLength(4);
    });

    it('falls back to the classname when a testcase has no file', async () => {
      const mod = await load();
      const r = mod.parseJunitXml('<testsuite><testcase classname="pkg.Mod" name="t1"/></testsuite>', '/repo');
      expect(r.tests[0].name).toBe('pkg.Mod > t1');
    });

    it('ignores testcases inside comments and CDATA', async () => {
      const mod = await load();
      const r = mod.parseJunitXml(`<testsuite>
        <!-- <testcase classname="c" name="ghost"/> -->
        <testcase classname="c" name="t"><failure message="no"><![CDATA[ <testcase classname="c" name="t"/> ]]></failure></testcase>
      </testsuite>`, '/repo');
      expect(r.tests).toEqual([{ name: 'c > t', file: 'c', status: 'failed', failure: 'assertion' }]);
    });

    it('keeps a raw > inside a quoted attribute', async () => {
      const mod = await load();
      const r = mod.parseJunitXml('<testsuite><testcase classname="c" name="a > b"/><testcase classname="c" name="t2"><failure/></testcase></testsuite>', '/repo');
      expect(r.tests.map((t: any) => [t.name, t.status])).toEqual([['c > a > b', 'passed'], ['c > t2', 'failed']]);
    });

    it('is not fooled by a </testcase> inside CDATA before the failure', async () => {
      const mod = await load();
      const r = mod.parseJunitXml('<testsuite><testcase classname="c" name="t"><system-out><![CDATA[ </testcase> ]]></system-out><failure/></testcase></testsuite>', '/repo');
      expect(r.tests).toHaveLength(1);
      expect(r.tests[0].status).toBe('failed');
    });

    it('is not fooled by a comment opener and closer split across two CDATA sections', async () => {
      const mod = await load();
      const r = mod.parseJunitXml(`<testsuite>
        <testcase classname="c" name="t"><system-out><![CDATA[ <!-- ]]></system-out></testcase>
        <testcase classname="c" name="t"><failure/></testcase>
        <testcase classname="c" name="z"><system-out><![CDATA[ --> ]]></system-out></testcase>
      </testsuite>`, '/repo');
      expect(r.tests.filter((t: any) => t.name === 'c > t').map((t: any) => t.status)).toEqual(['passed', 'failed']);
      expect(r.duplicateNames).toEqual(['c > t']);
    });

    it('lists duplicate names', async () => {
      const mod = await load();
      const r = mod.parseJunitXml('<testsuite><testcase classname="c" name="t"><failure/></testcase><testcase classname="c" name="t"/></testsuite>', '/repo');
      expect(r.duplicateNames).toEqual(['c > t']);
    });

    it('reads a large report in linear time', async () => {
      const mod = await load();
      const xml = '<testsuite>' + '<testcase classname="c" name="t">'.repeat(20000) + '</testsuite>';
      const start = Date.now();
      mod.parseJunitXml(xml, '/repo');
      expect(Date.now() - start).toBeLessThan(500);
    });

    it('throws when there is no testsuite at all', async () => {
      const mod = await load();
      expect(() => mod.parseJunitXml('<html></html>', '/repo')).toThrow();
    });
  });

  describe('the test surface', () => {
    it('hashes the files the report names plus the runner config, from the working tree', async () => {
      const mod = await load();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-surface-'));
      try {
        fs.mkdirSync(path.join(dir, 'tests'));
        fs.writeFileSync(path.join(dir, 'tests/a.test.ts'), 'one');
        fs.writeFileSync(path.join(dir, 'vitest.config.ts'), 'cfg');
        fs.writeFileSync(path.join(dir, 'unrelated.ts'), 'x');
        const s = mod.surfaceOf(dir, ['tests/a.test.ts']);
        expect(Object.keys(s.files).sort()).toEqual(['tests/a.test.ts', 'vitest.config.ts']);
        const again = mod.surfaceOf(dir, ['tests/a.test.ts']);
        expect(again.files).toEqual(s.files);
        fs.writeFileSync(path.join(dir, 'tests/a.test.ts'), 'two');
        expect(mod.surfaceOf(dir, ['tests/a.test.ts']).files['tests/a.test.ts']).not.toBe(s.files['tests/a.test.ts']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('ignores a named file that does not exist, and a path outside the root', async () => {
      const mod = await load();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-surface-'));
      try {
        const s = mod.surfaceOf(dir, ['gone.test.ts', '../../etc/passwd']);
        expect(s.files).toEqual({});
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('includes package.json and conventional setup files, and extra paths (directories recurse)', async () => {
      const mod = await load();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-surface-'));
      try {
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'vitest.setup.ts'), 'setup');
        fs.mkdirSync(path.join(dir, 'tests/helpers'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'tests/helpers/fixture.ts'), 'f');
        const s = mod.surfaceOf(dir, [], ['tests/helpers']);
        expect(Object.keys(s.files).sort()).toEqual(['package.json', 'tests/helpers/fixture.ts', 'vitest.setup.ts']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('resolves a dotted pytest classname to its file, and reports what it could not find', async () => {
      const mod = await load();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-surface-'));
      try {
        fs.mkdirSync(path.join(dir, 'tests'));
        fs.writeFileSync(path.join(dir, 'tests/test_a.py'), 'x');
        const s = mod.surfaceOf(dir, ['tests.test_a', 'tests/gone.py']);
        expect(Object.keys(s.files)).toContain('tests/test_a.py');
        expect(s.missing).toEqual(['tests/gone.py']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('resolves a class-based pytest classname to its module file', async () => {
      const mod = await load();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-surface-'));
      try {
        fs.mkdirSync(path.join(dir, 'tests'));
        fs.writeFileSync(path.join(dir, 'tests/test_a.py'), 'x');
        const s = mod.surfaceOf(dir, ['tests.test_a.TestK']);
        expect(Object.keys(s.files)).toContain('tests/test_a.py');
        expect(s.missing).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not follow symlinks when walking an extra directory (no loops, nothing outside)', async () => {
      const mod = await load();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-surface-'));
      try {
        fs.mkdirSync(path.join(dir, 'tests'));
        fs.writeFileSync(path.join(dir, 'tests/real.ts'), 'x');
        // One loop is enough to show the walk following symlinks; two make an
        // unfixed walk run for minutes (2^20 paths), freezing the server.
        fs.symlinkSync('.', path.join(dir, 'tests/l0'));
        const start = Date.now();
        const s = mod.surfaceOf(dir, [], ['tests']);
        expect(Date.now() - start).toBeLessThan(1000);
        expect(Object.keys(s.files)).toEqual(['tests/real.ts']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    /*
     * 9afdba7d: node:test's junit report says classname="test" (a directory)
     * and xUnit's says "Sample.Tests.MathTests" (a namespace and class): no
     * file at all, so the surface was empty and a frozen surface compared two
     * empty ones. Guessing which files stand for such a name - by name, or by
     * scanning the tree - was defeated three ways in review. The project's
     * DECLARED test paths are the authority: walked in full, they are the
     * surface, with the files the report names added. A name that is no file
     * leaves the surface incomplete unless paths are declared; the directories
     * that look like tests are offered as a suggestion, never used.
     */
    const tree = (files: Record<string, string>) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-surface-'));
      for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
      return dir;
    };
    const within = async (files: Record<string, string>, fn: (mod: any, dir: string, listTree: () => string[]) => void) => {
      const mod = await load();
      const dir = tree(files);
      try { fn(mod, dir, () => Object.keys(files)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };

    it('is the declared test paths, walked in full - fixtures included - plus what the report names', () => within(
      { 'test/a.test.js': 'a', 'test/fixtures/data.json': 'd', 'src/x.js': 'x' },
      (mod, dir) => {
        const s = mod.surfaceOf(dir, ['test'], ['test']);
        expect(Object.keys(s.files).sort()).toEqual(['test/a.test.js', 'test/fixtures/data.json']);
        expect(s.missing).toEqual([]);
        fs.writeFileSync(path.join(dir, 'test/fixtures/data.json'), 'weakened');
        expect(mod.surfaceOf(dir, ['test'], ['test']).files['test/fixtures/data.json']).not.toBe(s.files['test/fixtures/data.json']);
      },
    ));

    it("declaring '.' holds the test files at the root: the root itself is walked", () => within(
      { 'a.test.js': 'a', 'lib/b.js': 'b' },
      (mod, dir) => {
        for (const decl of ['.', './']) {
          const s = mod.surfaceOf(dir, ['test'], [decl]);
          expect(Object.keys(s.files).sort()).toEqual(['a.test.js', 'lib/b.js']);
          expect(s.missing).toEqual([]);
        }
      },
    ));

    it('a declared path that yields no file leaves the surface incomplete, never silently empty', () => within(
      { 'a.test.js': 'a', 'empty/.keep': '' },
      (mod, dir) => {
        fs.rmSync(path.join(dir, 'empty/.keep'));
        expect(mod.surfaceOf(dir, ['test'], ['empty']).missing).toEqual(['empty']);
      },
    ));

    it('is completed by declared paths whatever the report names look like', () => within(
      { 'Sample.Specs/CalculatorFacts.cs': 'c' },
      (mod, dir) => {
        const s = mod.surfaceOf(dir, ['Sample.Tests.MathTests+Inner', 'Sample.Tests.Box`1', 'Sample.Tests.MathTests(1)'], ['Sample.Specs']);
        expect(Object.keys(s.files)).toEqual(['Sample.Specs/CalculatorFacts.cs']);
        expect(s.missing).toEqual([]);
      },
    ));

    it('without declared paths, holds only what the report names, when it names files', () => within(
      { 'tests/a.test.ts': 'a', 'tests/b.test.ts': 'b' },
      (mod, dir, listTree) => {
        const s = mod.surfaceOf(dir, ['tests/a.test.ts'], [], { listTree });
        expect(Object.keys(s.files)).toEqual(['tests/a.test.ts']);
        expect(s.missing).toEqual([]);
      },
    ));

    it('without declared paths, a name that is no file leaves it incomplete, however many test files the tree has', () => within(
      { 'test/a.test.js': 'a', 'other/UtilTests.cs': 'u', 'Sample.Tests/CalculatorShould.cs': 'c' },
      (mod, dir, listTree) => {
        expect(mod.surfaceOf(dir, ['test'], [], { listTree }).missing).toEqual(['test']);
        expect(mod.surfaceOf(dir, ['Sample.Tests.CalculatorShould'], [], { listTree }).missing).toEqual(['Sample.Tests.CalculatorShould']);
      },
    ));

    it('suggests the directories that look like tests, for a person to declare', () => within(
      { 'test/a.test.js': 'a', 'test/unit/b.test.js': 'b', 'packages/x/tests/c.test.ts': 'c', 'Calc.Tests/MathTests.cs': 'm', 'src/y.js': 'y' },
      (mod, dir, listTree) => {
        const s = mod.surfaceOf(dir, ['test'], [], { listTree });
        expect(s.suggested).toEqual(['Calc.Tests', 'packages/x/tests', 'test']);
        expect(Object.keys(s.files)).toEqual([]);
      },
    ));

    it('skips bytecode, caches and OS files inside a declared path', () => within(
      { 'tests/test_a.py': 'a', 'tests/__pycache__/test_a.cpython-311.pyc': 'b', 'tests/.pytest_cache/v': 'c', 'tests/.DS_Store': 'd' },
      (mod, dir) => {
        expect(Object.keys(mod.surfaceOf(dir, [], ['tests']).files)).toEqual(['tests/test_a.py']);
      },
    ));

    it('never covers a named PATH that is gone, declared paths or not', () => within(
      { 'tests/a.test.ts': 'a' },
      (mod, dir) => {
        expect(mod.surfaceOf(dir, ['tests/gone.test.ts'], ['tests']).missing).toEqual(['tests/gone.test.ts']);
      },
    ));

    it('never hashes an excluded path: the report the capture itself writes', () => within(
      { 'tests/a.test.js': 'a', 'tests/junit.xml': '<testsuite/>' },
      (mod, dir) => {
        const s = mod.surfaceOf(dir, ['tests'], ['tests'], { exclude: ['./tests/junit.xml'] });
        expect(Object.keys(s.files)).toEqual(['tests/a.test.js']);
      },
    ));

    it('an empty name claims nothing: it neither adds to the surface nor leaves it incomplete', () => within(
      { 'src/x.js': 'x' },
      (mod, dir) => {
        const s = mod.surfaceOf(dir, [''], []);
        expect(s.missing).toEqual([]);
        expect(s.files).toEqual({});
      },
    ));

    it('describes what changed between two surfaces', async () => {
      const mod = await load();
      const a = { files: { 'x.test.ts': '1', 'y.test.ts': '2' } };
      const b = { files: { 'x.test.ts': '9', 'z.test.ts': '3' } };
      expect(mod.surfaceDiff(a, b).sort()).toEqual(['added z.test.ts', 'deleted y.test.ts', 'edited x.test.ts']);
      expect(mod.surfaceDiff(a, a)).toEqual([]);
    });
  });
});
