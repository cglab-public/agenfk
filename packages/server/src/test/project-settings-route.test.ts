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

  /** Where the board's own page lives: the address the request is sent to. */
  const ownHost = () => `127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;

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
    // Where to approve it - the board - since the agent reading this cannot.
    expect(res.body.message).toMatch(/on the board/i);
    expect(res.body.fingerprint).toBeTruthy();
  });

  /*
   * Approving is the decision to RUN a string that came with a repository, so
   * it is a person's act on the board - like a step approval or an override.
   * It used to sit behind the internal token, which is the token the agent's
   * own CLI holds: an agent refused COMMAND_NEEDS_APPROVAL could approve the
   * command and run it (34ee6b8a).
   */
  it('is approved by a person on the board, per exact command', async () => {
    const created = await request(server).post('/projects').send({ name: 'approver' });
    const res = await request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .set('x-agenfk-ui', '1')
      .set('Host', ownHost())
      .set('Origin', `http://${ownHost()}`)
      .send({ command: 'echo from-the-repo' });
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(true);
    // The board's word, recorded as such: no passkey was offered.
    expect(res.body.authority).toBe('unverified');

    const project = await request(server).get(`/projects/${created.body.id}`);
    expect(project.body.approvedFileCommands).toContain(res.body.fingerprint);
    expect(project.body.fileCommandApprovals).toEqual([
      expect.objectContaining({ fingerprint: res.body.fingerprint, command: 'echo from-the-repo', by: 'board', authority: 'unverified' }),
    ]);
  });

  it("refuses the agent's token, even when the request claims to come from the board", async () => {
    const created = await request(server).post('/projects').send({ name: 'agent-tries' });
    const res = await request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .set('x-agenfk-ui', '1')
      .set('Host', ownHost())
      .set('Origin', `http://${ownHost()}`)
      .send({ command: 'echo from-the-repo' });
    expect(res.status).toBe(403);
    const project = await request(server).get(`/projects/${created.body.id}`);
    expect(project.body.approvedFileCommands ?? []).toEqual([]);
  });

  it('refuses a page from another local origin, which CORS lets talk to the server', async () => {
    // Any dev server or local web app on another port passes CORS here; the
    // board header is no secret. Only a page this server served may approve.
    const created = await request(server).post('/projects').send({ name: 'other-page' });
    const res = await request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .set('x-agenfk-ui', '1')
      .set('Host', ownHost())
      .set('Origin', 'http://localhost:5555')
      .send({ command: 'echo from-the-repo' });
    expect(res.status).toBe(403);
    const project = await request(server).get(`/projects/${created.body.id}`);
    expect(project.body.approvedFileCommands ?? []).toEqual([]);
  });

  it('refuses a page squatting the IPv6 loopback on this port, which this server does not bind', async () => {
    const created = await request(server).post('/projects').send({ name: 'ipv6-squatter' });
    const port = (server.address() as import('net').AddressInfo).port;
    const res = await request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .set('x-agenfk-ui', '1')
      .set('Host', ownHost())
      .set('Origin', `http://[::1]:${port}`)
      .send({ command: 'echo from-the-repo' });
    expect(res.status).toBe(403);
  });

  it('does not trust whatever listens on the vite port unless that origin is configured', async () => {
    const created = await request(server).post('/projects').send({ name: 'vite-port' });
    const post = () => request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .set('x-agenfk-ui', '1')
      .set('Host', ownHost())
      .set('Origin', 'http://localhost:5173')
      .send({ command: 'echo from-the-repo' });
    expect((await post()).status).toBe(403);
    const before = process.env.AGENFK_BOARD_ORIGINS;
    process.env.AGENFK_BOARD_ORIGINS = 'http://localhost:5173';
    try {
      expect((await post()).status).toBe(200);
    } finally {
      if (before === undefined) delete process.env.AGENFK_BOARD_ORIGINS; else process.env.AGENFK_BOARD_ORIGINS = before;
    }
  });

  it('will not approve a command holding characters a screen cannot show faithfully', async () => {
    // A right-to-left override makes this READ as one quoted echo; the shell runs printf too.
    const command = "echo 'safe\u202E'; printf REVIEW_MARKER; #";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-bidi-'));
    write(root, { projectId: 'x', verifyCommand: command });
    const created = await request(server).post('/projects').send({ name: 'bidi' });
    await storage.updateProject(created.body.id, { projectRoot: root } as never);
    const settings = await request(server).get(`/projects/${created.body.id}/settings`);
    expect(settings.body.fileCommands[0].hidden).toEqual(['U+202E']);
    const res = await request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .set('x-agenfk-ui', '1')
      .set('Host', ownHost())
      .set('Origin', `http://${ownHost()}`)
      .send({ command });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/U\+202E/);
    const project = await request(server).get(`/projects/${created.body.id}`);
    expect(project.body.approvedFileCommands ?? []).toEqual([]);
  });

  it('refuses an approval that does not come from the board', async () => {
    const created = await request(server).post('/projects').send({ name: 'no-board' });
    const res = await request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .send({ command: 'echo anything' });
    expect(res.status).toBe(403);
  });

  it('tells the settings screen what the repository asks to run, and whether it is approved', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-file-cmds-'));
    write(root, { projectId: 'x', verifyCommand: 'echo listed' });
    const created = await request(server).post('/projects').send({ name: 'lists-them' });
    await storage.updateProject(created.body.id, { projectRoot: root } as never);

    const before = await request(server).get(`/projects/${created.body.id}/settings`);
    expect(before.body.fileCommands).toEqual([
      expect.objectContaining({ key: 'verifyCommand', command: 'echo listed', approved: false }),
    ]);
    await request(server)
      .post(`/projects/${created.body.id}/approve-file-command`)
      .set('x-agenfk-ui', '1')
      .set('Host', ownHost())
      .set('Origin', `http://${ownHost()}`)
      .send({ command: 'echo listed' });
    const after = await request(server).get(`/projects/${created.body.id}/settings`);
    expect(after.body.fileCommands[0].approved).toBe(true);
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
    // The whole answer, not only `fix`: a regression moving the command into `message` counts too.
    expect(JSON.stringify(res.body)).not.toContain('unapproved-marker');
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
      .set('x-agenfk-ui', '1')
      .set('Host', ownHost())
      .set('Origin', `http://${ownHost()}`)
      .send({ command: 'echo by-hand-marker' });
    const after = await request(server).get(`/items/${itemId}/leave-plan`);
    expect(after.body.advice).toContain('by-hand-marker');
  });
});
