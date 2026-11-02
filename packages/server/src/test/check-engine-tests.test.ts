/**
 * @file CGLAB-380 (S4-T4) — the test checks, end to end: one check library
 * enforces a TDD-shaped flow and a default-shaped flow from roles alone.
 * The cheats are the simulation's (EPIC ba077e5e). Shared harness notes:
 *
 * verify resolves the step's checks (universal + role built-ins + flow extras),
 * runs them in the card's tree, and refuses the transition when a blocking one
 * fails, in the verify failure shape old clients already print (422 with a
 * message) plus `checks[]`. Warnings are recorded and never block. Results go
 * on the card. A test report is captured only when a check needs one, and a
 * capture also serves as the NEXT step's entry record, so no suite runs just to
 * snapshot a step's start.
 *
 * Every flow here is written with step names the server has never seen: the
 * engine must work from roles and records alone.
 *
 * Split into check-engine-tests*.test.ts files over one harness (helpers/engineTests.ts)
 * so the parts run side by side (GH-274); this file keeps 9afdba7d, 4a428bb0 and
 * CGLAB-380's TDD path, test-authoring and review-findings blocks.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { storage } from '../server';
import { posixShell } from './helpers/posixShell';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

import {
  NOT_WRITTEN_YET,
  REPORT,
  agent,
  atSpecs,
  byId,
  card,
  flow,
  honestTests,
  impl,
  item,
  makeRepo,
  project,
  refused,
  repos,
  reviewed,
  s,
  tddSteps,
  useEngineServer,
  validate,
  write,
} from './helpers/engineTests';

useEngineServer('check-engine-tests-test-db.sqlite');

describe('9afdba7d: a junit report that names no file: the project declares its test paths', () => {
  const frozen = (params: Record<string, string> = { mode: 'strict', since: 'step-entry' }) => [
    s('START', 0, { isAnchor: true }),
    s('WORK', 1, { checks: [{ id: 'test-surface-frozen', params }] }),
    s('NEXT', 2),
    s('END', 3, { isAnchor: true }),
  ];
  const report = (command: string, reportPath = 'report.xml', surface?: string[]) => ({ format: 'junit-xml', command, reportPath, ...(surface ? { surface } : {}) });
  async function onWork(dir: string, command: string, { reportPath = 'report.xml', surface, before }: { reportPath?: string; surface?: string[]; before?: (pid: string) => Promise<void> } = {}) {
    const pid = await project(await flow(frozen()), { projectRoot: dir, verifyCommand: command, testReport: report(command, reportPath, surface) });
    if (before) await before(pid);
    const id = await card(pid, 'START');
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await item(id)).status).toBe('WORK');
    return { id, pid };
  }
  /** A repo whose tests live where no convention looks: checks/, with tests/ gone. */
  function offConvention(): string {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, 'checks'));
    write(dir, 'checks/a.js', 'T add_works add=ok\n');
    execSync('git rm -rq tests && git add . && git commit -qm checks', { cwd: dir, shell: posixShell() });
    return dir;
  }

  it('blocks when nothing is declared, and names the command with the directories that look like tests', async () => {
    const dir = makeRepo();
    const { id, pid } = await onWork(dir, 'node junit.cjs tests');
    const c = await refused(id, 'test-surface-frozen');
    expect(c.outcome).toBe('unavailable');
    expect(c.detail).toContain(`agenfk update-project ${pid} --test-report-surface tests (suggested`);
  });

  it('declaring paths off the conventions unblocks it, and then sees an edit there', async () => {
    const dir = offConvention();
    const { id } = await onWork(dir, 'node junit.cjs checks', { surface: ['checks'] });
    write(dir, 'checks/a.js', 'T add_works add=ok\n// edited\n');
    const c = await refused(id, 'test-surface-frozen');
    expect(c.outcome).toBe('fail');
    expect(c.detail).toMatch(/edited checks\/a\.js/);
  });

  it('never counts the report the capture writes inside a declared test directory', async () => {
    const dir = makeRepo();
    const { id } = await onWork(dir, 'node junit.cjs tests tests/junit.xml', { reportPath: 'tests/junit.xml', surface: ['tests'] });
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(byId((await item(id)).lastChecks.results, 'test-surface-frozen').outcome).toBe('pass');
  });

  it('a base recorded incomplete stays so after declaring mid-card, and says to re-enter the step', async () => {
    const dir = makeRepo();
    const { id, pid } = await onWork(dir, 'node junit.cjs tests');
    await storage.updateProject(pid, { testReport: report('node junit.cjs tests', 'report.xml', ['tests']) } as any);
    const c = await refused(id, 'test-surface-frozen');
    expect(c.outcome).toBe('unavailable');
    expect(c.detail).toMatch(/re-enter/i);
  });

  it('warns, and does not compare, when the declared paths changed since the base', async () => {
    const dir = offConvention();
    fs.mkdirSync(path.join(dir, 'more'));
    write(dir, 'more/b.js', 'T add_works add=ok\n');
    execSync('git add . && git commit -qm more', { cwd: dir, shell: posixShell() });
    const { id, pid } = await onWork(dir, 'node junit.cjs checks', { surface: ['checks'] });
    await storage.updateProject(pid, { testReport: report('node junit.cjs checks', 'report.xml', ['checks', 'more']) } as any);
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = byId((await item(id)).lastChecks.results, 'test-surface-frozen');
    expect(c.outcome).toBe('unavailable');
    expect(c.blocking).toBe(false);
  });

  /** SPECS writes a red test and freezes the tests; CODE runs a strict freeze since then. Vitest-style report: every name a file. */
  async function frozenAtCode(surface?: string[]) {
    const dir = makeRepo();
    const steps = [
      s('START', 0, { isAnchor: true }),
      s('SPECS', 1, { checks: [{ id: 'some-new-test-red' }] }),
      s('CODE', 2, { checks: [{ id: 'test-surface-frozen', params: { mode: 'strict' } }] }),
      s('NEXT', 3),
      s('END', 4, { isAnchor: true }),
    ];
    const pid = await project(await flow(steps), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: { ...REPORT, ...(surface ? { surface } : {}) } });
    const id = await card(pid, 'START');
    expect((await validate(id)).status).toBe(200);
    write(dir, 'tests/mul.test.js', 'T mul_works mul=12\n');
    expect((await validate(id)).status).toBe(200);
    impl(dir, { add: 'ok', mul: '12' });
    return { dir, id, pid };
  }
  const softly = async (id: string) => {
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = byId((await item(id)).lastChecks.results, 'test-surface-frozen');
    expect(c.outcome).toBe('unavailable');
    expect(c.blocking).toBe(false);
  };

  // Records an older server wrote (a bare frozen map, an entry surface with no scope): check-evaluators.unit.test.ts.
  it('warns, and does not compare, when the declared paths changed since the tests were frozen', async () => {
    const { dir, id, pid } = await frozenAtCode();
    fs.mkdirSync(path.join(dir, 'helpers'));
    write(dir, 'helpers/h.js', 'x');
    execSync('git add . && git commit -qm helpers', { cwd: dir, shell: posixShell() });
    await storage.updateProject(pid, { testReport: { ...REPORT, surface: ['helpers'] } } as any);
    await softly(id);
  });
});

describe('4a428bb0: a card keeps the history of its checks, approvals and overrides', () => {
  const steps = () => [
    s('START', 0, { isAnchor: true }),
    s('WORK', 1, { checks: [{ id: 'jira-key-valid' }, { id: 'human-approval' }] }),
    s('NEXT', 2),
    s('END', 3, { isAnchor: true }),
  ];
  const board = { 'x-agenfk-ui': '1' };
  async function onWork() {
    const dir = makeRepo();
    const pid = await project(await flow(steps()), { projectRoot: dir });
    const id = await card(pid, 'START');
    expect((await validate(id)).status).toBe(200);
    return id;
  }
  const history = async (id: string) => {
    const r = await agent().get(`/items/${id}/check-history`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as any[];
  };

  it('records every verify, refused or passed, with its step, time and each check', async () => {
    const id = await onWork();
    expect((await validate(id)).status).toBe(422); // no key, no approval
    await agent().put(`/items/${id}`).send({ jiraItem: 'ABC-12' });
    await agent().post(`/items/${id}/approvals`).set(board).send({ step: 'WORK' });
    expect((await validate(id)).status).toBe(200);
    const h = await history(id);
    const verifies = h.filter(e => e.kind === 'verify');
    // Newest first: the passing WORK run, the refused one, then leaving START.
    expect(verifies.map(e => [e.step, e.blocked])).toEqual([['WORK', false], ['WORK', true], ['START', false]]);
    const refused = verifies[1];
    expect(Date.parse(refused.at)).not.toBeNaN();
    expect(refused.results.find((r: any) => r.id === 'jira-key-valid')).toMatchObject({ outcome: 'fail', blocking: true });
    expect(refused.results.find((r: any) => r.id === 'human-approval')).toMatchObject({ outcome: 'fail', blocking: true });
  });

  it('records approvals and overrides, with who, when and on what authority', async () => {
    const id = await onWork();
    await validate(id);
    await agent().post(`/items/${id}/overrides`).set(board).send({ step: 'WORK', checkId: 'jira-key-valid', reason: 'spike, no ticket' });
    await agent().post(`/items/${id}/approvals`).set(board).send({ step: 'WORK', note: 'go' });
    const h = await history(id);
    expect(h[0]).toMatchObject({ kind: 'approval', step: 'WORK', by: 'board', authority: 'unverified', note: 'go' });
    expect(h[1]).toMatchObject({ kind: 'override', step: 'WORK', by: 'board', check: 'jira-key-valid', reason: 'spike, no ticket' });
    expect(Date.parse(h[0].at)).not.toBeNaN();
  });

  it('survives a rollback: the approvals it records are history, not the step\'s live state', async () => {
    const id = await onWork();
    await agent().put(`/items/${id}`).send({ jiraItem: 'ABC-12' });
    await agent().post(`/items/${id}/approvals`).set(board).send({ step: 'WORK' });
    expect((await validate(id)).status).toBe(200);
    expect((await agent().put(`/items/${id}`).send({ status: 'WORK' })).status).toBe(200);
    const kinds = (await history(id)).map(e => e.kind);
    expect(kinds).toContain('approval');
    expect(kinds.filter(k => k === 'verify')).toHaveLength(2);
  });

  it('keeps the latest 100 entries', async () => {
    const id = await onWork();
    const old = Array.from({ length: 100 }, (_, i) => ({ kind: 'verify', step: 'WORK', at: new Date(2020, 0, 1, 0, i).toISOString(), blocked: true, results: [] }));
    await storage.updateItem(id, { checkHistory: old } as any);
    await validate(id);
    const h = await history(id);
    expect(h).toHaveLength(100);
    expect(Date.parse(h[0].at)).toBeGreaterThan(Date.parse('2021-01-01'));
  });

  it('cannot be written by a client', async () => {
    const id = await onWork();
    await agent().put(`/items/${id}`).send({ checkHistory: [{ kind: 'approval', step: 'WORK', at: 'x', by: 'forged' }] });
    expect((await history(id)).some(e => e.by === 'forged')).toBe(false);
  });
});

describe('CGLAB-380: test checks', () => {
  it('the honest TDD path reaches the end, and the red set is recorded by name', async () => {
    const { dir, id } = await atSpecs();
    honestTests(dir);
    write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n'); // born green: a warning, answered (CGLAB-420)
    let r = await validate(id, { checkAnswers: [...NOT_WRITTEN_YET.checkAnswers, { id: 'new-tests-born-green', note: 'add_again pins add, which already exists' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.message).toMatch(/new-tests-born-green/);
    expect(r.body.message).toMatch(/red-is-assertion/); // mul is missing: a TypeError, not an assertion
    const red = (await item(id)).stepRecords.find((x: any) => x.kind === 'record' && x.name === 'redSet');
    expect(red.step).toBe('SPECS');
    expect(red.value).toEqual(['tests/mul.test.js > mul_works', 'tests/mul.test.js > mul_again']);

    impl(dir, { add: 'ok', mul: '12' });
    for (const expected of ['TIDY', 'LOOK', 'FINISHED']) {
      if (expected === 'FINISHED') await reviewed(id, dir);
      r = await validate(id);
      expect(r.status, `${expected}: ${JSON.stringify(r.body)}`).toBe(200);
      expect((await item(id)).status).toBe(expected);
    }
  });

  describe('writing tests (test-authoring)', () => {
    it('refuses when every new test already passes: nothing is red', async () => {
      const { dir, id } = await atSpecs();
      write(dir, 'tests/b.test.js', 'T add_twice add=ok\n');
      await refused(id, 'some-new-test-red');
    });

    it('refuses when no test was added', async () => {
      const { dir, id } = await atSpecs();
      write(dir, 'tests/a.test.js', 'T add_works add=ok\n# a comment\n');
      await refused(id, 'new-tests-exist');
    });

    it('refuses a test file that fails to load', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      write(dir, 'tests/c.test.js', 'BROKEN\n');
      const c = await refused(id, 'no-broken-test-files');
      expect(c.detail).toMatch(/tests\/c\.test\.js/);
      // CGLAB-418: the usual cause is a test importing code not written yet, and code may not be written here.
      expect(c.detail).toMatch(/import it inside the test/i);
    });

    it('refuses when a test that passed at the start of the step now fails', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      write(dir, 'tests/a.test.js', 'T add_works add=nope\n');
      const c = await refused(id, 'existing-tests-still-green');
      expect(c.detail).toMatch(/add_works/);
    });
  });

  describe('review findings (CGLAB-380 story review)', () => {
    const unignore = (dir: string) => {
      write(dir, '.gitignore', '');
      execSync('git add .gitignore && git commit -qm unignore', { cwd: dir, shell: posixShell() });
    };

    it('the report the capture writes is not the card\'s change, even when it is not gitignored', async () => {
      const dir = makeRepo();
      unignore(dir);
      const id = await card(await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT }), 'START');
      for (const expected of ['ASK', 'SPECS']) {
        const r = await validate(id);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect((await item(id)).status).toBe(expected);
      }
      honestTests(dir);
      const r = await validate(id, NOT_WRITTEN_YET);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    it('a source change in the shared tree is this card\'s change, whatever another card once claimed', async () => {
      // 26c059f6: claims are gone, so no file is handed to another card. A
      // claim stored on an old sibling excuses nothing.
      const { dir, id } = await atSpecs();
      const pid = (await item(id)).projectId;
      await card(pid, 'BUILD', { claims: ['src/sibling.js'], stepRecords: [{ kind: 'exit', step: 'SPECS', at: new Date().toISOString() }] });
      honestTests(dir);
      write(dir, 'src/sibling.js', 'theirs');
      const c = await refused(id, 'only-test-files-changed');
      expect(c.detail).toMatch(/src\/sibling\.js/);
    });

    it('a card already in the coding step when the flow gained roles warns and advances', async () => {
      const dir = makeRepo();
      const id = await card(await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT }), 'BUILD');
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const results = (await item(id)).lastChecks.results;
      expect(byId(results, 'red-set-passes-by-name')).toMatchObject({ outcome: 'unavailable', blocking: false });
    });

    it('the final transition of a default-shaped flow runs the suite once, not twice', async () => {
      const dir = makeRepo();
      const counter = path.join(dir, '..', `${path.basename(dir)}-runs`);
      repos.push(counter);
      const steps = [
        s('TODO', 0, { isAnchor: true }), s('IN_PROGRESS', 1, { role: 'coding' }),
        s('REVIEW', 2, { role: 'review' }), s('TEST', 3, { role: 'testing' }), s('DONE', 4, { isAnchor: true, role: 'closing' }),
      ];
      const id = await card(await project(await flow(steps), { projectRoot: dir, verifyCommand: `echo x >> ${counter} && node runner.cjs` }), 'TEST');
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await item(id)).status).toBe('DONE');
      expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    });
  });
});
