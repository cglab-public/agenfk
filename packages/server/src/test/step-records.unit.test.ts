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

    it('describes what changed between two surfaces', async () => {
      const mod = await load();
      const a = { files: { 'x.test.ts': '1', 'y.test.ts': '2' } };
      const b = { files: { 'x.test.ts': '9', 'z.test.ts': '3' } };
      expect(mod.surfaceDiff(a, b).sort()).toEqual(['added z.test.ts', 'deleted y.test.ts', 'edited x.test.ts']);
      expect(mod.surfaceDiff(a, a)).toEqual([]);
    });
  });
});
