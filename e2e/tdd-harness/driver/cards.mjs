/**
 * Projects, cards and verify, the way an agent meets them.
 *
 * Every scenario gets its own sample project: a git repository holding a tiny
 * node package whose tests run on node:test and write junit-xml, the project
 * wired to its own flow. Nothing is shared between scenarios, so each check is
 * seen in isolation.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { api, sh, HOME } from './lib.mjs';

/** One check's verdict as verify recorded it on the card: `absent` when it did not run. */
export function outcomeOf(card, checkId, step) {
  const last = card?.lastChecks;
  if (!last || (step && last.step !== step)) return { outcome: 'absent', detail: 'no checks recorded for that step' };
  const r = (last.results ?? []).find(x => x.id === checkId);
  if (!r) return { outcome: 'absent', detail: `${checkId} did not run on ${last.step}` };
  if (r.overridden) return { outcome: 'overridden', detail: r.detail, blocking: r.blocking };
  return { outcome: r.outcome, detail: r.detail, blocking: r.blocking };
}

const token = () => readFileSync(join(HOME, '.agenfk', 'verify-token'), 'utf8').trim();
const internal = () => ({ 'x-agenfk-internal': token() });

/** The sample package: one module and one green test. */
export const SAMPLE = {
  'package.json': JSON.stringify({ name: 'sample', version: '1.0.0', type: 'module' }, null, 2) + '\n',
  '.gitignore': '.reports/\n',
  'src/math.js': 'export const add = (a, b) => a + b;\n',
  'test/math.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\n",
};
// No path argument: node 22 runs a `test/` argument as a FILE (one failing
// test named "test"); with none it finds the *.test.js files itself. The
// reporter does not create its directory, and .reports/ is gitignored.
export const TEST_COMMAND = 'mkdir -p .reports && node --test --test-reporter=junit --test-reporter-destination=.reports/junit.xml';

export function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

let seq = 0;
/**
 * A fresh project on its own flow. `steps` is the flow; `testReport: false`
 * leaves the project without one (per-test checks are then unavailable).
 */
export async function newProject({ steps, files = SAMPLE, testReport = true, verifyCommand = TEST_COMMAND, root = true } = {}) {
  const n = ++seq;
  const dir = `/work/projects/p${n}`;
  mkdirSync(dir, { recursive: true });
  write(dir, files);
  sh('git init -q && git add -A && git commit -qm initial', dir);
  const flow = await api('POST', '/flows', { name: `harness-flow-${n}`, steps });
  if (flow.status !== 201) throw new Error(`flow refused (${flow.status}): ${JSON.stringify(flow.body)}`);
  const project = await api('POST', '/projects', { name: `harness-${n}` });
  if (project.status >= 300) throw new Error(`project refused (${project.status}): ${JSON.stringify(project.body)}`);
  const id = project.body.id;
  const must = async (label, p) => { const r = await p; if (r.status >= 300) throw new Error(`${label} refused (${r.status}): ${JSON.stringify(r.body)}`); return r; };
  // `root: false` leaves the project with no tree: the checks that read git are then unavailable.
  if (root) await must('project root', api('PUT', `/projects/${id}/project-root`, { projectRoot: dir }, { headers: internal() }));
  await must('flow', api('POST', `/projects/${id}/flow`, { flowId: flow.body.id }));
  if (verifyCommand) await must('verify command', api('PUT', `/projects/${id}/verify-command`, { verifyCommand }, { headers: internal() }));
  if (testReport) {
    await must('test report', api('PUT', `/projects/${id}/test-report`, { format: 'junit-xml', command: TEST_COMMAND, reportPath: '.reports/junit.xml' }, { headers: internal() }));
  }
  return { id, dir, flowId: flow.body.id };
}

/** A card on the project; `status` places it on a step directly (setup, not a transition). */
export async function newCard(project, { type = 'TASK', title, parentId, status, ...rest } = {}) {
  const c = await api('POST', '/items', { type, title: title ?? `card ${++seq}`, projectId: project.id, ...(parentId ? { parentId } : {}), ...rest });
  if (c.status >= 300) throw new Error(`card refused (${c.status}): ${JSON.stringify(c.body)}`);
  return c.body.id;
}

export const card = async id => (await api('GET', `/items/${id}`)).body;

/**
 * Advance a card as `agenfk verify` does: the internal token, synchronously.
 * `actor` identifies the harness session (the review check tells authors from
 * reviewers by it).
 */
export async function verify(id, { evidence = 'harness', command, actor } = {}) {
  return api('POST', `/items/${id}/validate`, { evidence, ...(command ? { command } : {}), ...(actor ? { actor } : {}) }, { headers: internal() });
}

export const update = (id, patch) => api('PUT', `/items/${id}`, patch);

const WORK_FLOW = checks => [
  { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { name: 'WORK', label: 'Work', order: 1, checks },
  { name: 'NEXT', label: 'Next', order: 2 },
  { name: 'DONE', label: 'Done', order: 3, isAnchor: true },
];

/**
 * The shape of most check scenarios: `check` is the only thing on WORK; a card
 * is verified onto WORK, `prepare` sets the tree and the card up, then the
 * card is verified off WORK and the check's verdict is read off it.
 */
export async function checkOnWork(checkId, { params, project: projectOpts = {}, card: cardOpts = {}, prepare, before, at = 'WORK' } = {}) {
  const project = await newProject({ steps: WORK_FLOW([{ id: checkId, ...(params ? { params } : {}) }]), ...projectOpts });
  const id = await newCard(project, cardOpts);
  if (before) await before({ project, id, dir: project.dir });
  // Leaving TODO runs the entry guard (tree-clean, on-card-branch) on every
  // flow with checks: `at: 'TODO'` reads a check's verdict there instead.
  if (at === 'TODO') {
    const r = await verify(id);
    const c = await card(id);
    const o = outcomeOf(c, checkId, 'TODO');
    const actual = o.outcome === 'fail' && o.blocking && c.status !== 'TODO' ? 'fail-but-moved' : o.outcome;
    return { actual, detail: `${o.detail ?? ''} [verify ${r.status}, card on ${c.status}]`, card: c };
  }
  const toWork = await verify(id);
  if (toWork.status !== 200) throw new Error(`TODO -> WORK refused (${toWork.status}): ${JSON.stringify(toWork.body).slice(0, 300)}`);
  if (prepare) await prepare({ project, id, dir: project.dir });
  const r = await verify(id);
  const c = await card(id);
  const o = outcomeOf(c, checkId, 'WORK');
  // A blocking verdict must hold the card; one that reports fail and lets it
  // move is its own outcome, and never an expected one.
  const actual = o.outcome === 'fail' && o.blocking && c.status !== 'WORK' ? 'fail-but-moved' : o.outcome;
  return { actual, detail: `${o.detail ?? ''} [verify ${r.status}, card on ${c.status}]`, card: c };
}
