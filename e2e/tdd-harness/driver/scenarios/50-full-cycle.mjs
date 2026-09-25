/**
 * T6: one card through the WHOLE shipped TDD flow, TODO -> DONE, on every
 * runner. The flow is the real TDD_FLOW_PRESET from this build's
 * @agenfk/core, not a copy, so a change to the preset is exercised here.
 *
 * The card is worked the way an honest agent works it: a JIRA key its branch
 * carries, a person's go-ahead on DISCOVERY (the harness plays the board), a
 * red test on CREATE_UNIT_TESTS, the code on IN_PROGRESS, a tidy that leaves
 * the tests alone on REFACTOR, an independent review on REVIEW, and its own
 * files staged before the project's verify command lands it on DONE. Every
 * step must let it go with no blocking check, and DONE must leave a close
 * commit.
 */
import { createRequire } from 'node:module';
import { newProject, newCard, card, verify, update, write } from '../cards.mjs';
import { board, AUTHOR, transcript, record, firstCommit } from '../gates.mjs';
import { sh } from '../lib.mjs';
import { RUNNER_NAMES, kit } from '../runners.mjs';

const { TDD_FLOW_PRESET } = createRequire(import.meta.url)('/agenfk/packages/core/dist/index.js');
const BRANCH = 'feat/ABC-12_widget';

/** What the card does on each step before it is verified off it. */
const WORK = {
  TODO: async ({ id, dir }) => { await update(id, { jiraItem: 'ABC-12', branchName: BRANCH }); sh(`git checkout -q -b ${BRANCH}`, dir); },
  DISCOVERY: async ({ id }) => {
    const a = await board('POST', `/items/${id}/approvals`, { step: 'DISCOVERY', note: 'scope agreed' });
    if (a.status !== 201) throw new Error(`approval refused (${a.status}): ${JSON.stringify(a.body)}`);
  },
  CREATE_UNIT_TESTS: ({ dir, k }) => write(dir, k.tests('extra', [['multiplies', 'red']])),
  IN_PROGRESS: ({ dir, k }) => write(dir, k.implement()),
  REFACTOR: ({ dir, k }) => write(dir, { [k.src]: `${k.comment} tidied\n${k.source({ mul: true })}` }),
  REVIEW: async ({ id, dir, k }) => {
    const r = await record(id, { transcript: transcript(), range: `${firstCommit(dir)}..HEAD` });
    if (r.status !== 201) throw new Error(`review refused (${r.status}): ${JSON.stringify(r.body)}`);
    // Its own files only, as the close commit takes the index.
    sh(`git add ${k.src} ${k.paths.extra}`, dir);
  },
};

async function fullCycle(runner) {
  const k = kit(runner);
  const project = await newProject({ steps: TDD_FLOW_PRESET.steps, runner });
  const id = await newCard(project, { title: `full cycle on ${runner}` });
  const ctx = { id, dir: project.dir, k };
  const trail = [];
  for (let guard = 0; guard < 10; guard++) {
    const before = (await card(id)).status;
    if (before === 'DONE') break;
    if (WORK[before]) await WORK[before](ctx);
    const r = await verify(id, { actor: AUTHOR, evidence: `harness: ${before} done` });
    const c = await card(id);
    const results = c.lastChecks?.step === before ? c.lastChecks.results ?? [] : [];
    const blocking = results.filter(x => x.blocking).map(x => `${x.id}: ${x.detail}`);
    trail.push(`${before}->${c.status} [${results.map(x => `${x.id}:${x.outcome}`).join(' ')}]`);
    if (r.status !== 200 || c.status === before) {
      return { actual: `stuck on ${before}`, detail: `verify ${r.status}: ${blocking.join(' | ') || JSON.stringify(r.body).slice(0, 300)} [${trail.join(', ')}]` };
    }
    // A fresh card on the shipped flow has every record its checks need: a
    // check that could not judge, or did not apply, would make this pass by default.
    const hollow = results.filter(x => x.outcome === 'n/a' || x.outcome === 'unavailable');
    if (hollow.length) return { actual: `hollow on ${before}`, detail: `${hollow.map(x => `${x.id}: ${x.outcome} - ${x.detail}`).join(' | ')} [${trail.join(', ')}]` };
  }
  const c = await card(id);
  const log = sh('git log --format=%s -1', project.dir);
  const closed = c.status === 'DONE' && log.startsWith('close(task):') && log.includes(id);
  return { actual: closed ? 'done' : `ended on ${c.status}`, detail: `${trail.join(', ')}; last commit: ${log}` };
}

export const scenarios = (process.env.HARNESS_RUNNERS ? process.env.HARNESS_RUNNERS.split(',') : RUNNER_NAMES).map(runner => ({
  check: 'full-cycle',
  name: `[${runner}] a card goes TODO -> DONE on the shipped TDD flow, every check satisfied`,
  expected: 'done',
  run: () => fullCycle(runner),
}));
