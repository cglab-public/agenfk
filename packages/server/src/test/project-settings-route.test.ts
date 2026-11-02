/**
 * The configuration of a project, with the origin of every value.
 *
 * The rules live in core and are tested there; what a route can get wrong is
 * tested here — the status codes, the shape, and the promise that reading this
 * changes nothing.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const TEST_DB = testDbPath('project-settings-route-test-db.sqlite');
let server: import('http').Server;
let projectId: string;

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  await removeTestDb(TEST_DB, closeStorage);
  await initStorage();
  server = app.listen(0);
  const created = await request(server).post('/projects').send({ name: 'horizon-ds' });
  projectId = created.body.id;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  await removeTestDb(TEST_DB, closeStorage);
});

it('answers with a row per setting, each carrying its origin', async () => {
  const res = await request(server).get(`/projects/${projectId}/settings`);
  expect(res.status).toBe(200);
  const keys = res.body.rows.map((r: any) => r.key).sort();
  expect(keys).toEqual(
    ['autoWorktree', 'exclusiveSuite', 'flow', 'projectRoot', 'setupCommand', 'verifyAtScope', 'verifyCommand', 'worktreeRoot'].sort(),
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
    expect(verify.from).toContain(path.join('.agenfk', 'project.json')); // the file's own path, native (#208)
  });

  it('tells the settings screen that a projectId belongs in local.json (CGLAB-625)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-declared-'));
    write(root, { projectId: 'x', verifyCommand: 'npm test' });
    const id = await projectRootedAt(root, 'declared-legacy');
    const res = await request(server).get(`/projects/${id}/settings`);
    expect(res.body.fileProblems.join(' ')).toMatch(/local\.json/);
    // The settings still apply: a legacy file is read, not rejected.
    expect(res.body.rows.find((r: { key: string }) => r.key === 'verifyCommand').value).toBe('npm test');
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

  // /dev/zero and mkfifo are POSIX's; Windows has neither to stage (#208).
  it.skipIf(process.platform === 'win32')('will not hang on a project file that never ends or never opens: a regular file only', async () => {
    // The file arrives with a clone, and settings and every verify read it on the request path.
    const zero = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-declared-'));
    fs.mkdirSync(path.join(zero, '.agenfk'));
    fs.symlinkSync('/dev/zero', path.join(zero, '.agenfk', 'project.json'));
    const fifo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-declared-'));
    fs.mkdirSync(path.join(fifo, '.agenfk'));
    execSync(`mkfifo ${JSON.stringify(path.join(fifo, '.agenfk', 'project.json'))}`);
    for (const [root, name] of [[zero, 'dev-zero'], [fifo, 'fifo']] as const) {
      const id = await projectRootedAt(root, name);
      const res = await request(server).get(`/projects/${id}/settings`);
      expect(res.status).toBe(200);
      expect(res.body.fileProblems.join(' ')).toMatch(/not a regular file/);
    }
  });

  it('ignores a project file far larger than one could be', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-declared-'));
    write(root, { projectId: 'x', verifyCommand: 'npm test', padding: 'x'.repeat(70 * 1024) });
    const id = await projectRootedAt(root, 'huge');
    const res = await request(server).get(`/projects/${id}/settings`);
    expect(res.body.fileProblems.join(' ')).toMatch(/larger than 64 KB/);
    expect(res.body.rows.some((r: { origin: string }) => r.origin === 'from-file')).toBe(false);
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
 * #260: a command the repository declares (.agenfk/project.json) runs as
 * committed, with no per-machine approval. The settings screen shows it in
 * full, with any characters a screen cannot show faithfully, which still keep
 * it from running.
 */
describe('a command declared by the repository', () => {
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

  it('tells the settings screen what the repository asks to run, with no approval state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-file-cmds-'));
    write(root, { projectId: 'x', verifyCommand: 'echo listed' });
    const created = await request(server).post('/projects').send({ name: 'lists-them' });
    await storage.updateProject(created.body.id, { projectRoot: root } as never);

    const settings = await request(server).get(`/projects/${created.body.id}/settings`);
    expect(settings.body.fileCommands).toEqual([{ key: 'verifyCommand', command: 'echo listed', hidden: [] }]);
  });

  it('lists the characters a screen cannot show faithfully, and the verify refuses that command', async () => {
    // A right-to-left override makes this READ as one quoted echo; the shell runs printf too.
    const command = "echo 'safe\u202E'; printf REVIEW_MARKER; #";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-bidi-'));
    execSync('git init -q', { cwd: root });
    write(root, { projectId: 'x', verifyCommand: command });
    execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm seed', { cwd: root });
    const created = await request(server).post('/projects').send({ name: 'bidi' });
    await storage.updateProject(created.body.id, { projectRoot: root } as never);
    const settings = await request(server).get(`/projects/${created.body.id}/settings`);
    expect(settings.body.fileCommands[0].hidden).toEqual(['U+202E']);

    const itemId = await cardOn(created.body.id);
    const step = () => request(server)
      .post(`/items/${itemId}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ evidence: 'walking' });
    let res = await step();
    for (let i = 0; i < 6 && res.status === 200; i += 1) res = await step();
    expect(res.body.error, JSON.stringify(res.body)).toBe('COMMAND_UNREADABLE');
    expect(res.body.message).toContain('U+202E');
  });

  it('builds a test-report fix from the stored command, never from the repository file', async () => {
    /*
     * The NO_TEST_REPORT refusal offers an `agenfk update-project
     * --test-report-command "..."` for the agent to run by itself. It is built
     * from the project's stored command (noTestReportFix): the repository's
     * file declares what runs, it does not write the stored test report.
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
    write(root, { projectId: 'x', verifyCommand: 'echo file-marker && vitest run' });
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
    expect(JSON.stringify(res.body)).not.toContain('file-marker');
  });

  it('offers the repository command to run by hand, unless it holds hidden characters', async () => {
    // Leaving a step that runs nothing tells the agent that running the tests is
    // its own job, naming the command - the repository's runs as committed (#260).
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

    const plain = await request(server).get(`/items/${itemId}/leave-plan`);
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body.advice).toMatch(/running them is yours/);
    expect(plain.body.advice).toContain('by-hand-marker');

    write(root, { projectId: 'x', verifyCommand: 'echo by-hand-marker\u200B' });
    const hidden = await request(server).get(`/items/${itemId}/leave-plan`);
    expect(hidden.body.advice).not.toContain('by-hand-marker');
  });
});

// Airlock story review (Codex 01a18313): a linked worktree is one card's tree, never the
// project's root, and the repository Airlock pins is read from the root.
it('PUT /projects/:id/project-root refuses a linked git worktree, and takes its main checkout', async () => {
  const main = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-root-main-')));
  const linked = path.join(fs.realpathSync(os.tmpdir()), `agenfk-root-linked-${process.pid}-${Date.now()}`);
  try {
    execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: main });
    execSync(`git worktree add -q "${linked}"`, { cwd: main });
    const created = await request(server).post('/projects').send({ name: 'worktree-root' });
    const put = (root: string) => request(server).put(`/projects/${created.body.id}/project-root`).set('x-agenfk-internal', VERIFY_TOKEN).send({ projectRoot: root });
    const refused = await put(linked);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/linked git worktree/);
    expect((await put(main)).status).toBe(200);
  } finally {
    fs.rmSync(linked, { recursive: true, force: true });
    fs.rmSync(main, { recursive: true, force: true });
  }
});
