/**
 * Projects, cards and verify, the way an agent meets them.
 *
 * Every scenario gets its own sample project: a git repository holding a tiny
 * package on one of the runners in runners.mjs, writing that runner's test
 * report, the project wired to its own flow. Nothing is shared between scenarios, so each check is
 * seen in isolation.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { api, sh, HOME } from './lib.mjs';
import { RUNNERS, kit } from './runners.mjs';

/** One check's verdict as verify recorded it on the card: `absent` when it did not run. */
export function outcomeOf(card, checkId, step) {
  const last = card?.lastChecks;
  if (!last || (step && last.step !== step)) return { outcome: 'absent', detail: 'no checks recorded for that step' };
  const r = (last.results ?? []).find(x => x.id === checkId);
  if (!r) return { outcome: 'absent', detail: `${checkId} did not run on ${last.step}` };
  if (r.overridden) return { outcome: 'overridden', detail: r.detail, blocking: r.blocking };
  return { outcome: r.outcome, detail: r.detail, blocking: r.blocking };
}

/**
 * A verdict and what it did to the card, as one word a scenario expects. A
 * blocking fail or unavailable holds the card; a non-blocking one (a `warn`
 * check, or a card that predates checks) lets it move. A block whose card
 * moved anyway is its own outcome, and never an expected one.
 */
export function verdictOf(o, moved) {
  if (o.outcome !== 'fail' && o.outcome !== 'unavailable') return o.outcome;
  if (o.blocking) return moved ? `${o.outcome}-but-moved` : o.outcome;
  return o.outcome === 'fail' ? 'warn' : 'unavailable-soft';
}

const token = () => readFileSync(join(HOME, '.agenfk', 'verify-token'), 'utf8').trim();
const internal = () => ({ 'x-agenfk-internal': token() });

/** The node sample: what the plumbing and git scenarios use. */
export const SAMPLE = kit('node').sample();
export const TEST_COMMAND = RUNNERS.node.command;

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
 * leaves the project without one (per-test checks are then unavailable), and
 * `declare: false` leaves its test report without declared test paths.
 */
export async function newProject({ steps, runner = 'node', files = kit(runner).sample(), testReport = true, declare = true, verifyCommand = RUNNERS[runner].command, root = true } = {}) {
  const n = ++seq;
  const dir = `/work/projects/p${n}`;
  mkdirSync(dir, { recursive: true });
  write(dir, files);
  RUNNERS[runner].setup(dir);
  sh('git init -q && git add -A && git commit -qm initial', dir);
  const flow = await api('POST', '/flows', { name: `harness-flow-${n}`, steps });
  if (flow.status !== 201) throw new Error(`flow refused (${flow.status}): ${JSON.stringify(flow.body)}`);
  const project = await api('POST', '/projects', { name: `harness-${n}-${runner}` });
  if (project.status >= 300) throw new Error(`project refused (${project.status}): ${JSON.stringify(project.body)}`);
  const id = project.body.id;
  const must = async (label, p) => { const r = await p; if (r.status >= 300) throw new Error(`${label} refused (${r.status}): ${JSON.stringify(r.body)}`); return r; };
  // `root: false` leaves the project with no tree: the checks that read git are then unavailable.
  if (root) await must('project root', api('PUT', `/projects/${id}/project-root`, { projectRoot: dir }, { headers: internal() }));
  await must('flow', api('POST', `/projects/${id}/flow`, { flowId: flow.body.id }));
  if (verifyCommand) await must('verify command', api('PUT', `/projects/${id}/verify-command`, { verifyCommand }, { headers: internal() }));
  if (testReport) {
    // `declare: false` leaves out the test paths a runner's report cannot name.
    const surface = declare && RUNNERS[runner].surface ? { surface: RUNNERS[runner].surface } : {};
    await must('test report', setTestReport(id, { ...RUNNERS[runner].report, command: RUNNERS[runner].command, ...surface }));
  }
  return { id, dir, flowId: flow.body.id, flow: flow.body, runner };
}

/** Replace the project's test report setting (a scenario may break it mid-walk). */
export const setTestReport = (projectId, setting) => api('PUT', `/projects/${projectId}/test-report`, setting, { headers: internal() });

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

/**
 * Walk a card through a flow and read one check's verdict on leaving `at`.
 *
 * The card is verified off every step before `at`; `work[step]` runs while
 * the card is on that step, before it is verified off it. Every step before
 * `at` must let the card go - a refusal there is a broken scenario, not a
 * verdict. `predates: true` walks the card to `at` on the same flow with no
 * checks at all and only then gives the steps theirs, so the card is on `at`
 * with no entry record and no records from earlier steps: a card that
 * predates checks.
 */
export async function walk(checkId, { steps, at, runner = 'node', project: projectOpts = {}, card: cardOpts = {}, before, work = {}, predates = false, command } = {}) {
  const project = await newProject({ steps: predates ? steps.map(({ checks, role, ...s }) => s) : steps, runner, ...projectOpts });
  const k = kit(runner);
  const id = await newCard(project, cardOpts);
  const ctx = { project, id, dir: project.dir, kit: k, write: files => write(project.dir, files), sh: cmd => sh(cmd, project.dir) };
  if (before) await before(ctx);
  const order = [...steps].sort((x, y) => x.order - y.order).map(s => s.name);
  for (const step of order.slice(0, order.indexOf(at))) {
    if (work[step]) await work[step](ctx);
    const r = await verify(id);
    const c = await card(id);
    if (r.status !== 200 || c.status === step) throw new Error(`${step} -> next refused (${r.status}): ${JSON.stringify(r.body).slice(0, 400)}`);
  }
  if (predates) {
    // The flow as the scenario wrote it, by the stored steps' ids: the card is already on `at`.
    const stored = project.flow.steps;
    const given = new Map(steps.map(s => [s.name, s]));
    const put = await api('PUT', `/flows/${project.flowId}`, { steps: stored.map(s => ({ ...s, ...(given.get(s.name)?.checks ? { checks: given.get(s.name).checks } : {}), ...(given.get(s.name)?.role ? { role: given.get(s.name).role } : {}) })) });
    if (put.status >= 300) throw new Error(`flow update refused (${put.status}): ${JSON.stringify(put.body)}`);
  }
  if (work[at]) await work[at](ctx);
  const r = await verify(id, command ? { command } : {});
  const c = await card(id);
  const o = outcomeOf(c, checkId, at);
  return { actual: verdictOf(o, c.status !== at), detail: `${o.detail ?? ''} [verify ${r.status}, card on ${c.status}]`, card: c, response: r };
}
