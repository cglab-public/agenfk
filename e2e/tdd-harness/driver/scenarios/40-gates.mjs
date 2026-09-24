/**
 * Human gates and review: human-approval, overrides, and review-record.
 *
 * The harness plays the board (the `x-agenfk-ui: 1` header the Kanban board
 * sends) and, on a passkey step, a software WebAuthn authenticator: a P-256
 * key made in this container, signing as a real authenticator does. Both only
 * ever talk to this container's throwaway server.
 *
 * human-approval has no `unavailable` outcome: it passes or waits for a
 * person. The passkey store is server-wide, so the scenario that needs NO
 * passkey enrolled runs first, and one authenticator is enrolled once, after it.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, sh } from '../lib.mjs';
import { newProject, newCard, card, verify, update, outcomeOf, verdictOf, write } from '../cards.mjs';
import { board, AUTHOR, enroll, signed, transcript, token, record, commitWork, firstCommit } from '../gates.mjs';

const flowWith = checks => [
  { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { name: 'WORK', label: 'Work', order: 1, checks },
  { name: 'NEXT', label: 'Next', order: 2 },
  { name: 'DONE', label: 'Done', order: 3, isAnchor: true },
];

/** A card of a fresh project, verified onto WORK by `actor`. */
async function onWork(checks, { type = 'TASK', actor = AUTHOR, parentOf, project: given } = {}) {
  const project = given ?? await newProject({ steps: flowWith(checks) });
  const id = await newCard(project, { type, ...(parentOf ? { parentId: parentOf } : {}) });
  const r = await verify(id, { actor });
  if (r.status !== 200) throw new Error(`TODO -> WORK refused (${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`);
  return { project, id, dir: project.dir };
}

/** Verify off WORK and read one check's verdict. */
async function leave(id, checkId, { actor = AUTHOR } = {}) {
  const r = await verify(id, { actor });
  const c = await card(id);
  const o = outcomeOf(c, checkId, 'WORK');
  return { actual: verdictOf(o, c.status !== 'WORK'), detail: `${o.detail ?? ''} [verify ${r.status}, card on ${c.status}]` };
}

/** A refusal the harness expects from an endpoint: 'refused' when its status is `code`. */
const refusedWith = (code, r, why) => ({
  actual: r.status === code && (!why || why.test(JSON.stringify(r.body))) ? 'refused' : `answered ${r.status}`,
  detail: JSON.stringify(r.body).slice(0, 200),
});

const s = (check, name, expected, run) => ({ check, name, expected, run });

const APPROVE = [{ id: 'human-approval' }];
const REVIEW = [{ id: 'review-record' }];
const JIRA = [{ id: 'jira-key-valid' }];

export const scenarios = [
  // ── human-approval ────────────────────────────────────────────────────────
  s('human-approval', 'blocks until a person approves', 'fail', async () => {
    const { id } = await onWork(APPROVE);
    return leave(id, 'human-approval');
  }),
  s('human-approval', 'passes once a person approved on the board', 'pass', async () => {
    const { id } = await onWork(APPROVE);
    const a = await board('POST', `/items/${id}/approvals`, { step: 'WORK' });
    if (a.status !== 201) throw new Error(`approval refused (${a.status}): ${JSON.stringify(a.body)}`);
    return leave(id, 'human-approval');
  }),
  s('human-approval', 'refuses an approval without the board header: an agent cannot approve', 'refused', async () => {
    const { id } = await onWork(APPROVE);
    return refusedWith(403, await api('POST', `/items/${id}/approvals`, { step: 'WORK' }));
  }),
  s('human-approval', "refuses an approval carrying the agent's own token, even with the board header", 'refused', async () => {
    const { id } = await onWork(APPROVE);
    return refusedWith(403, await api('POST', `/items/${id}/approvals`, { step: 'WORK' }, { board: true, headers: { 'x-agenfk-internal': token() } }));
  }),
  // A go-ahead covers the card and its children as they are when a person gives it.
  s('human-approval', "passes a child on its parent's go-ahead for the same step", 'pass', async () => {
    const parent = await onWork(APPROVE, { type: 'STORY' });
    const child = await onWork(APPROVE, { project: parent.project, parentOf: parent.id });
    await board('POST', `/items/${parent.id}/approvals`, { step: 'WORK' });
    return leave(child.id, 'human-approval');
  }),
  s('human-approval', "does not cover a child added after the parent's go-ahead", 'fail', async () => {
    const parent = await onWork(APPROVE, { type: 'STORY' });
    await board('POST', `/items/${parent.id}/approvals`, { step: 'WORK' });
    const child = await onWork(APPROVE, { project: parent.project, parentOf: parent.id });
    return leave(child.id, 'human-approval');
  }),
  s('human-approval', 'with appliesTo every-card, a child needs its own approval', 'fail', async () => {
    const checks = [{ id: 'human-approval', params: { appliesTo: 'every-card' } }];
    const parent = await onWork(checks, { type: 'STORY' });
    const child = await onWork(checks, { project: parent.project, parentOf: parent.id });
    await board('POST', `/items/${parent.id}/approvals`, { step: 'WORK' });
    return leave(child.id, 'human-approval');
  }),
  // Runs before any passkey is enrolled.
  s('human-approval', 'on a passkey step, refuses any approval while no passkey is enrolled', 'refused', async () => {
    const { id } = await onWork([{ id: 'human-approval', params: { signature: 'passkey' } }]);
    return refusedWith(401, await board('POST', `/items/${id}/approvals`, { step: 'WORK' }));
  }),
  s('human-approval', "on a passkey step, refuses the board's word alone once a passkey is enrolled", 'refused', async () => {
    await enroll();
    const { id } = await onWork([{ id: 'human-approval', params: { signature: 'passkey' } }]);
    return refusedWith(401, await board('POST', `/items/${id}/approvals`, { step: 'WORK' }));
  }),
  s('human-approval', 'on a passkey step, passes an approval signed with the passkey', 'pass', async () => {
    await enroll();
    const { id } = await onWork([{ id: 'human-approval', params: { signature: 'passkey' } }]);
    const assertion = await signed({ purpose: 'approval', itemId: id, step: 'WORK' });
    const a = await board('POST', `/items/${id}/approvals`, { step: 'WORK', assertion });
    if (a.status !== 201) throw new Error(`signed approval refused (${a.status}): ${JSON.stringify(a.body)}`);
    return leave(id, 'human-approval');
  }),
  s('human-approval', 'on a passkey step, refuses a signature made for another card', 'refused', async () => {
    await enroll();
    const { project, id } = await onWork([{ id: 'human-approval', params: { signature: 'passkey' } }]);
    const other = await onWork([{ id: 'human-approval', params: { signature: 'passkey' } }], { project });
    const assertion = await signed({ purpose: 'approval', itemId: other.id, step: 'WORK' });
    return refusedWith(401, await board('POST', `/items/${id}/approvals`, { step: 'WORK', assertion }));
  }),

  // ── overrides ─────────────────────────────────────────────────────────────
  s('override', 'lifts a blocking check, with the reason on record, and the card moves', 'overridden', async () => {
    const { id } = await onWork(JIRA);
    await leave(id, 'jira-key-valid'); // blocked: no key
    const o = await board('POST', `/items/${id}/overrides`, { step: 'WORK', checkId: 'jira-key-valid', reason: 'spike, no ticket' });
    if (o.status !== 201) throw new Error(`override refused (${o.status}): ${JSON.stringify(o.body)}`);
    const r = await verify(id, { actor: AUTHOR });
    const c = await card(id);
    const got = outcomeOf(c, 'jira-key-valid', 'WORK');
    return { actual: got.outcome === 'overridden' && c.status === 'NEXT' ? 'overridden' : `${got.outcome}, card on ${c.status}`, detail: `[verify ${r.status}]` };
  }),
  s('override', 'is refused for a check that is not blocking the card', 'refused', async () => {
    const { id } = await onWork(JIRA);
    return refusedWith(409, await board('POST', `/items/${id}/overrides`, { step: 'WORK', checkId: 'jira-key-valid', reason: 'r' }));
  }),
  s('override', 'is refused for an agent', 'refused', async () => {
    const { id } = await onWork(JIRA);
    await leave(id, 'jira-key-valid');
    return refusedWith(403, await api('POST', `/items/${id}/overrides`, { step: 'WORK', checkId: 'jira-key-valid', reason: 'r' }));
  }),
  s('override', 'covers only the failure it was given against: a new one blocks again', 'fail', async () => {
    const { id, dir } = await onWork(JIRA);
    await leave(id, 'jira-key-valid'); // no key at all
    await board('POST', `/items/${id}/overrides`, { step: 'WORK', checkId: 'jira-key-valid', reason: 'spike' });
    // Now: a key its branch does not carry (the tree follows the branch, so only jira-key-valid judges).
    await update(id, { branchName: 'feat/XYZ-1_other', jiraItem: 'ABC-12' });
    sh('git checkout -q -b feat/XYZ-1_other', dir);
    return leave(id, 'jira-key-valid');
  }),
  s('override', 'on a passkey step, needs a signature too', 'refused', async () => {
    await enroll();
    const { id } = await onWork([...JIRA, { id: 'human-approval', params: { signature: 'passkey' } }]);
    await leave(id, 'jira-key-valid');
    return refusedWith(401, await board('POST', `/items/${id}/overrides`, { step: 'WORK', checkId: 'jira-key-valid', reason: 'spike' }));
  }),
  s('override', 'on a passkey step, a signed override lifts the check', 'overridden', async () => {
    await enroll();
    const { id } = await onWork([...JIRA, { id: 'human-approval', params: { signature: 'passkey' } }]);
    await leave(id, 'jira-key-valid');
    const act = { purpose: 'override', itemId: id, step: 'WORK', checkId: 'jira-key-valid', reason: 'spike' };
    const o = await board('POST', `/items/${id}/overrides`, { step: 'WORK', checkId: 'jira-key-valid', reason: 'spike', assertion: await signed(act) });
    if (o.status !== 201) throw new Error(`signed override refused (${o.status}): ${JSON.stringify(o.body)}`);
    await verify(id, { actor: AUTHOR });
    const got = outcomeOf(await card(id), 'jira-key-valid', 'WORK');
    return { actual: got.outcome, detail: got.detail ?? '' };
  }),

  // ── review-record ─────────────────────────────────────────────────────────
  s('review-record', 'blocks a card nobody reviewed', 'fail', async () => {
    const { id, dir } = await onWork(REVIEW);
    commitWork(dir);
    return leave(id, 'review-record');
  }),
  s('review-record', 'passes an independent review over all of the work', 'pass', async () => {
    const { id, dir } = await onWork(REVIEW);
    const head = commitWork(dir);
    const r = await record(id, { transcript: transcript(), range: `${firstCommit(dir)}..${head}` });
    if (r.status !== 201) throw new Error(`review refused (${r.status}): ${JSON.stringify(r.body)}`);
    return leave(id, 'review-record');
  }),
  s('review-record', "passes a sub-agent of the author's own session: a separate agent reviewed", 'pass', async () => {
    const { id, dir } = await onWork(REVIEW);
    const head = commitWork(dir);
    await record(id, { transcript: transcript({ sessionId: AUTHOR.sessionId, agentId: 'reviewer1' }), range: `${firstCommit(dir)}..${head}` });
    return leave(id, 'review-record');
  }),
  s('review-record', 'blocks a review by the author itself', 'fail', async () => {
    const { id, dir } = await onWork(REVIEW);
    const head = commitWork(dir);
    await record(id, { transcript: transcript({ sessionId: AUTHOR.sessionId }), range: `${firstCommit(dir)}..${head}` });
    return leave(id, 'review-record');
  }),
  s('review-record', 'blocks a reviewer that ran agenfk verify: it is an author', 'fail', async () => {
    const { id, dir } = await onWork(REVIEW);
    const head = commitWork(dir);
    await record(id, { transcript: transcript({ tools: [{ name: 'Bash', input: { command: `agenfk verify ${id} --evidence x` } }] }), range: `${firstCommit(dir)}..${head}` });
    return leave(id, 'review-record');
  }),
  s('review-record', "blocks a reviewer that edited the card's tree", 'fail', async () => {
    const { id, dir } = await onWork(REVIEW);
    const head = commitWork(dir);
    await record(id, { transcript: transcript({ tools: [{ name: 'Edit', input: { file_path: join(dir, 'src/math.js') } }] }), range: `${firstCommit(dir)}..${head}` });
    return leave(id, 'review-record');
  }),
  s('review-record', 'blocks a review that starts after the work began', 'fail', async () => {
    const { id, dir } = await onWork(REVIEW);
    const mid = commitWork(dir, 1);
    const head = commitWork(dir, 2);
    await record(id, { transcript: transcript(), range: `${mid}..${head}` });
    return leave(id, 'review-record');
  }),
  s('review-record', 'blocks when the tree changed after the review was recorded', 'fail', async () => {
    const { id, dir } = await onWork(REVIEW);
    const head = commitWork(dir);
    await record(id, { transcript: transcript(), range: `${firstCommit(dir)}..${head}` });
    write(dir, { 'src/late.js': 'export const late = 1;\n' });
    return leave(id, 'review-record');
  }),
  s('review-record', 'warns, not blocks, when no author identity was ever reported (an older agenfk)', 'unavailable-soft', async () => {
    const { id, dir } = await onWork(REVIEW, { actor: null });
    commitWork(dir);
    return leave(id, 'review-record', { actor: null });
  }),
  s('review-record', 'passes a child card: reviews happen at its parent', 'pass', async () => {
    const parent = await onWork(REVIEW, { type: 'STORY' });
    const child = await onWork(REVIEW, { project: parent.project, parentOf: parent.id });
    return leave(child.id, 'review-record');
  }),
  s('review-record', 'with appliesTo every-card, a child needs its own review', 'fail', async () => {
    const checks = [{ id: 'review-record', params: { appliesTo: 'every-card' } }];
    const parent = await onWork(checks, { type: 'STORY' });
    const child = await onWork(checks, { project: parent.project, parentOf: parent.id });
    commitWork(child.dir);
    return leave(child.id, 'review-record');
  }),
  s('review-record', 'refuses to record a transcript written before the commits it claims to review', 'refused', async () => {
    const { id, dir } = await onWork(REVIEW);
    const f = transcript({ sessionId: 'old-reviewer' });
    writeFileSync(f, JSON.stringify({ sessionId: 'old-reviewer', timestamp: '2020-01-01T00:00:00.000Z' }) + '\n');
    const head = commitWork(dir);
    return refusedWith(400, await record(id, { transcript: f, range: `${firstCommit(dir)}..${head}` }), /before the range's tip/);
  }),
];
