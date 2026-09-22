/**
 * @vitest-environment node
 *
 * The sibling gate, end to end (b29a8b3a).
 *
 * The unit tests prove the decision. This proves the WIRE: that a passing
 * verify records the commit it earned the green at, and that propagation
 * consults it against the tree the next card would inherit. A gate that is
 * correct and never called is the exact failure mode this whole epic is about.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

const TEST_DB = path.resolve('./propagation-integration-test-db.sqlite');
const repos: string[] = [];

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  __server = app.listen(0);
  await initStorage();
});
afterAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await new Promise<void>(r => __server.close(() => r()));
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
});

let repo: string;
beforeEach(async () => {
  await initStorage();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-propgate-'));
  repos.push(repo);
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
  execSync('git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
});

const sha = () => execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
const advanceTheTree = () => {
  fs.writeFileSync(path.join(repo, 'a.txt'), `two-${Date.now()}`);
  execSync('git add . && git commit -qm two', { cwd: repo, shell: '/bin/sh' });
};

/** A project whose verify runs in `repo`, with a parent already made. */
const setup = async () => {
  const p = (await internal(agent().post('/projects')).send({ name: `propgate-${Date.now()}` })).body;
  await storage.updateProject(p.id, { projectRoot: repo, verifyCommand: 'true' } as never);
  const parent = (await internal(agent().post('/items')).send({ type: 'STORY', title: 'p', projectId: p.id })).body;
  const make = async (title: string) =>
    (await internal(agent().post('/items')).send({ type: 'TASK', title, projectId: p.id, parentId: parent.id })).body;
  return { p, make };
};

// Internal token skips the one-step rule, so a card can be parked on the step
// before DONE without walking the whole flow.
const toTest = async (id: string) =>
  internal(agent().post('/items/bulk')).send({ items: [{ id, updates: { status: 'TEST' } }] });
const validate = async (id: string) => internal(agent().post(`/items/${id}/validate`)).send({ evidence: 'ok' });

/**
 * A flow whose exit is not named DONE (what `agenfk flow create` produces).
 * The gate keyed on the literal `DONE` let these terminals bypass it entirely
 * through the intermediate branch, which propagated on "a sibling is further
 * along" with no test, no command and no sha - the 81% shortcut intact.
 */
describe('the sibling gate on a custom flow terminal', () => {
  it('gates the exit step even when it is not named DONE', async () => {
    const p = (await internal(agent().post('/projects')).send({ name: `shipped-${Date.now()}` })).body;
    await storage.updateProject(p.id, { projectRoot: repo, verifyCommand: 'true' } as never);
    const f = (await internal(agent().post('/flows')).send({
      name: 'Ship Flow',
      steps: [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'SPEC', label: 'Spec', order: 1 },
        { name: 'CODE', label: 'Code', order: 2 },
        { name: 'SHIPPED', label: 'Shipped', order: 3, isAnchor: true },
      ],
    })).body;
    await internal(agent().post(`/projects/${p.id}/flow`)).send({ flowId: f.id });

    const parent = (await internal(agent().post('/items')).send({ type: 'STORY', title: 'p', projectId: p.id })).body;
    const c1 = (await internal(agent().post('/items')).send({ type: 'TASK', title: 'c1', projectId: p.id, parentId: parent.id })).body;
    const c2 = (await internal(agent().post('/items')).send({ type: 'TASK', title: 'c2', projectId: p.id, parentId: parent.id })).body;

    // A DONE sibling with a PASSED record that carries no commit.
    await storage.updateItem(c1.id, {
      status: 'DONE',
      tests: [{ id: 'legacy', command: 'true', output: '', status: 'PASSED', executedAt: new Date() }],
    } as never);
    await internal(agent().post('/items/bulk')).send({ items: [{ id: c2.id, updates: { status: 'CODE' } }] });

    const r = await validate(c2.id);
    expect(r.body.status).toBe('SHIPPED');
    expect(r.body.output, 'a custom terminal bypassed the gate').not.toBe('Sibling propagation');
  });
});

/**
 * `endsFlow` has two edges, and `agenfk flow create` produces both: a last
 * step named DONE with no boundary flag, and a last step that is not a boundary
 * at all. One must close, the other must not close early.
 */
describe('which last steps end the flow', () => {
  const projectOnFlow = async (name: string, steps: any[]) => {
    const p = (await internal(agent().post('/projects')).send({ name: `${name}-${Date.now()}` })).body;
    await storage.updateProject(p.id, { projectRoot: repo, verifyCommand: 'true' } as never);
    const f = (await internal(agent().post('/flows')).send({ name, steps })).body;
    await internal(agent().post(`/projects/${p.id}/flow`)).send({ flowId: f.id });
    const item = (await internal(agent().post('/items')).send({ type: 'TASK', title: 'x', projectId: p.id })).body;
    return { p, item };
  };

  it('closes on a last step named DONE even with no boundary flag', async () => {
    // `agenfk flow create` defaults the terminal question to false and never
    // sets isAnchor, so this shape is real. Dropping it means the suite runs and
    // the card then never records or commits.
    const { item } = await projectOnFlow('Plain DONE', [
      { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
      { name: 'CODE', label: 'Code', order: 1 },
      { name: 'DONE', label: 'Done', order: 2 },
    ]);
    await internal(agent().post('/items/bulk')).send({ items: [{ id: item.id, updates: { status: 'CODE' } }] });
    const r = await validate(item.id);
    expect(r.body.status).toBe('DONE');
    const after = (await agent().get(`/items/${item.id}`)).body;
    expect(after.tests?.some((t: any) => t.status === 'PASSED' && t.commit), 'the green was never recorded or tied to a commit').toBe(true);
  });

  it('does NOT close early on a last step that is not a boundary', async () => {
    // A flow with no terminal boundary: the last step by position is just a
    // work step, and treating it as the end fires the close commit while the
    // card still has work.
    const { item } = await projectOnFlow('No Terminal', [
      { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
      { name: 'CODE', label: 'Code', order: 1 },
      { name: 'SHIP', label: 'Ship', order: 2 },
    ]);
    await internal(agent().post('/items/bulk')).send({ items: [{ id: item.id, updates: { status: 'CODE' } }] });
    // An EXPLICIT command, so the request reaches the endsFlow sites instead of
    // returning early with nothing to run - without it this test passes
    // whether or not the boundary conjunct exists.
    const r = await internal(agent().post(`/items/${item.id}/validate`)).send({ evidence: 'ok', command: 'true' });
    expect(r.body.status).toBe('SHIP');
    const after = (await agent().get(`/items/${item.id}`)).body;
    expect(after.tests?.length ?? 0, 'a step before the end recorded a completion').toBe(0);
  });
});

describe('the sibling gate on a real tree', () => {
  it('lets a green earned at this very commit carry the next card', async () => {
    const { make } = await setup();
    const c1 = await make('c1');
    await toTest(c1.id);
    const r1 = await validate(c1.id);
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe('DONE');

    const c2 = await make('c2');
    await toTest(c2.id);
    const r2 = await validate(c2.id);
    expect(r2.body.status).toBe('DONE');
    expect(r2.body.output, 'it ran the command instead of inheriting the green').toBe('Sibling propagation');
  });

  it('refuses when the tree has UNCOMMITTED work, and runs the command', async () => {
    // In the one-tree model agents edit without committing until close, so a
    // dirty tree is the NORMAL state and its content is work the sibling's
    // green never saw. HEAD alone cannot see it; the clean-tree rule can.
    const { make } = await setup();
    const c1 = await make('c1');
    await toTest(c1.id);
    await validate(c1.id);

    fs.appendFileSync(path.join(repo, 'a.txt'), 'uncommitted');

    const c2 = await make('c2');
    await toTest(c2.id);
    const r2 = await validate(c2.id);
    expect(r2.body.status).toBe('DONE');
    expect(r2.body.output, 'a green was spent on a tree that had moved under it').not.toBe('Sibling propagation');
  });

  it('refuses when the cards work in a worktree the command never ran in', async () => {
    /*
     * The round-2 blocker, on the provenance side: a green must never cross
     * from one tree to another. It used to be stated as "the command runs in
     * projectRoot, a worktree card commits in its worktree", and CGLAB-366
     * made that false - the command now runs in the card's (or its top-level
     * ancestor's) worktree, the same root the close commit uses.
     *
     * What survives is the dangerous shape itself: two checkouts at the SAME
     * commit. A clone of the worktree has the identical SHA and a different
     * tree, so a gate that compared SHAs alone would spend c1's green on a
     * checkout nothing ever ran in. It must be refused on the ROOT.
     */
    const { make } = await setup();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-other-'));
    repos.push(other);
    execSync('git init -q', { cwd: other });
    execSync('git config user.email t@t', { cwd: other });
    execSync('git config user.name t', { cwd: other });
    fs.writeFileSync(path.join(other, 'b.txt'), 'x');
    execSync('git add . && git commit -qm one', { cwd: other, shell: '/bin/sh' });
    const otherSha = execSync('git rev-parse HEAD', { cwd: other, encoding: 'utf8' }).trim();
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-clone-'));
    repos.push(clone);
    execSync(`git clone -q "${other}" "${clone}"`, { shell: '/bin/sh' });
    expect(execSync('git rev-parse HEAD', { cwd: clone, encoding: 'utf8' }).trim()).toBe(otherSha);

    const c1 = await make('c1');
    const c2 = await make('c2');
    await storage.updateItem(c1.id, {
      status: 'DONE',
      worktreePath: other,
      tests: [{ id: 'w', command: 'true', output: '', status: 'PASSED', executedAt: new Date(), commit: otherSha }],
    } as never);
    await storage.updateItem(c2.id, { worktreePath: clone } as never);

    await toTest(c2.id);
    const r2 = await validate(c2.id);
    expect(r2.body.status).toBe('DONE');
    expect(r2.body.output, 'a green from a checkout the command never opened was spent').not.toBe('Sibling propagation');
  });

  it('propagates between siblings that share one worktree, at the commit the green was recorded on (CGLAB-366)', async () => {
    /*
     * The case the sibling rule exists for: children of one top-level item
     * share its worktree. Their suite now runs IN that worktree, so a green
     * recorded there at a clean commit is proof about the very tree the next
     * sibling would test, and it transfers. (Before CGLAB-366 this same shape
     * was refused, because the command ran in projectRoot - and siblings with
     * no worktree of their own were quietly measured against the MAIN
     * checkout's commits instead.)
     */
    const { make } = await setup();
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-shared-'));
    repos.push(shared);
    execSync('git init -q', { cwd: shared });
    execSync('git config user.email t@t', { cwd: shared });
    execSync('git config user.name t', { cwd: shared });
    fs.writeFileSync(path.join(shared, 'b.txt'), 'x');
    execSync('git add . && git commit -qm one', { cwd: shared, shell: '/bin/sh' });
    const sha = execSync('git rev-parse HEAD', { cwd: shared, encoding: 'utf8' }).trim();

    const c1 = await make('c1');
    const c2 = await make('c2');
    await storage.updateItem(c1.id, {
      status: 'DONE',
      worktreePath: shared,
      tests: [{ id: 'w', command: 'true', output: '', status: 'PASSED', executedAt: new Date(), commit: sha }],
    } as never);
    await storage.updateItem(c2.id, { worktreePath: shared } as never);

    await toTest(c2.id);
    const r2 = await validate(c2.id);
    expect(r2.body.status).toBe('DONE');
    expect(r2.body.output).toBe('Sibling propagation');
  });

  it('uses a fresh record when a sibling also carries a stale one', async () => {
    // A sibling re-verified after a rollback has two PASSED records for the
    // same command; the older one must not shadow the current one.
    const { make } = await setup();
    const treeSha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    const c1 = await make('c1');
    await storage.updateItem(c1.id, {
      status: 'DONE',
      tests: [
        { id: 'old', command: 'true', output: '', status: 'PASSED', executedAt: new Date(), commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        { id: 'new', command: 'true', output: '', status: 'PASSED', executedAt: new Date(), commit: treeSha },
      ],
    } as never);

    const c2 = await make('c2');
    await toTest(c2.id);
    const r2 = await validate(c2.id);
    expect(r2.body.output).toBe('Sibling propagation');
  });

  it('refuses a legacy green that carries no commit', async () => {
    // Every record written before this feature. "Could not check" is not
    // "checked, clear", and the 63-of-78 population is exactly this shape.
    const { make } = await setup();
    const c1 = await make('c1');
    await storage.updateItem(c1.id, {
      status: 'DONE',
      tests: [{ id: 'legacy', command: 'true', output: '', status: 'PASSED', executedAt: new Date() }],
    } as never);

    const c2 = await make('c2');
    await toTest(c2.id);
    const r2 = await validate(c2.id);
    expect(r2.body.status).toBe('DONE');
    expect(r2.body.output).not.toBe('Sibling propagation');
  });

  it('refuses once the tree moved, and runs the command instead', async () => {
    const { make } = await setup();
    const c1 = await make('c1');
    await toTest(c1.id);
    await validate(c1.id);
    const verifiedAt = sha();

    // Another agent lands work in the shared tree after the sibling verified.
    advanceTheTree();
    expect(sha()).not.toBe(verifiedAt);

    const c2 = await make('c2');
    await toTest(c2.id);
    const r2 = await validate(c2.id);
    expect(r2.body.status).toBe('DONE');
    expect(r2.body.output, 'a stale green was spent as proof').not.toBe('Sibling propagation');
  });
});
