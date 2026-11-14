/**
 * Custom checks (efcacdeb): a command the server runs in the card's tree, and
 * an instruction the coding agent carries out and reports on verify.
 *
 * A command check that asks for a person's approval is approved here with the
 * software passkey (gates.mjs), as a person would on the board. The registry
 * origin and the no-tree case stay with the server tests: this container
 * cannot install from a registry, and a card with no tree cannot leave TODO.
 */
import { api } from '../lib.mjs';
import { newProject, newCard, card, verify, outcomeOf, verdictOf } from '../cards.mjs';
import { board, AUTHOR, enroll, signed, token } from '../gates.mjs';
import { createHash } from 'node:crypto';

const flowWith = checks => [
  { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { name: 'WORK', label: 'Work', order: 1, checks },
  { name: 'NEXT', label: 'Next', order: 2 },
  { name: 'DONE', label: 'Done', order: 3, isAnchor: true },
];
const node = (code, ...args) => ['node', '-e', code, ...args];
const cmd = (argv, extra = {}) => ({ id: 'command-check', params: { name: 'lint', argv, ...extra } });
const DOCS = { id: 'agent-check', params: { name: 'docs', instruction: 'Check the README documents every new CLI flag.' } };

async function onWork(checks) {
  const project = await newProject({ steps: flowWith(checks) });
  const id = await newCard(project);
  const r = await verify(id, { actor: AUTHOR });
  if (r.status !== 200) throw new Error(`TODO -> WORK refused (${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`);
  return { project, id };
}
/** Verify off WORK - with the agent's reports, when given - and read one check. */
async function leave(id, checkId, agentChecks) {
  const r = await api('POST', `/items/${id}/validate`, { evidence: 'harness', actor: AUTHOR, ...(agentChecks ? { agentChecks } : {}) }, { headers: { 'x-agenfk-internal': token() } });
  const c = await card(id);
  const o = outcomeOf(c, checkId, 'WORK');
  return { actual: verdictOf(o, c.status !== 'WORK'), detail: `${o.detail ?? ''} [verify ${r.status}, card on ${c.status}]`, r, o };
}
const s = (check, name, expected, run) => ({ check, name, expected, run });
const hashOf = argv => createHash('sha256').update(JSON.stringify(argv)).digest('hex');

export const scenarios = [
  // command-check
  s('command-check', 'passes when the command exits 0, and the card moves', 'pass', async () => {
    const { id } = await onWork([cmd(node('process.exit(0)'))]);
    return leave(id, 'command-check:lint');
  }),
  s('command-check', 'blocks when the command fails, showing its output', 'fail', async () => {
    const { id } = await onWork([cmd(node("console.log('2 problems'); process.exit(1)"))]);
    const out = await leave(id, 'command-check:lint');
    return /2 problems/.test(out.o.detail ?? '') ? out : { ...out, actual: 'fail without the output' };
  }),
  s('command-check', 'runs without a shell: arguments arrive exactly as written', 'pass', async () => {
    const { id } = await onWork([cmd(node("process.exit(process.argv[1] === 'a && $HOME' ? 0 : 1)", 'a && $HOME'))]);
    return leave(id, 'command-check:lint');
  }),
  s('command-check', 'with approval: person, blocks until the exact command is approved', 'fail', async () => {
    const { id } = await onWork([cmd(node('process.exit(0)'), { approval: 'person' })]);
    return leave(id, 'command-check:lint');
  }),
  s('command-check', "with approval: person, refuses the board's word without a passkey", 'refused', async () => {
    await enroll();
    const { project } = await onWork([cmd(node('process.exit(0)'), { approval: 'person' })]);
    const r = await board('POST', `/projects/${project.id}/command-approvals`, { argv: node('process.exit(0)') });
    return { actual: r.status === 401 ? 'refused' : `answered ${r.status}`, detail: JSON.stringify(r.body).slice(0, 200) };
  }),
  s('command-check', 'with approval: person, runs once a person approved it with a passkey', 'pass', async () => {
    await enroll();
    const argv = node('process.exit(0)');
    const { project, id } = await onWork([cmd(argv, { approval: 'person' })]);
    const assertion = await signed({ purpose: 'command', itemId: project.id, checkId: hashOf(argv) });
    const a = await board('POST', `/projects/${project.id}/command-approvals`, { argv, assertion });
    if (a.status !== 201) throw new Error(`command approval refused (${a.status}): ${JSON.stringify(a.body)}`);
    return leave(id, 'command-check:lint');
  }),

  // agent-check
  s('agent-check', 'blocks until the agent reports it, naming the instruction', 'fail', async () => {
    const { id } = await onWork([DOCS]);
    const out = await leave(id, 'agent-check:docs');
    return out.o.detail?.includes(DOCS.params.instruction) ? out : { ...out, actual: 'fail without the instruction' };
  }),
  s('agent-check', 'passes on a pass report, labelled agent-reported, and the card moves', 'pass', async () => {
    const { id } = await onWork([DOCS]);
    const out = await leave(id, 'agent-check:docs', [{ name: 'docs', outcome: 'pass', note: 'README updated' }]);
    const labelled = ((await card(id)).lastChecks?.results ?? []).find(x => x.id === 'agent-check:docs')?.agentReported === true;
    return labelled ? out : { ...out, actual: 'pass, unlabelled' };
  }),
  s('agent-check', 'blocks on a fail report', 'fail', async () => {
    const { id } = await onWork([DOCS]);
    return leave(id, 'agent-check:docs', [{ name: 'docs', outcome: 'fail', note: 'two flags undocumented' }]);
  }),
  s('agent-check', 'refuses a report for an agent check the step does not have', 'refused', async () => {
    const { id } = await onWork([DOCS]);
    const out = await leave(id, 'agent-check:docs', [{ name: 'lint', outcome: 'pass' }]);
    return { actual: out.r.status === 400 ? 'refused' : `answered ${out.r.status}`, detail: JSON.stringify(out.r.body).slice(0, 200) };
  }),
];
