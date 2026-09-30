/**
 * The configuration of a project, with the origin of every value.
 *
 * The rules live in core and are tested there; what a route can get wrong is
 * tested here — the status codes, the shape, and the promise that reading this
 * changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const TEST_DB = path.resolve('./project-settings-route-test-db.sqlite');
let server: import('http').Server;
let projectId: string;

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
  server = app.listen(0);
  const created = await request(server).post('/projects').send({ name: 'horizon-ds' });
  projectId = created.body.id;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

it('answers with a row per setting, each carrying its origin', async () => {
  const res = await request(server).get(`/projects/${projectId}/settings`);
  expect(res.status).toBe(200);
  const keys = res.body.rows.map((r: any) => r.key).sort();
  expect(keys).toEqual(
    ['autoWorktree', 'flow', 'projectRoot', 'setupCommand', 'verifyCommand', 'worktreeRoot'].sort(),
  );
  for (const row of res.body.rows) expect(row.origin).toBeTruthy();
});

it('names the flow in force, rather than leaving the row blank', async () => {
  // A project that has chosen no flow still runs one. "Blank, inherited" makes
  // the reader go looking for which.
  const res = await request(server).get(`/projects/${projectId}/settings`);
  const flow = res.body.rows.find((r: any) => r.key === 'flow');
  expect(flow.origin).toBe('inherited');
  expect(flow.value).toBeTruthy();
});

it('says what a missing setup command costs', async () => {
  const res = await request(server).get(`/projects/${projectId}/settings`);
  const setup = res.body.rows.find((r: any) => r.key === 'setupCommand');
  expect(setup.value).toBeNull();
  expect(setup.warning).toMatch(/dependencies/i);
  // And the command that fixes it, since the screen may not.
  expect(setup.how).toMatch(/agenfk update-project/);
});

it('404s for a project that is not there', async () => {
  const res = await request(server).get('/projects/nope/settings');
  expect(res.status).toBe(404);
});

// Reading configuration must not write any.
it('changes nothing', async () => {
  const before = await request(server).get(`/projects/${projectId}`);
  await request(server).get(`/projects/${projectId}/settings`);
  const after = await request(server).get(`/projects/${projectId}`);
  expect(after.body).toEqual(before.body);
});


/*
 * A repository that declares its own settings.
 *
 * `.agenfk/project.json` is checked in, so what it says is the same for
 * everyone who clones — which is why it outranks the stored row, and why the
 * answer has to say WHERE the value came from and what it ignored.
 */
describe('GET /projects/:id/settings with a project file', () => {
  /**
   * A project pointed at a real folder.
   *
   * Through the storage rather than the route: `projectRoot` is deliberately
   * behind an internal token, and this suite is about what the file does, not
   * about how the root is written.
   */
  const projectRootedAt = async (root: string, name: string): Promise<string> => {
    const created = await request(server).post('/projects').send({ name });
    // Through the internal-token route, which is the only way a root is ever
    // written — the same door the desktop uses (bug e60e20aa).
    await request(server)
      .put(`/projects/${created.body.id}/project-root`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ projectRoot: root });
    return created.body.id as string;
  };

  const write = (root: string, body: unknown): void => {
    fs.mkdirSync(path.join(root, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agenfk', 'project.json'), JSON.stringify(body));
  };

  it('lets the file decide, and names it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-declared-'));
    write(root, { projectId: 'x', autoWorktree: true, verifyCommand: 'npm test' });
    const id = await projectRootedAt(root, 'declared');
    const res = await request(server).get(`/projects/${id}/settings`);
    const verify = res.body.rows.find((r: { key: string }) => r.key === 'verifyCommand');
    expect(verify.value).toBe('npm test');
    expect(verify.origin).toBe('from-file');
    expect(verify.from).toContain('.agenfk/project.json');
  });

  it('reports what it ignored instead of swallowing it', async () => {
    // The file is hand-edited; a key that does nothing has to say so, or
    // somebody spends an afternoon on it.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-declared-'));
    write(root, { projectId: 'x', projectRoot: '/somewhere/else', futureThing: 1 });
    const id = await projectRootedAt(root, 'declared-2');
    const res = await request(server).get(`/projects/${id}/settings`);
    expect(res.body.fileProblems.join(' ')).toMatch(/projectRoot/);
    expect(res.body.fileProblems.join(' ')).toMatch(/futureThing/);
    // And the machine's own root is untouched by what the file asked for.
    const rootRow = res.body.rows.find((r: { key: string }) => r.key === 'projectRoot');
    expect(rootRow.value).toBe(root);
  });

  it('is unchanged for a project with no file at all', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-declared-'));
    const id = await projectRootedAt(root, 'plain');
    const res = await request(server).get(`/projects/${id}/settings`);
    expect(res.body.fileProblems).toEqual([]);
    expect(res.body.rows.some((r: { origin: string }) => r.origin === 'from-file')).toBe(false);
  });
});


/*
 * A verify command that arrived with the repository.
 *
 * The file is what makes a project's configuration travel; it is also a way
 * for a clone to hand this machine a string it will run on verify. So one
 * that came from the file runs only after somebody here has read it — once per
 * exact command, because a pull that edits it is a new thing to read.
 */
describe('approving a command declared by the repository', () => {
  const write = (root: string, body: unknown): void => {
    fs.mkdirSync(path.join(root, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agenfk', 'project.json'), JSON.stringify(body));
  };

  const cardOn = async (projectId: string): Promise<string> => {
    const created = await request(server).post('/items').send({
      projectId, type: 'TASK', title: 'a card', status: 'TODO',
    });
    return created.body.id as string;
  };

  it('refuses to run it until it has been approved, and shows what it is', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-approve-'));
    // A git repo: the default flow's `tree-clean` check (CGLAB-380) reads
    // `git status`, and a bare temp directory fails it before the final step
    // ever runs the command this test is about.
    execSync('git init -q', { cwd: root });
    write(root, { projectId: 'x', verifyCommand: 'echo from-the-repo' });
    // Committed, or the new `tree-clean` check blocks leaving the first step
    // on the very file this test needs present.
    execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm seed', { cwd: root });
    const created = await request(server).post('/projects').send({ name: 'approve-me' });
    await request(server)
      .put(`/projects/${created.body.id}/project-root`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ projectRoot: root });

    const itemId = await cardOn(created.body.id);
    // Walk to the last step, where the verify command is what runs.
    // The validate endpoint is itself behind the internal token — it runs a
    // shell string, which is the same reason this approval exists.
    const step = () => request(server)
      .post(`/items/${itemId}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ evidence: 'walking' });
    let res = await step();
    for (let i = 0; i < 6 && res.status === 200; i += 1) res = await step();
    expect(res.body.error).toBe('COMMAND_NEEDS_APPROVAL');
    expect(res.body.message).toContain('echo from-the-repo');
    expect(res.body.fingerprint).toBeTruthy();
  });

  it('is approved per exact command, through the token route', async () => {
    const created = await request(server).post('/projects').send({ name: 'approver' });
    const res = await request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: 'echo from-the-repo' });
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(true);

    const project = await request(server).get(`/projects/${created.body.id}`);
    expect(project.body.approvedFileCommands).toContain(res.body.fingerprint);
  });

  it('refuses the approval itself without the internal token', async () => {
    // Approving is the decision to RUN a string that came with a repository.
    // An unauthenticated local route could make it on the user's behalf, which
    // is the shape of the bug that put verifyCommand behind the token.
    const created = await request(server).post('/projects').send({ name: 'no-token' });
    const res = await request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .send({ command: 'echo anything' });
    expect(res.status).toBe(401);
  });

  it('never hands an unapproved command to the agent as a test-report fix', async () => {
    /*
     * The NO_TEST_REPORT refusal offers an `agenfk update-project
     * --test-report-command "..."` for the agent to run by itself. Built from
     * the repository's file, it would copy a command nobody approved into the
     * stored test report, which runs as trusted from then on - no capture has
     * run on this move, so the approval refusal never gets there first.
     */
    const flow = await request(server).post('/flows').set('x-agenfk-internal', VERIFY_TOKEN).send({
      name: 'entry-baseline',
      steps: [
        { id: 'start', name: 'START', label: 'START', order: 0, isAnchor: true },
        { id: 'plan', name: 'PLAN', label: 'PLAN', order: 1 },
        // Blocking checks that read a per-test entry baseline: leaving PLAN holds on it.
        { id: 'tests', name: 'TESTS', label: 'TESTS', order: 2, checks: [{ id: 'new-tests-exist' }, { id: 'some-new-test-red' }] },
        { id: 'work', name: 'WORK', label: 'WORK', order: 3 },
        { id: 'end', name: 'END', label: 'END', order: 4, isAnchor: true },
      ],
    });
    expect(flow.status, JSON.stringify(flow.body)).toBe(201);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-fix-'));
    execSync('git init -q', { cwd: root });
    // `vitest run` so the hint recognises the runner and would build a fix from it.
    write(root, { projectId: 'x', verifyCommand: 'echo unapproved-marker && vitest run' });
    execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm seed', { cwd: root });
    const created = await request(server).post('/projects').send({ name: 'no-laundering' });
    await storage.updateProject(created.body.id, { flowId: flow.body.id, projectRoot: root } as never);
    const itemId = await cardOn(created.body.id);
    await storage.updateItem(itemId, { status: 'PLAN' } as never);

    const res = await request(server)
      .post(`/items/${itemId}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ evidence: 'leaving PLAN' });
    expect(res.body.error, JSON.stringify(res.body)).toBe('NO_TEST_REPORT');
    expect(String(res.body.fix ?? '')).not.toContain('unapproved-marker');
  });

  it('offers the repository command to run by hand only once it is approved', async () => {
    // Leaving a step that runs nothing tells the agent that running the tests is
    // its own job, naming the command. An unapproved one named there walks past
    // the approval exactly as a stored test report would.
    const flow = await request(server).post('/flows').set('x-agenfk-internal', VERIFY_TOKEN).send({
      name: 'runs-nothing',
      steps: [
        { id: 'start', name: 'START', label: 'START', order: 0, isAnchor: true },
        { id: 'plan', name: 'PLAN', label: 'PLAN', order: 1 },
        { id: 'work', name: 'WORK', label: 'WORK', order: 2 },
        { id: 'end', name: 'END', label: 'END', order: 3, isAnchor: true },
      ],
    });
    expect(flow.status, JSON.stringify(flow.body)).toBe(201);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-by-hand-'));
    write(root, { projectId: 'x', verifyCommand: 'echo by-hand-marker' });
    const created = await request(server).post('/projects').send({ name: 'by-hand' });
    await storage.updateProject(created.body.id, { flowId: flow.body.id, projectRoot: root } as never);
    const itemId = await cardOn(created.body.id);
    await storage.updateItem(itemId, { status: 'PLAN' } as never);

    const before = await request(server).get(`/items/${itemId}/leave-plan`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.advice).toMatch(/running them is yours/);
    expect(before.body.advice).not.toContain('by-hand-marker');

    await request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: 'echo by-hand-marker' });
    const after = await request(server).get(`/items/${itemId}/leave-plan`);
    expect(after.body.advice).toContain('by-hand-marker');
  });
});
