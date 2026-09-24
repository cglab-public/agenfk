/**
 * efcacdeb (C2) - a command check the server runs: argv without a shell, in the
 * card's tree, passing on exit 0; never from a registry-installed flow; and,
 * when the check asks for it, only after a person approved that exact command
 * with a passkey.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./command-check-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-cmdcheck-pk-'));
const STORE = path.join(STORE_DIR, 'passkeys.json');
process.env.AGENFK_PASSKEY_STORE = STORE;

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { SoftAuthenticator } from './softAuthenticator';

let __server: import('http').Server;
const agent = () => request(__server);
const repos: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const r of [...repos, STORE_DIR]) fs.rmSync(r, { recursive: true, force: true });
});
beforeEach(() => { fs.rmSync(STORE, { force: true }); });

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const board = () => ({ 'x-agenfk-ui': '1' });

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
const flowWith = (checks: unknown[]) => [s('START', 0, { isAnchor: true }), s('WORK', 1, { checks }), s('NEXT', 2), s('END', 3, { isAnchor: true })];
const cmd = (argv: string[], extra: Record<string, unknown> = {}) => ({ id: 'command-check', params: { name: 'lint', argv, ...extra } });
const node = (code: string, ...args: string[]) => [process.execPath, '-e', code, ...args];

/** A card on WORK of a project whose flow carries `checks`; `root: false` gives it no tree. */
async function onWork(checks: unknown[], { root = true, origin }: { root?: boolean; origin?: string } = {}) {
  const f = await agent().post('/flows').send({ name: `cmd-${++seq}`, steps: flowWith(checks) });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  if (origin) await storage.updateFlow(f.body.id, { origin } as never);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-cmd-repo-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > marker && git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const p = await agent().post('/projects').send({ name: `cmd-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, ...(root ? { projectRoot: dir } : {}) } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `cmd-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'WORK' } as any);
  return { id: c.body.id as string, pid: p.body.id as string, dir };
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const verdict = async (id: string) => {
  const r = await validate(id);
  const item = (await agent().get(`/items/${id}`)).body;
  const c = (item.lastChecks?.results ?? []).find((x: any) => x.id === 'command-check:lint');
  return { status: r.status, moved: item.status !== 'WORK', check: c };
};

describe('efcacdeb (C2): a command check the server runs', () => {
  it('passes when the command exits 0, and the card moves', async () => {
    const { id } = await onWork([cmd(node('process.exit(0)'))]);
    const v = await verdict(id);
    expect(v.check).toMatchObject({ outcome: 'pass', blocking: false });
    expect(v.moved).toBe(true);
  });

  it('blocks when the command fails, with its exit code and the tail of its output', async () => {
    const { id } = await onWork([cmd(node("console.log('lint: 2 problems'); process.exit(3)"))]);
    const v = await verdict(id);
    expect(v.status).toBe(422);
    expect(v.check).toMatchObject({ outcome: 'fail', blocking: true });
    expect(v.check.detail).toMatch(/exit(ed)? (code )?3/);
    expect(v.check.detail).toMatch(/lint: 2 problems/);
  });

  it("runs in the card's tree", async () => {
    const { id } = await onWork([cmd(node("process.exit(require('fs').existsSync('marker') ? 0 : 1)"))]);
    expect((await verdict(id)).check.outcome).toBe('pass');
  });

  it('runs without a shell: each argument arrives exactly as written', async () => {
    const { id } = await onWork([cmd(node("process.exit(process.argv[1] === 'a b && $HOME; c' ? 0 : 1)", 'a b && $HOME; c'))]);
    expect((await verdict(id)).check.outcome).toBe('pass');
  });

  it("does not hand agenfk's own secrets to the command", async () => {
    process.env.AGENFK_TEST_SECRET = 'leak';
    try {
      const { id } = await onWork([cmd(node('process.exit(process.env.AGENFK_TEST_SECRET ? 1 : 0)'))]);
      expect((await verdict(id)).check.outcome).toBe('pass');
    } finally { delete process.env.AGENFK_TEST_SECRET; }
  });

  it('blocks, saying so, when the program does not exist', async () => {
    const { id } = await onWork([cmd(['definitely-not-a-program-agenfk'])]);
    const v = await verdict(id);
    expect(v.check).toMatchObject({ outcome: 'fail', blocking: true });
    expect(v.check.detail).toMatch(/not found|ENOENT/i);
  });

  it('never runs a command from a flow installed from the community registry', async () => {
    const { id, dir } = await onWork([cmd(node("require('fs').writeFileSync('ran', 'x')"))], { origin: 'registry' });
    const v = await verdict(id);
    expect(v.check).toMatchObject({ outcome: 'fail', blocking: true });
    expect(v.check.detail).toMatch(/registry/);
    expect(fs.existsSync(path.join(dir, 'ran'))).toBe(false);
  });

  it('cannot judge without a tree', async () => {
    const { id } = await onWork([cmd(node('process.exit(0)'))], { root: false });
    expect((await verdict(id)).check.outcome).toBe('unavailable');
  });

  describe('with approval: person', () => {
    const argv = node('process.exit(0)');
    const approveCommand = async (pid: string, a: SoftAuthenticator | null, theArgv = argv) => {
      const hash = crypto.createHash('sha256').update(JSON.stringify(theArgv)).digest('hex');
      let assertion: unknown;
      if (a) {
        const ch = (await agent().post('/webauthn/challenge').set(board()).send({ purpose: 'command', itemId: pid, checkId: hash })).body.challenge;
        assertion = a.assert(ch);
      }
      return agent().post(`/projects/${pid}/command-approvals`).set(board()).send({ argv: theArgv, ...(assertion ? { assertion } : {}) });
    };
    const enrolled = async () => {
      const a = new SoftAuthenticator();
      const ch = (await agent().post('/webauthn/challenge').set(board()).send({ purpose: 'enroll' })).body.challenge;
      expect((await agent().post('/webauthn/credentials').set(board()).send({ registration: a.register(ch) })).status).toBe(201);
      return a;
    };

    it('blocks until a person approves the exact command, showing it and how', async () => {
      const { id } = await onWork([cmd(argv, { approval: 'person' })]);
      const v = await verdict(id);
      expect(v.check).toMatchObject({ outcome: 'fail', blocking: true });
      expect(v.check.detail).toContain(JSON.stringify(argv));
      expect(v.check.detail).toMatch(/approve/i);
    });

    it('runs once a person approved it with a passkey', async () => {
      const a = await enrolled();
      const { id, pid } = await onWork([cmd(argv, { approval: 'person' })]);
      const r = await approveCommand(pid, a);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await verdict(id)).check.outcome).toBe('pass');
    });

    it("refuses an approval that is not signed with a passkey, or not made on the board", async () => {
      await enrolled();
      const { pid } = await onWork([cmd(argv, { approval: 'person' })]);
      expect((await approveCommand(pid, null)).status).toBe(401);
      const agentTry = await agent().post(`/projects/${pid}/command-approvals`).set(internal()).send({ argv });
      expect(agentTry.status).toBe(403);
    });

    it('asks again when the command changes', async () => {
      const a = await enrolled();
      const { id, pid } = await onWork([cmd(node('process.exit(0)', 'changed'), { approval: 'person' })]);
      await approveCommand(pid, a); // approves the ORIGINAL argv only
      expect((await verdict(id)).check.outcome).toBe('fail');
    });
  });
});
