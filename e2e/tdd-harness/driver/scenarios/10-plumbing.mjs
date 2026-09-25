/**
 * The whole chain the check scenarios stand on: a project on its own flow, a
 * card verified onto a step, the step's capture running the sample's tests
 * through node:test's junit report, and the verdict read off the card.
 * suite-green is the check that needs all of it.
 */
import { newProject, newCard, verify, card, outcomeOf, write } from '../cards.mjs';
import { sh } from '../lib.mjs';

const steps = [
  { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { name: 'WORK', label: 'Work', order: 1, checks: [{ id: 'suite-green' }] },
  { name: 'NEXT', label: 'Next', order: 2 },
  { name: 'DONE', label: 'Done', order: 3, isAnchor: true },
];

/** A card on WORK of a fresh project, ready to be verified off it. */
async function cardOnWork(prepare) {
  const project = await newProject({ steps });
  if (prepare) prepare(project.dir);
  const id = await newCard(project);
  const toWork = await verify(id);
  if (toWork.status !== 200) throw new Error(`TODO -> WORK refused (${toWork.status}): ${JSON.stringify(toWork.body).slice(0, 300)}`);
  return { project, id };
}

async function leaveWork(id) {
  const r = await verify(id);
  const c = await card(id);
  const o = outcomeOf(c, 'suite-green', 'WORK');
  return { actual: o.outcome, detail: `${o.detail ?? ''} [verify ${r.status}, card on ${c.status}]` };
}

export const scenarios = [
  {
    name: 'suite-green passes when the sample suite is green',
    check: 'suite-green', expected: 'pass',
    run: async () => { const { id } = await cardOnWork(); return leaveWork(id); },
  },
  {
    name: 'suite-green blocks a red suite, and the card stays',
    check: 'suite-green', expected: 'fail',
    run: async () => {
      const { id } = await cardOnWork(dir => {
        write(dir, { 'test/broken.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('is red', () => assert.equal(1, 2));\n" });
        sh('git add -A && git commit -qm red', dir);
      });
      return leaveWork(id);
    },
  },
];
