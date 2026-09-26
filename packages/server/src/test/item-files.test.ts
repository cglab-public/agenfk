/**
 * @vitest-environment node
 *
 * Listing a session's worktree, without becoming a filesystem browser.
 *
 * The card's one non-optional constraint, and the reason is specific to this
 * server: it listens on loopback with no authentication, and its CORS
 * allowlist trusts any localhost origin. An endpoint that lists an arbitrary
 * directory is therefore filesystem read access for any page open in the
 * user's browser.
 *
 * So the containment is checked against the RESOLVED path — `fs.realpathSync`
 * — not by looking for `..` in the string. A lexical check is defeated by a
 * symlink, which git worktrees and node_modules are full of, and by an
 * absolute path, which contains no `..` at all.
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
 * 10 of them here. The churn produced `Error: Parse Error: Expected HTTP/`,
 * a transport failure that hands the test an empty body, so the next call goes
 * to `/items/undefined` and one bad socket surfaces as a confident wrong
 * assertion in whichever test was running.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


const TEST_DB = path.resolve('./item-files-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

let repo: string;
let outside: string;
let itemId: string;
let worktree: string;

describe('GET /items/:id/files', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await initStorage();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-files-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not read me\n');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# hi\n');
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export {};\n');
    fs.mkdirSync(path.join(repo, '.agenfk'), { recursive: true });
    const { execFileSync } = require('child_process');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'first'], { cwd: repo });

    const p = await internal(agent().post('/projects')).send({ name: 'files' });
    const item = await agent().post('/items')
      .send({ title: 'Has files', type: 'TASK', projectId: p.body.id });
    itemId = item.body.id;
    await internal(agent().post(`/items/${itemId}/validate`))
      .send({ cwd: repo, evidence: 'set the root for this test' });
    const made = await internal(agent().post(`/items/${itemId}/worktree`))
      .send({ repoRoot: repo, branchName: 'feat/files' });
    // Loudly, not conditionally. Letting the setup fail silently would make
    // every assertion below pass by never running — which is the shape of a
    // test that guards nothing.
    expect(made.status, `worktree setup failed: ${JSON.stringify(made.body)}`).toBeLessThan(300);
    worktree = made.body.path as string;
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'README.md'), '# hi\n');
  });

  it('lists the top of the worktree', async () => {
    const res = await agent().get(`/items/${itemId}/files`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.entries.map((e: { name: string }) => e.name)).toContain('README.md');
  });

  it('refuses a path outside the worktree, given as an absolute path', async () => {
    // The most direct attack, and the one a `..` check does not even see.
    const res = await agent()
      .get(`/items/${itemId}/files`)
      .query({ path: outside });
    expect([403, 409]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('secret.txt');
  });

  it('refuses a traversal', async () => {
    const res = await agent()
      .get(`/items/${itemId}/files`)
      .query({ path: '../../etc' });
    expect([403, 409]).toContain(res.status);
  });

  it('refuses a symlink that points out of the worktree', async () => {
    // The case a lexical check cannot catch: the string is entirely innocent
    // and the resolved path is not. git worktrees and node_modules are full
    // of symlinks, so this is ordinary rather than contrived.
    const link = path.join(worktree, 'escape');
    fs.symlinkSync(outside, link);
    const res = await agent().get(`/items/${itemId}/files`).query({ path: link });
    expect([403, 409]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('secret.txt');
  });

  it('puts directories first, so the shape of the tree reads at a glance', async () => {
    // Ordered here and nowhere else. A second sort in the UI would be a
    // second opinion about the same question, and the two would drift.
    fs.mkdirSync(path.join(worktree, 'zz-dir'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'a.ts'), 'x\n');
    const res = await agent().get(`/items/${itemId}/files`);
    expect(res.status).toBe(200);
    const kinds = res.body.entries.map((e: { kind: string }) => e.kind);
    expect(kinds.indexOf('directory')).toBeLessThan(kinds.lastIndexOf('file'));
  });

  it('404s for an item that does not exist', async () => {
    expect((await agent().get('/items/nope/files')).status).toBe(404);
  });
});
