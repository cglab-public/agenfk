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
