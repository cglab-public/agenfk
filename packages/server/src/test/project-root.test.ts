/**
 * @vitest-environment node
 *
 * Repointing a project at the repository it actually lives in (CGLAB-185).
 *
 * This endpoint exists because there was NO way to correct a wrong project
 * root. The value is otherwise written only as a side effect of validating from
 * inside a directory, so a project that once picked up the wrong one kept it
 * for good — and `PUT /projects/:id` deliberately refuses the field, because
 * that route is unauthenticated and this is a CWD.
 *
 * It is not a hypothetical wrong value. Four projects on the machine this was
 * found on have `projectRoot` set to $HOME, which is what a walk-up finds when
 * it passes ~/.agenfk. An auto-worktree there cuts a branch from the user's
 * home directory and an auto-commit runs `git add -A` over their dotfiles.
 *
 * `isPersistableProjectRoot` was written for exactly that mistake and, until
 * now, had no caller that could FIX one.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN } from '../server';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call —
 * 8 of them here. The churn produced `Error: Parse Error: Expected HTTP/`,
 * a transport failure that hands the test an empty body, so the next call goes
 * to `/items/undefined` and one bad socket surfaces as a confident wrong
 * assertion in whichever test was running.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


const TEST_DB = path.resolve('./project-root-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

let projectId: string;
let repo: string;

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-root-'));
});
afterAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  fs.rmSync(repo, { recursive: true, force: true });
});
beforeEach(async () => {
  await initStorage();
  const p = await internal(agent().post('/projects')).send({ name: 'roots' });
  projectId = p.body.id;
});

const setRoot = (projectRoot: unknown) =>
  internal(agent().put(`/projects/${projectId}/project-root`)).send({ projectRoot });

describe('setting a project root', () => {
  it('records a real directory', async () => {
    const res = await setRoot(repo);
    expect(res.status).toBe(200);
    const after = await agent().get(`/projects`);
    expect(after.body.find((p: { id: string }) => p.id === projectId).projectRoot).toBe(repo);
  });

  it('is refused without the internal token', async () => {
    // It is a CWD: where `git add -A && git commit` runs and where worktrees
    // are cut from. An unauthenticated caller setting it is mass assignment
    // with execution consequences — the reason PUT /projects/:id refuses it.
    const res = await agent().put(`/projects/${projectId}/project-root`).send({ projectRoot: repo });
    expect(res.status).toBe(401);
  });

  it('is still refused by the open project route', async () => {
    // Belt and braces: this endpoint must not have made the field writable
    // somewhere it was deliberately kept out of.
    await internal(agent().put(`/projects/${projectId}/project-root`)).send({ projectRoot: repo });
    await agent().put(`/projects/${projectId}`).send({ name: 'roots', projectRoot: '/tmp' });
    const after = await agent().get('/projects');
    expect(after.body.find((p: { id: string }) => p.id === projectId).projectRoot).toBe(repo);
  });
});

describe('what it refuses to record', () => {
  it('the home directory, which is what a bad walk-up finds', async () => {
    // The actual bug this exists for. Four projects are in this state.
    const res = await setRoot(os.homedir());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/home directory/i);
  });

  it('the framework state directory', async () => {
    // Pointing a worktree at ~/.agenfk aims it at the framework's own files.
    const res = await setRoot(path.join(os.homedir(), '.agenfk'));
    expect(res.status).toBe(400);
  });

  it('the filesystem root', async () => {
    expect((await setRoot('/')).status).toBe(400);
  });

  it('a relative path', async () => {
    // It would resolve against whatever cwd the SERVER has, which is neither
    // visible to nor intended by the person typing it.
    expect((await setRoot('../somewhere')).status).toBe(400);
    expect((await setRoot('somewhere')).status).toBe(400);
  });

  it('a directory that is not there', async () => {
    // Without this the failure surfaces much later, at worktree time, as an
    // error about git rather than about the setting that caused it.
    expect((await setRoot(path.join(os.tmpdir(), 'agenfk-no-such-dir-12345'))).status).toBe(400);
  });

  it('a file that is not a directory', async () => {
    const file = path.join(repo, 'a-file');
    fs.writeFileSync(file, 'x');
    expect((await setRoot(file)).status).toBe(400);
  });

  it('anything that is not a non-empty string', async () => {
    for (const bad of ['', '   ', 42, true, null, undefined, {}, ['/tmp']]) {
      expect((await setRoot(bad)).status, `should have refused ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('a project that does not exist', async () => {
    const res = await internal(agent().put('/projects/no-such-project/project-root'))
      .send({ projectRoot: repo });
    expect(res.status).toBe(404);
  });
});
