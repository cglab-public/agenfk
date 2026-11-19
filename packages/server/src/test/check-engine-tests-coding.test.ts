/**
 * @file The check-engine end-to-end tests (check-engine-tests.test.ts), CGLAB-380, implementing (coding) and refactoring.
 * Split out so the parts run side by side (GH-274); the harness is helpers/engineTests.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { storage } from '../server';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

import {
  REPORT,
  agent,
  atBuild,
  card,
  flow,
  impl,
  item,
  makeRepo,
  project,
  refused,
  reviewed,
  s,
  useEngineServer,
  validate,
  write,
} from './helpers/engineTests';

useEngineServer('check-engine-tests-coding-test-db.sqlite');

describe('CGLAB-380: test checks', () => {
  describe('implementing (coding)', () => {
    it('refuses while a red test still fails, naming it', async () => {
      const { id } = await atBuild();
      const c = await refused(id, 'red-set-passes-by-name');
      expect(c.detail).toMatch(/mul_works/);
    });

    it('lets an existing test change while implementing: a behaviour change rightly changes its tests (1049ce52)', async () => {
      const { dir, id } = await atBuild();
      write(dir, 'tests/mul.test.js', 'T mul_works mul=0\nT mul_again mul=0\n');
      impl(dir, { add: 'ok', mul: '0' });
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    it('refuses skipping a red test: skipped is not passed', async () => {
      const { dir, id } = await atBuild();
      write(dir, 'tests/mul.test.js', 'T mul_works mul=12 SKIP\nT mul_again mul=12\n');
      impl(dir, { add: 'ok', mul: '12' });
      const c = await refused(id, 'red-set-passes-by-name');
      expect(c.detail).toMatch(/mul_works.*skipped/);
    });

    it('refuses deleting a test file: its red tests are missing, not passed', async () => {
      const { dir, id } = await atBuild();
      fs.rmSync(path.join(dir, 'tests/mul.test.js'));
      await refused(id, 'red-set-passes-by-name');
    });

    /*
     * CGLAB-418: a red set recorded before the JUnit reader knew vitest's
     * import-failure shape holds the file itself as a test, `F > F`. The name
     * can never come back, so the card was stuck until a person overrode the
     * check. Such an entry stands for the file's tests: it passes when the file
     * now reports tests and every one of them passes, and on nothing less.
     */
    const plantPhantom = async (id: string, file: string) => {
      const records: any[] = (await storage.getItem(id) as any).stepRecords;
      const rec = records.find(r => r.kind === 'record' && r.name === 'redSet');
      expect(rec, JSON.stringify(records)).toBeDefined();
      rec.value = [...rec.value, `${file} > ${file}`];
      await storage.updateItem(id, { stepRecords: records } as any);
    };

    it('an old import-failure entry in the red set passes once its file loads and its tests pass (CGLAB-418)', async () => {
      const { dir, id } = await atBuild();
      await plantPhantom(id, 'tests/mul.test.js');
      impl(dir, { add: 'ok', mul: '12' });
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    // What does NOT pass such an entry (a failing test in its file, a file with no tests): check-evaluators.unit.test.ts.

    it('a strict freeze, added by the flow, refuses even an appended file', async () => {
      const { dir, id } = await atBuild({ BUILD: [{ id: 'test-surface-frozen', params: { mode: 'strict' } }] });
      impl(dir, { add: 'ok', mul: '12' });
      write(dir, 'tests/extra.test.js', 'T mul_more mul=12\n');
      const c = await refused(id, 'test-surface-frozen');
      expect(c.detail).toMatch(/added tests\/extra\.test\.js/);
    });
  });

  describe('refactoring', () => {
    async function atTidy() {
      const at = await atBuild();
      impl(at.dir, { add: 'ok', mul: '12' });
      const r = await validate(at.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await item(at.id)).status).toBe('TIDY');
      return at;
    }

    it('refuses a test added or removed while refactoring: the test set must be identical', async () => {
      const { dir, id } = await atTidy();
      write(dir, 'tests/extra.test.js', 'T mul_more mul=12\n');
      write(dir, 'tests/mul.test.js', 'T mul_works mul=12\n');
      const c = await refused(id, 'test-set-identical');
      expect(c.detail).toMatch(/\+tests\/extra\.test\.js > mul_more/);
      expect(c.detail).toMatch(/-tests\/mul\.test\.js > mul_again/);
    });

    it('names a changed report setting, not a mass swap, when the tests only look different because the report changed (d26832d6 #19)', async () => {
      // marketing-lab: adding a `file` attribute to the report renamed every
      // test, and the check listed them all as removed and re-added.
      const { id } = await atTidy();
      const pid = (await item(id)).projectId;
      await storage.updateProject(pid, { testReport: { format: 'junit-xml', command: 'node junit.cjs tests', reportPath: 'report.xml', surface: ['tests'] } } as never);
      const c = await refused(id, 'test-set-identical');
      expect(c.detail).toMatch(/test report setting changed/i);
      expect(c.detail).not.toMatch(/^the tests changed/);
    });
  });

  it('a rollback over the test-writing step drops the red set it produced', async () => {
    const { id } = await atBuild();
    expect((await agent().put(`/items/${id}`).send({ status: 'SPECS' })).status).toBe(200);
    const recs = (await item(id)).stepRecords;
    expect(recs.filter((x: any) => x.kind === 'record')).toEqual([]);
  });

  it('the SAME library on a default-shaped flow asks only for a green suite', async () => {
    const dir = makeRepo();
    const steps = [
      s('TODO', 0, { isAnchor: true }), s('IN_PROGRESS', 1, { role: 'coding' }),
      s('REVIEW', 2, { role: 'review' }), s('TEST', 3, { role: 'testing' }), s('DONE', 4, { isAnchor: true, role: 'closing' }),
    ];
    const id = await card(await project(await flow(steps), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT }), 'TODO');
    for (const expected of ['IN_PROGRESS', 'REVIEW', 'TEST', 'DONE']) {
      if (expected === 'TEST') await reviewed(id, dir);
      const r = await validate(id);
      expect(r.status, `${expected}: ${JSON.stringify(r.body)}`).toBe(200);
      expect((await item(id)).status).toBe(expected);
    }
    // ...and a red suite still stops it.
    const id2 = await card(await project(await flow(steps), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT }), 'IN_PROGRESS');
    impl(dir, { add: 'broken' });
    await refused(id2, 'suite-green');
  });
});
