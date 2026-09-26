/**
 * @file BUG d26832d6 (CGLAB-415) — the check-engine mechanics behind the field
 * findings, in CI. The Docker harness (e2e/tdd-harness, scenarios/70-*) walks
 * the same cases on every runner; these pin the server's side of them in the
 * suite that always runs:
 *  - agenfk's own report directory is never the card's work, and only a
 *    directory that is plainly a report's is taken as one;
 *  - a capture that could not be used holds the card (CAPTURE_UNUSABLE), and
 *    only an override given against that verdict lifts it;
 *  - a rollback keeps the greens it set aside (a re-entry runs no suite), and
 *    cannot launder a change to tests a step froze;
 *  - several reports are read as one run, and a missing one is named;
 *  - `.gitignore` is content (a suite can read it).
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

const TEST_DB = path.resolve('./check-enhancements-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN, reportOwned } from '../server';
import { surfaceOf } from '../stepRecords';
import { formatCheckResults, describeCapture } from '../checkEngine';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
const savedHome = process.env.HOME;
beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-enh-home-'));
  dirs.push(home);
  process.env.HOME = home;
  await initStorage();
  __server = app.listen(0);
});
afterAll(() => { process.env.HOME = savedHome; });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) { const f = `${TEST_DB}${suffix}`; if (fs.existsSync(f)) fs.unlinkSync(f); }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

/** A toy runner: tests/*.test.js lines `T <name> <key>=<value>` pass when src/impl.json has that value; writes a vitest-style JSON report to argv[2]. */
const RUNNER = `const fs=require('fs'),path=require('path');
const out=process.argv[2]||'report.json';
const impl=fs.existsSync('src/impl.json')?JSON.parse(fs.readFileSync('src/impl.json','utf8')):{};
const testResults=fs.readdirSync('tests').filter(f=>f.endsWith('.test.js')).map(f=>{const name=path.resolve('tests',f);
const r=fs.readFileSync(path.join('tests',f),'utf8').split('\\n').filter(l=>l.startsWith('T ')).map(l=>{const [,n,kv]=l.split(' ');const [k,v]=kv.split('=');
return impl[k]===v?{fullName:n,status:'passed',failureMessages:[]}:{fullName:n,status:'failed',failureMessages:['AssertionError: expected']};});
return{name,status:r.some(x=>x.status==='failed')?'failed':'passed',message:'',assertionResults:r};});
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({testResults}));
process.exit(testResults.some(t=>t.status==='failed')?1:0);
`;

function makeRepo(gitignore = 'report.*\n'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-enh-'));
  dirs.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: '/bin/sh' });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'runner.cjs'), RUNNER);
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'T add_works add=ok\n');
  fs.writeFileSync(path.join(dir, 'src/impl.json'), JSON.stringify({ add: 'ok' }));
  fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
  execSync('git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}
const write = (dir: string, f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };

/** A report command that counts its runs in a file outside the tree. */
function counted(command: string) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-enh-runs-')), 'runs');
  dirs.push(path.dirname(file));
  return { command: `echo x >> ${file}; ${command}`, runs: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0) };
}

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
const STEPS = [
  s('START', 0, { isAnchor: true }), s('ASK', 1, { role: 'planning' }), s('SPECS', 2, { role: 'test-authoring' }),
  s('BUILD', 3, { role: 'coding' }), s('TIDY', 4, { role: 'refactoring' }), s('LOOK', 5), s('FINISHED', 6, { isAnchor: true, role: 'closing' }),
];
async function setup(testReport: Record<string, unknown>, gitignore?: string) {
  const dir = makeRepo(gitignore);
  const f = await agent().post('/flows').send({ name: `enh-${++seq}`, steps: STEPS });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `enh-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'node runner.cjs', testReport } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'START' } as any);
  return { dir, pid: p.body.id as string, id: c.body.id as string };
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const item = async (id: string) => (await agent().get(`/items/${id}`)).body;
async function advanceTo(id: string, step: string, work: Record<string, () => void> = {}) {
  for (let guard = 0; guard < 8; guard++) {
    const on = (await item(id)).status;
    if (on === step) return;
    work[on]?.();
    const r = await validate(id);
    expect(r.status, `${on}: ${JSON.stringify(r.body).slice(0, 600)}`).toBe(200);
  }
  throw new Error(`never reached ${step}`);
}
const HONEST = (dir: string) => ({
  SPECS: () => write(dir, 'tests/mul.test.js', 'T mul_works mul=12\n'),
  BUILD: () => write(dir, 'src/impl.json', JSON.stringify({ add: 'ok', mul: '12' })),
});

describe('reportOwned: only a directory that is plainly a report\'s', () => {
  it('owns a dot-directory or a reports directory holding nothing tracked', () => {
    const dir = makeRepo();
    expect(reportOwned(dir, '.reports/r.xml')).toEqual(['.reports/r.xml', '.reports']);
    expect(reportOwned(dir, 'build/test-reports/r.xml')).toEqual(['build/test-reports/r.xml', 'build/test-reports']);
  });

  it('never owns an ordinary directory, even one whose files are all untracked (a new tests/ is the card\'s work)', () => {
    const dir = makeRepo();
    write(dir, 'spec/new.test.js', 'T x x=1\n');
    expect(reportOwned(dir, 'spec/report.xml')).toEqual(['spec/report.xml']);
  });

  it('never owns a directory holding a tracked file, nor one under a declared test path', () => {
    const dir = makeRepo();
    expect(reportOwned(dir, 'tests/report.xml')).toEqual(['tests/report.xml']);
    expect(reportOwned(dir, '.reports/r.xml', ['.reports'])).toEqual(['.reports/r.xml']);
    expect(reportOwned(dir, 'r.xml')).toEqual(['r.xml']);
  });
});

describe('an unignored report directory the command writes several files into', () => {
  it('is no change of the card\'s: the baseline is usable and the tests-only step sees only the tests', async () => {
    const c = counted('node runner.cjs .reports/r.json; e=$?; echo side > .reports/side.txt; exit $e');
    const t = await setup({ format: 'vitest-json', command: c.command, reportPath: '.reports/r.json' }, 'node_modules\n');
    await advanceTo(t.id, 'SPECS');
    const entry = (await item(t.id)).stepRecords.filter((r: any) => r.kind === 'capture').pop();
    expect(entry).toMatchObject({ step: 'ASK', available: true });
    expect(entry.parseError).toBeUndefined();
    HONEST(t.dir).SPECS();
    const r = await validate(t.id);
    expect(r.status, JSON.stringify(r.body).slice(0, 600)).toBe(200);
  });
});

describe('CAPTURE_UNUSABLE: a baseline the run could not tie to its tree holds the card', () => {
  const FIRST_RUN_DIRTIES = 'node runner.cjs; e=$?; [ -f gen/s ] || { mkdir -p gen; date > gen/s; }; exit $e';

  it('holds on the step before the one that reads it, naming the cause; the next clean run lets it go', async () => {
    const t = await setup({ format: 'vitest-json', command: FIRST_RUN_DIRTIES, reportPath: 'report.json' }, 'report.*\n');
    await advanceTo(t.id, 'ASK');
    const held = await validate(t.id);
    expect(held.status).toBe(422);
    const hold = held.body.checks.find((x: any) => x.id === 'entry-baseline');
    expect(hold).toMatchObject({ blocking: true, meta: { code: 'CAPTURE_UNUSABLE' } });
    expect(hold.detail).toMatch(/tree changed while the command ran/);
    expect((await validate(t.id)).status).toBe(200);
  });

  it('is lifted only by an override given against that verdict', async () => {
    const t = await setup({ format: 'vitest-json', command: FIRST_RUN_DIRTIES, reportPath: 'report.json' }, 'report.*\n');
    await advanceTo(t.id, 'ASK');
    // An override on this step given earlier, for another cause.
    const card: any = await storage.getItem(t.id);
    await storage.updateItem(t.id, { stepRecords: [...(card.stepRecords ?? []), { id: 'o1', step: 'ASK', kind: 'override', at: new Date().toISOString(), by: 'board', check: 'entry-baseline', reason: 'runner writes no report', detail: 'ASK judges... and this project records none' }] } as any);
    const held = await validate(t.id);
    expect(held.status).toBe(422);
    expect(held.body.checks.find((x: any) => x.id === 'entry-baseline')).toMatchObject({ blocking: true });
  });

  it('names a report the command did not write, when several are read as one run', async () => {
    const t = await setup({ format: 'vitest-json', command: 'node runner.cjs report.json', reportPath: ['report.json', 'second.json'] }, 'report.*\nsecond.*\n');
    await advanceTo(t.id, 'ASK');
    const held = await validate(t.id);
    expect(held.status).toBe(422);
    expect(held.body.checks.find((x: any) => x.id === 'entry-baseline').detail).toMatch(/second\.json was not written/);
  });

  it('reads several reports as one run', async () => {
    const t = await setup({ format: 'vitest-json', command: 'node runner.cjs report.json; e=$?; cp report.json second.json; exit $e', reportPath: ['report.json', 'second.json'] }, 'report.*\nsecond.*\n');
    await advanceTo(t.id, 'SPECS');
    const entry = (await item(t.id)).stepRecords.filter((r: any) => r.kind === 'capture').pop();
    expect(entry).toMatchObject({ available: true, reportPaths: ['report.json', 'second.json'] });
  });
});

describe('a rollback: greens kept for reuse, frozen tests not laundered', () => {
  async function atTidy() {
    const c = counted('node runner.cjs');
    const t = await setup({ format: 'vitest-json', command: c.command, reportPath: 'report.json' });
    await advanceTo(t.id, 'TIDY', HONEST(t.dir));
    return { ...t, runs: c.runs };
  }

  it('re-entering on an unchanged tree runs no suite: the rollback set the greens aside, it did not drop them', async () => {
    const t = await atTidy();
    const before = t.runs();
    expect((await agent().put(`/items/${t.id}`).send({ status: 'BUILD' })).status).toBe(200);
    expect(((await item(t.id)).supersededRecords ?? []).length).toBeGreaterThan(0);
    await advanceTo(t.id, 'LOOK');
    expect(t.runs()).toBe(before);
  });

  it('refuses to leave a test-freezing step backwards while its tests differ from its entry, naming them', async () => {
    const t = await atTidy();
    write(t.dir, 'tests/mul.test.js', 'T mul_renamed mul=12\n');
    const r = await agent().put(`/items/${t.id}`).send({ status: 'BUILD' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/TESTS CHANGED ON TIDY: edited tests\/mul\.test\.js/);
    expect((await item(t.id)).status).toBe('TIDY');
  });

  it('sees a brand-new test file added on the step, with no declared test paths', async () => {
    const t = await atTidy();
    write(t.dir, 'tests/sneak.test.js', 'T sneaks add=ok\n');
    const r = await agent().put(`/items/${t.id}`).send({ status: 'BUILD' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/new or changed tests\/sneak\.test\.js/);
  });

  it('does not count a committed test file the suite never runs as an addition: a no-change rollback goes through', async () => {
    // e2e tests, another package's tests: in the tree all along, outside what the suite runs.
    const c = counted('node runner.cjs');
    const t = await setup({ format: 'vitest-json', command: c.command, reportPath: 'report.json' });
    write(t.dir, 'e2e/flow.test.js', 'never run by this suite\n');
    execSync('git add e2e && git commit -qm e2e', { cwd: t.dir, shell: '/bin/sh' });
    await advanceTo(t.id, 'TIDY', HONEST(t.dir));
    const r = await agent().put(`/items/${t.id}`).send({ status: 'BUILD' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('closes the way round through PAUSED: pausing, then sending the card to the coding step, is refused the same', async () => {
    const t = await atTidy();
    write(t.dir, 'tests/mul.test.js', 'T mul_renamed mul=12\n');
    expect((await agent().put(`/items/${t.id}`).send({ status: 'PAUSED' })).status).toBe(200);
    const r = await agent().put(`/items/${t.id}`).send({ status: 'BUILD' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/TESTS CHANGED ON TIDY/);
  });

  it('lets the card go back to the step that writes tests, which reopens them', async () => {
    const t = await atTidy();
    write(t.dir, 'tests/mul.test.js', 'T mul_renamed mul=12\n');
    expect((await agent().put(`/items/${t.id}`).send({ status: 'PAUSED' })).status).toBe(200);
    const r = await agent().put(`/items/${t.id}`).send({ status: 'SPECS' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('lets a card roll back and re-work the code (and its tests) on the coding step', async () => {
    const t = await atTidy();
    expect((await agent().put(`/items/${t.id}`).send({ status: 'BUILD' })).status).toBe(200);
    write(t.dir, 'tests/extra.test.js', 'T mul_again mul=12\n');
    const r = await validate(t.id);
    expect(r.status, JSON.stringify(r.body).slice(0, 600)).toBe(200);
    expect((await item(t.id)).status).toBe('TIDY');
  });

  it('.gitignore is content: changing it runs the suite again (a suite can read it)', async () => {
    const t = await atTidy();
    const before = t.runs();
    write(t.dir, '.gitignore', 'report.*\n# tidied\n');
    await validate(t.id);
    expect(t.runs()).toBe(before + 1);
  });
});

describe('surfaceOf: a suite run in a subdirectory names its files from there', () => {
  it('resolves a reported path by the one tree file ending with it, and leaves an ambiguous one missing', () => {
    const dir = makeRepo();
    write(dir, 'app/lib/x.test.ts', 'x');
    write(dir, 'a/util/y.test.ts', 'y');
    write(dir, 'b/util/y.test.ts', 'y');
    const listTree = () => ['app/lib/x.test.ts', 'a/util/y.test.ts', 'b/util/y.test.ts'];
    const got = surfaceOf(dir, ['lib/x.test.ts', 'util/y.test.ts'], [], { listTree });
    expect(Object.keys(got.files)).toContain('app/lib/x.test.ts');
    expect(got.missing).toEqual(['util/y.test.ts']);
  });
});

describe('what verify says', () => {
  const r = (id: string, outcome: string, blocking: boolean, severity = 'block') => ({ id, step: 'S', source: 'role', severity, params: {}, outcome, blocking, detail: id } as any);

  it('prints a blocking check last, right above the verdict, after passes and warnings', () => {
    const lines = formatCheckResults([r('blocker', 'fail', true), r('fine', 'pass', false), r('warned', 'fail', false, 'warn')]).split('\n');
    expect(lines.map(l => l.split(' ')[1])).toEqual(['fine', 'warned', 'blocker']);
  });

  it('says a non-blocking unavailable judged nothing', () => {
    expect(formatCheckResults([r('soft', 'unavailable', false)])).toMatch(/not judged, not blocking/);
  });

  it('says whether the suite ran or a green was reused, and whose', () => {
    expect(describeCapture({ kind: 'capture', exitCode: 0 })).toMatch(/^▶ ran the suite \(exit 0\)/);
    expect(describeCapture({ kind: 'capture', exitCode: 0, reusedFrom: { itemId: 'abcdef1234', step: 'BUILD', at: 'T1' } })).toMatch(/not re-run.*T1.*BUILD of card abcdef12/);
    expect(describeCapture({ kind: 'capture', exitCode: 0, reusedFrom: { itemId: 'x' }, surfaceRereadFrom: { at: 'T2' } })).toMatch(/read again for the new declared test paths/);
  });
});
