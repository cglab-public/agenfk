/**
 * @file The check-engine end-to-end tests (check-engine-tests.test.ts), CGLAB-420: answering warnings, on-card-branch, and a parent's review of its children.
 * Split out so the parts run side by side (GH-274); the harness is helpers/engineTests.ts.
 */
import { describe, it, expect, vi } from 'vitest';
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
  AUTHOR,
  REPORT,
  agent,
  answers,
  atBuild,
  atSpecs,
  byId,
  card,
  flow,
  honestTests,
  impl,
  internal,
  item,
  makeRepo,
  project,
  refused,
  reviewed,
  tddSteps,
  useEngineServer,
  validate,
  write,
} from './helpers/engineTests';

useEngineServer('check-engine-tests-children-test-db.sqlite');

describe('CGLAB-420: field findings from CGLAB-419', () => {
  describe('a warning on the step that writes tests is answered before the card leaves', () => {
    it('refuses an answer to a check this step does not have', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      const r = await validate(id, answers('no-such-check'));
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/no-such-check/);
    });

    it('a failing warning on the coding step still does not block', async () => {
      const { dir, id } = await atBuild({ BUILD: [{ id: 'new-tests-born-green' }] });
      impl(dir, { add: 'ok', mul: '12' });
      write(dir, 'tests/extra.test.js', 'T extra_green add=ok\n'); // green on arrival, on the coding step
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(byId((await item(id)).lastChecks.results, 'new-tests-born-green')).toMatchObject({ outcome: 'fail', blocking: false });
    });

    it('red on an error needs no answer: the code is simply not written yet', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir); // mul is missing: red-is-assertion fails, as it does on most honest cards
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    it('a person\'s pass of one born-green failure does not pass a different one later', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n'); // born green
      // Refused while nobody answered it, saying how to answer it.
      expect((await refused(id, 'new-tests-born-green')).detail).toMatch(/--check-note new-tests-born-green=/);
      const o = await agent().post(`/items/${id}/overrides`).set({ 'x-agenfk-ui': '1' }).send({ checkId: 'new-tests-born-green', reason: 'fine' });
      expect(o.status, JSON.stringify(o.body)).toBe(201);
      write(dir, 'tests/b.test.js', 'T add_thrice add=ok\n'); // a second test green on arrival
      await refused(id, 'new-tests-born-green');
    });
  });

  describe('on-card-branch judges the branch when none is recorded', () => {
    async function keyed(branch: string | null) {
      const dir = makeRepo();
      const pid = await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT });
      const id = await card(pid, 'START', { externalId: 'ABC-7' });
      if (branch) execSync(`git checkout -q -b ${branch}`, { cwd: dir });
      return id;
    }

    it('refuses a branch that carries none of the card\'s keys', async () => {
      const c = await refused(await keyed('feat/OTHER-9_theirs'), 'on-card-branch');
      expect(c.detail).toMatch(/feat\/OTHER-9_theirs/);
      expect(c.detail).toMatch(/ABC-7/);
    });

    it('passes on a branch that carries the card\'s key, saying so', async () => {
      const id = await keyed('feat/ABC-7_mine');
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(byId((await item(id)).lastChecks.results, 'on-card-branch').detail).toMatch(/ABC-7/);
    });

  });

  describe('a parent\'s review sees what its children recorded', () => {
    /** A story with one task, the task walked honestly to its end: the story stops at its review step. */
    async function storyAtLook() {
      const dir = makeRepo();
      const pid = await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT });
      const story = (await agent().post('/items').send({ type: 'STORY', title: 'the story', projectId: pid })).body.id as string;
      await storage.updateItem(story, { status: 'START' } as any);
      const task = (await agent().post('/items').send({ type: 'TASK', title: 'the task', projectId: pid, parentId: story })).body.id as string;
      await storage.updateItem(task, { status: 'START' } as any);
      for (const expected of ['ASK', 'SPECS']) expect((await validate(task, AUTHOR)).status).toBe(200);
      honestTests(dir);
      write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n'); // add_again: born green
      expect((await validate(task, { ...AUTHOR, ...answers('new-tests-born-green', 'red-is-assertion') })).status).toBe(200);
      impl(dir, { add: 'ok', mul: '12' });
      // The reply of the verify that brought the story onto its review step.
      let arrived: any;
      for (const expected of ['TIDY', 'LOOK', 'FINISHED']) {
        const was = (await item(story)).status;
        const r = await validate(task, AUTHOR);
        expect(r.status, `${expected}: ${JSON.stringify(r.body)}`).toBe(200);
        if (was !== 'LOOK' && (await item(story)).status === 'LOOK') arrived = r;
      }
      expect((await item(story)).status).toBe('LOOK');
      expect(arrived, 'no verify brought the story onto LOOK').toBeDefined();
      return { dir, story, task, last: arrived };
    }

    /*
     * One story walked to its review step, then everything its review reads off the children:
     * the hand-over in the verify that brought it there, the tree's warnings for the PR (with
     * answers, and which held the card - fe3ca491), the review step's own tree-warnings check,
     * and tests-added-late judged against the children's freezes.
     */
    it('the parent\'s review sees its children\'s warnings, answers and frozen tests', async () => {
      const { dir, story, task, last } = await storyAtLook();
      // The verify that brings the parent to its review hands over the tree's warnings, with their answers.
      expect(last.body.message).toMatch(/the story/);
      expect(last.body.message).toMatch(/reviewer/i);
      expect(last.body.message).toMatch(/add_again/);
      expect(last.body.message).toMatch(/answered: new-tests-born-green/);

      // The tree's warnings for the PR, each with its answer, and which held the card.
      const ws = (await agent().get(`/items/${story}/warnings`)).body;
      expect(ws).toEqual(expect.arrayContaining([
        expect.objectContaining({ itemId: task, check: 'new-tests-born-green', step: 'SPECS', answer: 'answered: new-tests-born-green', held: true }),
        expect.objectContaining({ itemId: task, check: 'red-is-assertion', held: false }),
      ]));

      // The parent's review step lists its children's warnings on its own checks (held here: no review yet).
      const held = await validate(story, AUTHOR);
      expect(held.status, JSON.stringify(held.body)).toBe(422);
      const w = byId((await item(story)).lastChecks.results, 'tree-warnings');
      expect(w).toMatchObject({ outcome: 'fail', blocking: false });
      expect(w.detail).toMatch(/add_again/);

      // tests-added-late reads the children's frozen tests at the parent, and names a test file added after.
      write(dir, 'tests/late.test.js', 'T late_one add=ok\n');
      await reviewed(story, dir);
      const r = await validate(story, AUTHOR);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const late = byId((await item(story)).stepRecords.filter((x: any) => x.kind === 'exit' && x.step === 'LOOK').pop().checks, 'tests-added-late');
      expect(late.outcome).toBe('fail');
      expect(late.detail).toMatch(/tests\/late\.test\.js/);
      expect(late.detail).not.toMatch(/tests\/mul\.test\.js/);
    });

    it('the brief reaches the CLI\'s async verify too', async () => {
      const dir = makeRepo();
      const pid = await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT });
      const story = (await agent().post('/items').send({ type: 'STORY', title: 'the async story', projectId: pid })).body.id as string;
      const task = (await agent().post('/items').send({ type: 'TASK', title: 'the task', projectId: pid, parentId: story })).body.id as string;
      await storage.updateItem(story, { status: 'START' } as any);
      await storage.updateItem(task, { status: 'START' } as any);
      for (const expected of ['ASK', 'SPECS']) expect((await validate(task, AUTHOR)).status).toBe(200);
      honestTests(dir);
      write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n');
      expect((await validate(task, { ...AUTHOR, ...answers('new-tests-born-green', 'red-is-assertion') })).status).toBe(200);
      impl(dir, { add: 'ok', mul: '12' });
      expect((await validate(task, AUTHOR)).status).toBe(200); // TIDY
      const v = await validate(task, { ...AUTHOR, async: true }); // TIDY -> LOOK, as the CLI sends it
      let run: any = v.body;
      for (let i = 0; i < 200 && (!run || run.status === 'running' || run.runId); i++) {
        run = (await agent().get(`/items/validate-runs/${v.body.runId}`).set(internal())).body;
        if (run.status !== 'running') break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect((await item(story)).status).toBe('LOOK');
      expect(run.message ?? v.body.message).toMatch(/the async story[\s\S]*add_again/);
    });

    // Review of fe3ca491: a record written before the flag is judged by the rule - the answer-required warning held.
    it('classifies warnings on records from before the flag: the answer-required one held, an advisory one did not', async () => {
      const pid = await project(await flow(tddSteps()));
      const c = await card(pid, 'START');
      const old = { step: 'SPECS', kind: 'exit', at: '2026-09-01T00:00:00.000Z', checks: [
        { id: 'new-tests-born-green', severity: 'warn', outcome: 'fail', detail: 'add_again passed before any code', overridden: { by: 'board', reason: 'pinned on purpose' } },
        { id: 'on-card-branch', severity: 'warn', outcome: 'fail', detail: "the tree is on 'a', but the card's branch is 'b'" },
      ] };
      await storage.updateItem(c, { stepRecords: [old] } as any);
      const ws = (await agent().get(`/items/${c}/warnings`)).body;
      expect(ws).toEqual(expect.arrayContaining([
        expect.objectContaining({ check: 'new-tests-born-green', held: true, answer: expect.stringMatching(/pinned on purpose/) }),
        expect.objectContaining({ check: 'on-card-branch', held: false }),
      ]));
    });

    it('a test file one task committed after its freeze is late at the parent, though a later task\'s freeze holds it', async () => {
      const dir = makeRepo();
      const pid = await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT });
      const story = (await agent().post('/items').send({ type: 'STORY', title: 'two tasks', projectId: pid })).body.id as string;
      await storage.updateItem(story, { status: 'START' } as any);
      const walk = async (task: string, tests: () => void, during: () => void) => {
        for (const _ of ['ASK', 'SPECS']) expect((await validate(task, AUTHOR)).status).toBe(200);
        tests();
        expect((await validate(task, AUTHOR)).status).toBe(200);
        during();
        for (const _ of ['TIDY', 'LOOK', 'FINISHED']) expect((await validate(task, AUTHOR)).status).toBe(200);
      };
      const a = (await agent().post('/items').send({ type: 'TASK', title: 'a', projectId: pid, parentId: story })).body.id as string;
      await storage.updateItem(a, { status: 'START' } as any);
      await walk(a, () => honestTests(dir), () => {
        impl(dir, { add: 'ok', mul: '12' });
        write(dir, 'tests/sneaky.test.js', 'T sneaky add=ok\n'); // added after a's tests were frozen
        execSync(`git add -A && git commit -qm "close(task): a [${a}]"`, { cwd: dir, shell: posixShell() });
      });
      const b = (await agent().post('/items').send({ type: 'TASK', title: 'b', projectId: pid, parentId: story })).body.id as string;
      await storage.updateItem(b, { status: 'START' } as any);
      await walk(b, () => write(dir, 'tests/c.test.js', 'T sub_works sub=ok\n'), () => impl(dir, { add: 'ok', mul: '12', sub: 'ok' }));
      expect((await item(story)).status).toBe('LOOK');
      await reviewed(story, dir);
      await validate(story, AUTHOR);
      const late = byId((await item(story)).lastChecks.results, 'tests-added-late');
      expect(late.outcome).toBe('fail');
      expect(late.detail).toMatch(/tests\/sneaky\.test\.js/);
      expect(late.detail).not.toMatch(/tests\/c\.test\.js/);
    });

  });
});
