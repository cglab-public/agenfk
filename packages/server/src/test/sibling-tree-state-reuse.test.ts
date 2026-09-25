/**
 * @file 3ffc9651 — cards in one tree share work at the same tree STATE, clean or dirty.
 *
 * Reuse used to key on a clean commit only. In the one-tree model a dirty tree
 * is the normal state (agents edit without committing until close), so a
 * simulation of three siblings walking one flow on a tree with one untracked
 * file ran the suite 9 times where the clean tree ran it twice. The state is
 * the content of every tracked and untracked (non-ignored) file, submodules
 * included; two cards that see the same state see the same inputs, so a green
 * transfers.
 *
 * - A capture reuses a green capture taken at the same state (its own or
 *   another card's), and waits on an identical one in flight.
 * - The final verify propagates a sibling's green recorded at the same state.
 * - What differs in content, or changed while the command ran, runs its own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./sibling-tree-state-reuse-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: '/bin/sh', encoding: 'utf8' }).trim();
const counter = (file: string) => () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/** A repo with one commit, and a project whose report command counts its runs outside the tree. */
async function captureSetup(sleepMs = 0, exitCode = 0) {
  const f = await agent().post('/flows').send({ name: `ts-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = tmp('agenfk-ts-repo-');
  git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && echo a > a && git add . && git commit -qm one');
  const runs = path.join(tmp('agenfk-ts-runs-'), 'runs');
  const runner = path.join(path.dirname(runs), 'runner.js');
  fs.writeFileSync(runner, `require('fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');
setTimeout(() => {
  require('fs').writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="adds numbers" file="t.test.js"/></testsuite></testsuites>');
  process.exit(${exitCode});
}, ${sleepMs});`);
  const p = await agent().post('/projects').send({ name: `ts-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true', testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml' } } as never);
  const card = async () => {
    const c = await agent().post('/items').send({ type: 'TASK', title: `ts-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'WORK' } as any);
    return c.body.id as string;
  };
  return { repo, card, count: counter(runs) };
}

const capture = (id: string) => agent().post(`/items/${id}/step-records/capture`).set(internal()).send({});

describe('3ffc9651: a capture reuses a green taken at the same tree state, clean or dirty', () => {
  it('a second card on the same DIRTY tree reuses the first card\'s green: the suite runs once', async () => {
    const t = await captureSetup();
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'another agent is mid-edit\n');
    const a = await t.card();
    const ra = await capture(a);
    expect(ra.status, JSON.stringify(ra.body)).toBe(200);
    expect(ra.body).toMatchObject({ clean: false, available: true, exitCode: 0 });
    expect(ra.body.reusedFrom).toBeUndefined();

    const b = await t.card();
    const rb = await capture(b);
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(t.count()).toBe(1);
    expect(rb.body).toMatchObject({ clean: false, available: true, exitCode: 0, reusedFrom: { itemId: a } });
    expect(rb.body.tests).toEqual(ra.body.tests);
  });

  it('a card capturing again at an unchanged dirty state reuses its own green', async () => {
    const t = await captureSetup();
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'mid-edit\n');
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    const again = await capture(a);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(t.count()).toBe(1);
    expect(again.body.reusedFrom).toMatchObject({ itemId: a });
  });

  it('different content is not the same state: the second card runs its own', async () => {
    const t = await captureSetup();
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'one\n');
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'two\n');
    const b = await t.card();
    const rb = await capture(b);
    expect(rb.status).toBe(200);
    expect(t.count()).toBe(2);
    expect(rb.body.reusedFrom).toBeUndefined();
  });

  it('a change to a TRACKED file is content too, even with no untracked file around', async () => {
    const t = await captureSetup();
    fs.writeFileSync(path.join(t.repo, 'a'), 'edited\n');
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    fs.writeFileSync(path.join(t.repo, 'a'), 'edited again\n');
    const b = await t.card();
    expect((await capture(b)).body.reusedFrom).toBeUndefined();
    expect(t.count()).toBe(2);
  });

  // The state is the files' content (3ffc9651 round 2): a sibling's close commit commits files, it does not change
  // them, and keying on HEAD made every close break reuse for the next card.
  it('the same content after a commit is the same state: a sibling\'s close does not make the next card run again', async () => {
    const t = await captureSetup();
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'mid-edit\n');
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    git(t.repo, 'git add notes.txt && git commit -qm a-closes');
    const b = await t.card();
    const rb = await capture(b);
    expect(rb.body.reusedFrom).toMatchObject({ itemId: a });
    expect(t.count()).toBe(1);
  });

  it('a red dirty capture is not reused: the next card runs its own', async () => {
    const t = await captureSetup(0, 1);
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'mid-edit\n');
    const [a, b] = [await t.card(), await t.card()];
    expect((await capture(a)).status).toBe(200);
    const rb = await capture(b);
    expect(rb.body.reusedFrom).toBeUndefined();
    expect(t.count()).toBe(2);
  });

  it('two cards capturing one identical dirty tree at once run the suite once', async () => {
    const t = await captureSetup(800);
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'mid-edit\n');
    const [a, b] = [await t.card(), await t.card()];
    const [ra, rb] = await Promise.all([capture(a), capture(b)]);
    expect(ra.status, JSON.stringify(ra.body)).toBe(200);
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(t.count()).toBe(1);
    expect([ra.body, rb.body].filter(r => r.reusedFrom)).toHaveLength(1);
  });
});

/** A STORY with TASK children on the step before DONE, whose verify command counts its runs outside the tree. */
async function verifySetup(command?: (runs: string) => string) {
  const repo = tmp('agenfk-ts-prop-');
  git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a.txt && git add . && git commit -qm one');
  const runs = path.join(tmp('agenfk-ts-prop-runs-'), 'runs');
  const verifyCommand = command ? command(runs) : `node -e "require('fs').appendFileSync(${JSON.stringify(runs).replace(/"/g, '\\"')}, 'run\\n')"`;
  const p = (await agent().post('/projects').set(internal()).send({ name: `ts-prop-${++seq}` })).body;
  await storage.updateProject(p.id, { projectRoot: repo, verifyCommand } as never);
  const parent = (await agent().post('/items').set(internal()).send({ type: 'STORY', title: 'p', projectId: p.id })).body;
  const child = async () => {
    const c = (await agent().post('/items').set(internal()).send({ type: 'TASK', title: `c-${++seq}`, projectId: p.id, parentId: parent.id })).body;
    await storage.updateItem(c.id, { status: 'TEST' } as any);
    return c.id as string;
  };
  return { repo, child, count: counter(runs) };
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const testRecordsOf = (item: any): any[] => (Array.isArray(item?.tests) ? item.tests : []);

describe('3ffc9651: the final verify propagates a sibling green recorded at the same tree state', () => {
  it('siblings on one DIRTY tree: the first runs the command, the next propagates', async () => {
    const t = await verifySetup();
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'another agent is mid-edit\n');
    const a = await t.child();
    const ra = await validate(a);
    expect(ra.body.status, JSON.stringify(ra.body)).toBe('DONE');
    expect(t.count()).toBe(1);

    const b = await t.child();
    const rb = await validate(b);
    expect(rb.body.status, JSON.stringify(rb.body)).toBe('DONE');
    expect(rb.body.output, 'the sibling ran the command on the very state the first one verified').toBe('Sibling propagation');
    expect(t.count()).toBe(1);
  });

  it('a chain of siblings, each closing with its own commit: the command runs once for all of them', async () => {
    // The test process makes no close commit (autoGitCommit is off under vitest), so each close is committed here,
    // exactly as the server would: the card's own files, content unchanged.
    const t = await verifySetup();
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(t.repo, `${n}.js`), `module.exports = '${n}';\n`);
    const out: string[] = [];
    for (const n of ['a', 'b', 'c']) {
      const id = await t.child();
      const r = await validate(id);
      expect(r.body.status, JSON.stringify(r.body)).toBe('DONE');
      out.push(r.body.output === 'Sibling propagation' ? 'propagated' : 'ran');
      git(t.repo, `git add ${n}.js && git commit -qm ${n}-closes`);
    }
    expect(out).toEqual(['ran', 'propagated', 'propagated']);
    expect(t.count()).toBe(1);
  });

  it('siblings closing at once: one runs the command, the others wait for it and propagate', async () => {
    const t = await verifySetup(runs => `node -e "require('fs').appendFileSync(${JSON.stringify(runs).replace(/"/g, '\\"')},'run\\n');setTimeout(()=>{},800)"`);
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'mid-edit\n');
    const ids = [await t.child(), await t.child(), await t.child()];
    const rs = await Promise.all(ids.map(validate));
    for (const r of rs) expect(r.body.status, JSON.stringify(r.body)).toBe('DONE');
    expect(t.count()).toBe(1);
    expect(rs.filter(r => r.body.output === 'Sibling propagation')).toHaveLength(2);
  });

  it('siblings closing at once, the first run fails: a waiting sibling runs its own', async () => {
    const t = await verifySetup(runs => `node -e "require('fs').appendFileSync(${JSON.stringify(runs).replace(/"/g, '\\"')},'run\\n');setTimeout(()=>process.exit(1),500)"`);
    const ids = [await t.child(), await t.child()];
    const rs = await Promise.all(ids.map(validate));
    for (const r of rs) expect(r.body.status).not.toBe('DONE');
    expect(t.count()).toBe(2);
  });

  it('the dirty content changed after the first sibling verified: the next runs its own', async () => {
    const t = await verifySetup();
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'one\n');
    const a = await t.child();
    expect((await validate(a)).body.status).toBe('DONE');
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'two\n');
    const b = await t.child();
    const rb = await validate(b);
    expect(rb.body.status).toBe('DONE');
    expect(rb.body.output).not.toBe('Sibling propagation');
    expect(t.count()).toBe(2);
  });

  it('a caller cannot write a treeState onto a test record: only the server ties a green to a state', async () => {
    const t = await verifySetup();
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'mid-edit\n');
    const a = await t.child();
    const forged = { id: 'forged', command: (await storage.getProject((await storage.getItem(a) as any).projectId) as any).verifyCommand, status: 'PASSED', executedAt: new Date().toISOString(), treeState: 'anything', commitRoot: t.repo };
    const put = await agent().put(`/items/${a}`).set(internal()).send({ tests: [forged] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const stored = testRecordsOf(await storage.getItem(a));
    expect(stored.find((x: any) => x.id === 'forged')).toBeDefined();
    expect(stored.find((x: any) => x.id === 'forged').treeState).toBeUndefined();
  });

  it('a command that changed an already-dirty file while it ran leaves nothing to propagate', async () => {
    // Appending to a file that is already untracked leaves `git status` exactly as it was, so only the
    // content fence sees it: the green describes the state the run started on, which no longer exists.
    const t = await verifySetup(runs => `node -e "const fs=require('fs');fs.appendFileSync(${JSON.stringify(runs).replace(/"/g, '\\"')},'run\\n');fs.appendFileSync('notes.txt','more\\n')"`);
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'mid-edit\n');
    const a = await t.child();
    expect((await validate(a)).body.status).toBe('DONE');
    expect(testRecordsOf(await storage.getItem(a)).some((x: any) => x.treeState), 'a state was stamped on a run that changed the tree').toBe(false);
    const b = await t.child();
    const rb = await validate(b);
    expect(rb.body.output).not.toBe('Sibling propagation');
    expect(t.count()).toBe(2);
  });
});

/** A flow START -> GATE (a person approves) -> WORK -> END, with a STORY and TASK children on WORK. */
async function gatedSetup(command: (runs: string) => string) {
  const repo = tmp('agenfk-ts-gate-');
  git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a.txt && git add . && git commit -qm one');
  const runs = path.join(tmp('agenfk-ts-gate-runs-'), 'runs');
  const f = await agent().post('/flows').send({ name: `ts-gate-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('GATE', 1, { checks: [{ id: 'human-approval' }] }), s('WORK', 2), s('END', 3, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = (await agent().post('/projects').set(internal()).send({ name: `ts-gate-${++seq}` })).body;
  await storage.updateProject(p.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: command(runs) } as never);
  const parent = (await agent().post('/items').set(internal()).send({ type: 'STORY', title: 'p', projectId: p.id })).body;
  const child = async () => {
    const c = (await agent().post('/items').set(internal()).send({ type: 'TASK', title: `g-${++seq}`, projectId: p.id, parentId: parent.id })).body;
    await storage.updateItem(c.id, { status: 'WORK' } as any);
    return c.id as string;
  };
  return { repo, child, count: counter(runs) };
}
const slowCommand = (ms: number) => (runs: string) => `node -e "require('fs').appendFileSync(${JSON.stringify(runs).replace(/"/g, '\\"')},'run\\n');setTimeout(()=>{},${ms})"`;

describe('3ffc9651 review: a sibling that waited on another\'s final verify', () => {
  it('is refused, not advanced, when its card was moved back while it waited: the gate it carries judged another step', async () => {
    const t = await gatedSetup(slowCommand(1500));
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'mid-edit\n');
    const [a, b] = [await t.child(), await t.child()];
    const ra = validate(a).then(r => r);
    await new Promise(r => setTimeout(r, 300));
    const rb = validate(b).then(r => r);
    await new Promise(r => setTimeout(r, 300));
    // Rolled back onto the step a person must approve, while B waits on A's run.
    await storage.updateItem(b, { status: 'GATE' } as any);
    const [va, vb] = await Promise.all([ra, rb]);
    expect(va.body.status, JSON.stringify(va.body)).toBe('END');
    expect(vb.status, JSON.stringify(vb.body)).toBe(409);
    expect((await storage.getItem(b) as any).status, 'the approval gate was passed without a person').toBe('GATE');
  });

  it('records its evidence once', async () => {
    const t = await verifySetup(slowCommand(800));
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'mid-edit\n');
    const [a, b] = [await t.child(), await t.child()];
    const rs = await Promise.all([validate(a), validate(b)]);
    for (const r of rs) expect(r.body.status, JSON.stringify(r.body)).toBe('DONE');
    const joined = rs.find(r => r.body.output === 'Sibling propagation');
    expect(joined).toBeDefined();
    const id = joined === rs[0] ? a : b;
    const evidence = ((await storage.getItem(id) as any).comments ?? []).filter((c: any) => /\*\*Evidence/.test(String(c.content)));
    expect(evidence).toHaveLength(1);
  });
});

describe('3ffc9651 review: submodules are part of the state', () => {
  /** A repo with one submodule, sub/, whose own repo has two commits to switch between. */
  function withSubmodule() {
    const t = { lib: tmp('agenfk-ts-lib-') };
    git(t.lib, 'git init -q -b main && git config user.email t@t && git config user.name t && echo one > f && git add . && git commit -qm one && echo two > f && git commit -qam two');
    return t.lib;
  }

  it('a submodule moved to another commit is another state: the next card runs its own', async () => {
    const t = await captureSetup();
    const lib = withSubmodule();
    git(t.repo, `git -c protocol.file.allow=always submodule add -q ${lib} sub && git commit -qm sub`);
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    git(path.join(t.repo, 'sub'), 'git checkout -q HEAD~1');
    const b = await t.card();
    const rb = await capture(b);
    expect(rb.body.reusedFrom).toBeUndefined();
    expect(t.count()).toBe(2);
  });

  it('a submodule with uncommitted work is never shared: its content is not hashed', async () => {
    const t = await captureSetup();
    const lib = withSubmodule();
    git(t.repo, `git -c protocol.file.allow=always submodule add -q ${lib} sub && git commit -qm sub`);
    fs.writeFileSync(path.join(t.repo, 'sub', 'f'), 'edited inside\n');
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    const b = await t.card();
    expect((await capture(b)).body.reusedFrom).toBeUndefined();
    expect(t.count()).toBe(2);
  });
});
