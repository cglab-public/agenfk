/**
 * @file CGLAB-380 (S4-T4) — the test checks, end to end: one check library
 * enforces a TDD-shaped flow and a default-shaped flow from roles alone.
 * The cheats are the simulation's (EPIC ba077e5e). Shared harness notes:
 *
 * verify resolves the step's checks (universal + role built-ins + flow extras),
 * runs them in the card's tree, and refuses the transition when a blocking one
 * fails, in the verify failure shape old clients already print (422 with a
 * message) plus `checks[]`. Warnings are recorded and never block. Results go
 * on the card. A test report is captured only when a check needs one, and a
 * capture also serves as the NEXT step's entry record, so no suite runs just to
 * snapshot a step's start.
 *
 * Every flow here is written with step names the server has never seen: the
 * engine must work from roles and records alone.
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

const TEST_DB = path.resolve('./check-engine-tests-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const repos: string[] = [];
// Review transcripts (CGLAB-381) live under a sandboxed HOME, never the real ~/.claude.
const savedHome = process.env.HOME;
let home: string;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-engine-tests-home-'));
  repos.push(home);
  process.env.HOME = home;
  await initStorage();
  __server = app.listen(0);
});
afterAll(() => { process.env.HOME = savedHome; });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

/**
 * A toy project whose "test runner" (runner.cjs) reads tests/*.test.js lines
 * `T <name> <key>=<value>` and passes a test when src/impl.json has that value;
 * a missing key fails with a TypeError (an error, not an assertion), ` SKIP`
 * skips, and a file containing BROKEN fails to load. It writes a vitest-style
 * JSON report, so everything below goes through the real report reader.
 */
const RUNNER = `const fs=require('fs'),path=require('path');
const impl=fs.existsSync('src/impl.json')?JSON.parse(fs.readFileSync('src/impl.json','utf8')):{};
const files=fs.readdirSync('tests').filter(f=>f.endsWith('.test.js'));
const testResults=files.map(f=>{const text=fs.readFileSync(path.join('tests',f),'utf8');const name=path.resolve('tests',f);
if(text.includes('BROKEN'))return{name,status:'failed',message:'SyntaxError: boom',assertionResults:[]};
const r=text.split('\\n').filter(l=>l.startsWith('T ')).map(l=>{const [,n,kv]=l.split(' ');const [k,v]=kv.split('=');
if(l.includes(' SKIP'))return{fullName:n,status:'pending',failureMessages:[]};
if(!(k in impl))return{fullName:n,status:'failed',failureMessages:['TypeError: '+k+' is not a function']};
return impl[k]===v?{fullName:n,status:'passed',failureMessages:[]}:{fullName:n,status:'failed',failureMessages:['AssertionError: expected '+impl[k]+' to be '+v]};});
return{name,status:r.some(x=>x.status==='failed')?'failed':'passed',message:'',assertionResults:r};});
fs.writeFileSync('report.json',JSON.stringify({testResults}));
process.exit(testResults.some(t=>t.status==='failed')?1:0);
`;

/**
 * The same toy runner writing junit-xml the way node:test does: every testcase
 * says classname="<dir>" and no file (9afdba7d). `node junit.cjs <dir> [report]`
 * reads <dir>/* and writes the report (default report.xml), stamped with the
 * time of the run as real runners stamp theirs.
 */
const JUNIT_RUNNER = `const fs=require('fs'),path=require('path');
const dir=process.argv[2]||'tests';
const impl=fs.existsSync('src/impl.json')?JSON.parse(fs.readFileSync('src/impl.json','utf8')):{};
let bad=false,xml='<testsuites><testsuite name="t" timestamp="'+process.hrtime.bigint()+'">';
for(const f of fs.readdirSync(dir))for(const l of fs.readFileSync(path.join(dir,f),'utf8').split('\\n').filter(l=>l.startsWith('T '))){
const [,n,kv]=l.split(' ');const [k,v]=kv.split('=');xml+='<testcase classname="'+dir+'" name="'+n+'">';
if(impl[k]!==v){bad=true;xml+='<failure message="AssertionError: expected"/>';}xml+='</testcase>';}
fs.writeFileSync(process.argv[3]||'report.xml',xml+'</testsuite></testsuites>');process.exit(bad?1:0);
`;

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-engine-tests-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: '/bin/sh' });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'runner.cjs'), RUNNER);
  fs.writeFileSync(path.join(dir, 'junit.cjs'), JUNIT_RUNNER);
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'T add_works add=ok\n');
  fs.writeFileSync(path.join(dir, 'src/impl.json'), JSON.stringify({ add: 'ok' }));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\n');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}
const write = (dir: string, f: string, text: string) => fs.writeFileSync(path.join(dir, f), text);
const impl = (dir: string, o: Record<string, string>) => write(dir, 'src/impl.json', JSON.stringify(o));
const REPORT = { format: 'vitest-json', command: 'node runner.cjs', reportPath: 'report.json' };

/** Record an independent review by a (sandboxed) sub-agent over the whole history, as a review step now requires. */
async function reviewed(id: string, dir: string) {
  const first = execSync('git rev-list --max-parents=0 HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  const tdir = path.join(home, '.claude', 'projects', '-repo', 'sess', 'subagents');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-repo', 'sess.jsonl'), JSON.stringify({ sessionId: 'sess', timestamp: '2099-01-01T00:00:00.000Z' }) + '\n');
  const t = path.join(tdir, `agent-${id.slice(0, 8)}.jsonl`);
  fs.writeFileSync(t, JSON.stringify({ isSidechain: true, agentId: id.slice(0, 8), sessionId: 'sess', timestamp: '2099-01-01T00:00:00.000Z' }) + '\n');
  const r = await agent().post(`/items/${id}/review-records`).set(internal()).send({ transcript: t, range: `${first}..${head}`, findings: [] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

let seq = 0;
async function flow(steps: any[]): Promise<string> {
  const res = await agent().post('/flows').send({ name: `engine-${++seq}`, steps });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
async function project(flowId: string | null, extra: Record<string, unknown> = {}) {
  const p = await agent().post('/projects').send({ name: `engine-${++seq}` });
  expect(p.status).toBe(201);
  await storage.updateProject(p.body.id, { ...(flowId ? { flowId } : {}), ...extra } as never);
  return p.body.id as string;
}
async function card(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  expect(c.status).toBe(201);
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const validate = (id: string, body: Record<string, unknown> = {}) =>
  agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok', ...body });
const item = async (id: string) => (await agent().get(`/items/${id}`)).body;
const byId = (checks: any[], id: string) => checks.find((c: any) => c.id === id);

const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/** TDD-shaped, with names the server has never seen. */
const tddSteps = (extra: Record<string, any[]> = {}) => [
  s('START', 0, { isAnchor: true }),
  s('ASK', 1, { role: 'planning' }),
  s('SPECS', 2, { role: 'test-authoring', ...(extra.SPECS ? { checks: extra.SPECS } : {}) }),
  s('BUILD', 3, { role: 'coding', ...(extra.BUILD ? { checks: extra.BUILD } : {}) }),
  s('TIDY', 4, { role: 'refactoring' }),
  s('LOOK', 5, { role: 'review' }),
  s('FINISHED', 6, { isAnchor: true, role: 'closing' }),
];

/** A card walked honestly to SPECS: the entry capture (1 passing test) is recorded. */
async function atSpecs(extra: Record<string, any[]> = {}) {
  const dir = makeRepo();
  const pid = await project(await flow(tddSteps(extra)), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT });
  const id = await card(pid, 'START');
  for (const expected of ['ASK', 'SPECS']) {
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await item(id)).status).toBe(expected);
  }
  return { dir, id };
}
const honestTests = (dir: string) => write(dir, 'tests/mul.test.js', 'T mul_works mul=12\nT mul_again mul=12\n');
/** ...and on to BUILD with honest red tests. */
async function atBuild(extra: Record<string, any[]> = {}) {
  const at = await atSpecs(extra);
  honestTests(at.dir);
  const r = await validate(at.id);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect((await item(at.id)).status).toBe('BUILD');
  return at;
}
const refused = async (id: string, check: string) => {
  const r = await validate(id);
  expect(r.status, JSON.stringify(r.body)).toBe(422);
  // A check can run twice (a role's and a stricter one the flow adds): take the one that blocked.
  const c = r.body.checks.find((x: any) => x.id === check && x.blocking) ?? byId(r.body.checks, check);
  expect(c, `${check} in ${JSON.stringify(r.body.checks)}`).toBeDefined();
  expect(c.blocking).toBe(true);
  return c;
};

describe('9afdba7d: a junit report that names no file: the project declares its test paths', () => {
  const frozen = (params: Record<string, string> = { mode: 'strict', since: 'step-entry' }) => [
    s('START', 0, { isAnchor: true }),
    s('WORK', 1, { checks: [{ id: 'test-surface-frozen', params }] }),
    s('NEXT', 2),
    s('END', 3, { isAnchor: true }),
  ];
  const report = (command: string, reportPath = 'report.xml', surface?: string[]) => ({ format: 'junit-xml', command, reportPath, ...(surface ? { surface } : {}) });
  async function onWork(dir: string, command: string, { reportPath = 'report.xml', surface, before }: { reportPath?: string; surface?: string[]; before?: (pid: string) => Promise<void> } = {}) {
    const pid = await project(await flow(frozen()), { projectRoot: dir, verifyCommand: command, testReport: report(command, reportPath, surface) });
    if (before) await before(pid);
    const id = await card(pid, 'START');
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await item(id)).status).toBe('WORK');
    return { id, pid };
  }
  /** A repo whose tests live where no convention looks: checks/, with tests/ gone. */
  function offConvention(): string {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, 'checks'));
    write(dir, 'checks/a.js', 'T add_works add=ok\n');
    execSync('git rm -rq tests && git add . && git commit -qm checks', { cwd: dir, shell: '/bin/sh' });
    return dir;
  }

  it('refuses an edit to a declared test file the report never named', async () => {
    const dir = makeRepo();
    const { id } = await onWork(dir, 'node junit.cjs tests', { surface: ['tests'] });
    write(dir, 'tests/a.test.js', 'T add_works add=ok\n// edited\n');
    const c = await refused(id, 'test-surface-frozen');
    expect(c.outcome).toBe('fail');
    expect(c.detail).toMatch(/edited tests\/a\.test\.js/);
  });

  it('passes the same tree untouched', async () => {
    const dir = makeRepo();
    const { id } = await onWork(dir, 'node junit.cjs tests', { surface: ['tests'] });
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(byId((await item(id)).lastChecks.results, 'test-surface-frozen').outcome).toBe('pass');
  });

  it('blocks when nothing is declared, and names the command with the directories that look like tests', async () => {
    const dir = makeRepo();
    const { id, pid } = await onWork(dir, 'node junit.cjs tests');
    const c = await refused(id, 'test-surface-frozen');
    expect(c.outcome).toBe('unavailable');
    expect(c.detail).toContain(`agenfk update-project ${pid} --test-report-surface tests (suggested`);
  });

  it('declaring paths off the conventions unblocks it, and then sees an edit there', async () => {
    const dir = offConvention();
    const { id } = await onWork(dir, 'node junit.cjs checks', { surface: ['checks'] });
    write(dir, 'checks/a.js', 'T add_works add=ok\n// edited\n');
    const c = await refused(id, 'test-surface-frozen');
    expect(c.outcome).toBe('fail');
    expect(c.detail).toMatch(/edited checks\/a\.js/);
  });

  it("another card's claim does not hide an edit to the tests", async () => {
    const dir = makeRepo();
    const { id } = await onWork(dir, 'node junit.cjs tests', { surface: ['tests'], before: async pid => { await card(pid, 'START', { claims: ['tests/'] }); } });
    write(dir, 'tests/a.test.js', 'T add_works add=ok\n// edited\n');
    const c = await refused(id, 'test-surface-frozen');
    expect(c.outcome).toBe('fail');
  });

  it('never counts the report the capture writes inside a declared test directory', async () => {
    const dir = makeRepo();
    const { id } = await onWork(dir, 'node junit.cjs tests tests/junit.xml', { reportPath: 'tests/junit.xml', surface: ['tests'] });
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(byId((await item(id)).lastChecks.results, 'test-surface-frozen').outcome).toBe('pass');
  });

  it('a base recorded incomplete stays so after declaring mid-card, and says to re-enter the step', async () => {
    const dir = makeRepo();
    const { id, pid } = await onWork(dir, 'node junit.cjs tests');
    await storage.updateProject(pid, { testReport: report('node junit.cjs tests', 'report.xml', ['tests']) } as any);
    const c = await refused(id, 'test-surface-frozen');
    expect(c.outcome).toBe('unavailable');
    expect(c.detail).toMatch(/re-enter/i);
  });

  it('warns, and does not compare, when the declared paths changed since the base', async () => {
    const dir = offConvention();
    fs.mkdirSync(path.join(dir, 'more'));
    write(dir, 'more/b.js', 'T add_works add=ok\n');
    execSync('git add . && git commit -qm more', { cwd: dir, shell: '/bin/sh' });
    const { id, pid } = await onWork(dir, 'node junit.cjs checks', { surface: ['checks'] });
    await storage.updateProject(pid, { testReport: report('node junit.cjs checks', 'report.xml', ['checks', 'more']) } as any);
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = byId((await item(id)).lastChecks.results, 'test-surface-frozen');
    expect(c.outcome).toBe('unavailable');
    expect(c.blocking).toBe(false);
  });

  /** SPECS writes a red test and freezes the tests; CODE runs a strict freeze since then. Vitest-style report: every name a file. */
  async function frozenAtCode(surface?: string[]) {
    const dir = makeRepo();
    const steps = [
      s('START', 0, { isAnchor: true }),
      s('SPECS', 1, { checks: [{ id: 'some-new-test-red' }] }),
      s('CODE', 2, { checks: [{ id: 'test-surface-frozen', params: { mode: 'strict' } }] }),
      s('NEXT', 3),
      s('END', 4, { isAnchor: true }),
    ];
    const pid = await project(await flow(steps), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: { ...REPORT, ...(surface ? { surface } : {}) } });
    const id = await card(pid, 'START');
    expect((await validate(id)).status).toBe(200);
    write(dir, 'tests/mul.test.js', 'T mul_works mul=12\n');
    expect((await validate(id)).status).toBe(200);
    impl(dir, { add: 'ok', mul: '12' });
    return { dir, id, pid };
  }
  const softly = async (id: string) => {
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = byId((await item(id)).lastChecks.results, 'test-surface-frozen');
    expect(c.outcome).toBe('unavailable');
    expect(c.blocking).toBe(false);
  };

  it('warns, and does not compare, when the tests were frozen by an older server', async () => {
    const { id } = await frozenAtCode();
    // As an older server froze it: a bare map of what the report named.
    const it0: any = await storage.getItem(id);
    await storage.updateItem(id, { stepRecords: it0.stepRecords.map((r: any) => (r.kind === 'record' && r.name === 'testSurface' ? { ...r, value: {} } : r)) } as any);
    await softly(id);
  });

  it('warns, and does not compare, when the declared paths changed since the tests were frozen', async () => {
    const { dir, id, pid } = await frozenAtCode();
    fs.mkdirSync(path.join(dir, 'helpers'));
    write(dir, 'helpers/h.js', 'x');
    execSync('git add . && git commit -qm helpers', { cwd: dir, shell: '/bin/sh' });
    await storage.updateProject(pid, { testReport: { ...REPORT, surface: ['helpers'] } } as any);
    await softly(id);
  });

  it('warns, and does not compare, when the entry surface was recorded by an older server', async () => {
    const dir = makeRepo();
    const { id } = await onWork(dir, 'node junit.cjs tests', { surface: ['tests'] });
    const it0: any = await storage.getItem(id);
    await storage.updateItem(id, { stepRecords: it0.stepRecords.map((r: any) => (r.kind === 'capture' ? { ...r, surface: { files: {} }, surfaceScope: undefined } : r)) } as any);
    const r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = byId((await item(id)).lastChecks.results, 'test-surface-frozen');
    expect(c.outcome).toBe('unavailable');
    expect(c.blocking).toBe(false);
  });
});

describe('4a428bb0: a card keeps the history of its checks, approvals and overrides', () => {
  const steps = () => [
    s('START', 0, { isAnchor: true }),
    s('WORK', 1, { checks: [{ id: 'jira-key-valid' }, { id: 'human-approval' }] }),
    s('NEXT', 2),
    s('END', 3, { isAnchor: true }),
  ];
  const board = { 'x-agenfk-ui': '1' };
  async function onWork() {
    const dir = makeRepo();
    const pid = await project(await flow(steps()), { projectRoot: dir });
    const id = await card(pid, 'START');
    expect((await validate(id)).status).toBe(200);
    return id;
  }
  const history = async (id: string) => {
    const r = await agent().get(`/items/${id}/check-history`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as any[];
  };

  it('records every verify, refused or passed, with its step, time and each check', async () => {
    const id = await onWork();
    expect((await validate(id)).status).toBe(422); // no key, no approval
    await agent().put(`/items/${id}`).send({ jiraItem: 'ABC-12' });
    await agent().post(`/items/${id}/approvals`).set(board).send({ step: 'WORK' });
    expect((await validate(id)).status).toBe(200);
    const h = await history(id);
    const verifies = h.filter(e => e.kind === 'verify');
    // Newest first: the passing WORK run, the refused one, then leaving START.
    expect(verifies.map(e => [e.step, e.blocked])).toEqual([['WORK', false], ['WORK', true], ['START', false]]);
    const refused = verifies[1];
    expect(Date.parse(refused.at)).not.toBeNaN();
    expect(refused.results.find((r: any) => r.id === 'jira-key-valid')).toMatchObject({ outcome: 'fail', blocking: true });
    expect(refused.results.find((r: any) => r.id === 'human-approval')).toMatchObject({ outcome: 'fail', blocking: true });
  });

  it('records approvals and overrides, with who, when and on what authority', async () => {
    const id = await onWork();
    await validate(id);
    await agent().post(`/items/${id}/overrides`).set(board).send({ step: 'WORK', checkId: 'jira-key-valid', reason: 'spike, no ticket' });
    await agent().post(`/items/${id}/approvals`).set(board).send({ step: 'WORK', note: 'go' });
    const h = await history(id);
    expect(h[0]).toMatchObject({ kind: 'approval', step: 'WORK', by: 'board', authority: 'unverified', note: 'go' });
    expect(h[1]).toMatchObject({ kind: 'override', step: 'WORK', by: 'board', check: 'jira-key-valid', reason: 'spike, no ticket' });
    expect(Date.parse(h[0].at)).not.toBeNaN();
  });

  it('survives a rollback: the approvals it records are history, not the step\'s live state', async () => {
    const id = await onWork();
    await agent().put(`/items/${id}`).send({ jiraItem: 'ABC-12' });
    await agent().post(`/items/${id}/approvals`).set(board).send({ step: 'WORK' });
    expect((await validate(id)).status).toBe(200);
    expect((await agent().put(`/items/${id}`).send({ status: 'WORK' })).status).toBe(200);
    const kinds = (await history(id)).map(e => e.kind);
    expect(kinds).toContain('approval');
    expect(kinds.filter(k => k === 'verify')).toHaveLength(2);
  });

  it('keeps the latest 100 entries', async () => {
    const id = await onWork();
    const old = Array.from({ length: 100 }, (_, i) => ({ kind: 'verify', step: 'WORK', at: new Date(2020, 0, 1, 0, i).toISOString(), blocked: true, results: [] }));
    await storage.updateItem(id, { checkHistory: old } as any);
    await validate(id);
    const h = await history(id);
    expect(h).toHaveLength(100);
    expect(Date.parse(h[0].at)).toBeGreaterThan(Date.parse('2021-01-01'));
  });

  it('cannot be written by a client', async () => {
    const id = await onWork();
    await agent().put(`/items/${id}`).send({ checkHistory: [{ kind: 'approval', step: 'WORK', at: 'x', by: 'forged' }] });
    expect((await history(id)).some(e => e.by === 'forged')).toBe(false);
  });
});

describe('CGLAB-380: test checks', () => {
  it('the honest TDD path reaches the end, and the red set is recorded by name', async () => {
    const { dir, id } = await atSpecs();
    honestTests(dir);
    write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n'); // born green: warns only
    let r = await validate(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.message).toMatch(/new-tests-born-green/);
    expect(r.body.message).toMatch(/red-is-assertion/); // mul is missing: a TypeError, not an assertion
    const red = (await item(id)).stepRecords.find((x: any) => x.kind === 'record' && x.name === 'redSet');
    expect(red.step).toBe('SPECS');
    expect(red.value).toEqual(['tests/mul.test.js > mul_works', 'tests/mul.test.js > mul_again']);

    impl(dir, { add: 'ok', mul: '12' });
    for (const expected of ['TIDY', 'LOOK', 'FINISHED']) {
      if (expected === 'FINISHED') await reviewed(id, dir);
      r = await validate(id);
      expect(r.status, `${expected}: ${JSON.stringify(r.body)}`).toBe(200);
      expect((await item(id)).status).toBe(expected);
    }
  });

  describe('writing tests (test-authoring)', () => {
    it('refuses when every new test already passes: nothing is red', async () => {
      const { dir, id } = await atSpecs();
      write(dir, 'tests/b.test.js', 'T add_twice add=ok\n');
      await refused(id, 'some-new-test-red');
    });

    it('refuses when no test was added', async () => {
      const { dir, id } = await atSpecs();
      write(dir, 'tests/a.test.js', 'T add_works add=ok\n# a comment\n');
      await refused(id, 'new-tests-exist');
    });

    it('refuses a test file that fails to load', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      write(dir, 'tests/c.test.js', 'BROKEN\n');
      const c = await refused(id, 'no-broken-test-files');
      expect(c.detail).toMatch(/tests\/c\.test\.js/);
    });

    it('refuses when a test that passed at the start of the step now fails', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      write(dir, 'tests/a.test.js', 'T add_works add=nope\n');
      const c = await refused(id, 'existing-tests-still-green');
      expect(c.detail).toMatch(/add_works/);
    });
  });

  describe('implementing (coding)', () => {
    it('refuses while a red test still fails, naming it', async () => {
      const { id } = await atBuild();
      const c = await refused(id, 'red-set-passes-by-name');
      expect(c.detail).toMatch(/mul_works/);
    });

    it('lets an existing test change while implementing: a behaviour change rightly changes its tests (1049ce52)', async () => {
      const { dir, id } = await atBuild();
      write(dir, 'tests/mul.test.js', 'T mul_works mul=0\nT mul_again mul=0\n');
      impl(dir, { add: 'ok', mul: '0' });
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    it('refuses skipping a red test: skipped is not passed', async () => {
      const { dir, id } = await atBuild();
      write(dir, 'tests/mul.test.js', 'T mul_works mul=12 SKIP\nT mul_again mul=12\n');
      impl(dir, { add: 'ok', mul: '12' });
      const c = await refused(id, 'red-set-passes-by-name');
      expect(c.detail).toMatch(/mul_works.*skipped/);
    });

    it('refuses deleting a test file: its red tests are missing, not passed', async () => {
      const { dir, id } = await atBuild();
      fs.rmSync(path.join(dir, 'tests/mul.test.js'));
      await refused(id, 'red-set-passes-by-name');
    });

    it('accepts an APPENDED test file while implementing', async () => {
      const { dir, id } = await atBuild();
      impl(dir, { add: 'ok', mul: '12' });
      write(dir, 'tests/extra.test.js', 'T mul_more mul=12\n');
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    it('a strict freeze, added by the flow, refuses even an appended file', async () => {
      const { dir, id } = await atBuild({ BUILD: [{ id: 'test-surface-frozen', params: { mode: 'strict' } }] });
      impl(dir, { add: 'ok', mul: '12' });
      write(dir, 'tests/extra.test.js', 'T mul_more mul=12\n');
      const c = await refused(id, 'test-surface-frozen');
      expect(c.detail).toMatch(/added tests\/extra\.test\.js/);
    });
  });

  describe('refactoring', () => {
    async function atTidy() {
      const at = await atBuild();
      impl(at.dir, { add: 'ok', mul: '12' });
      const r = await validate(at.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await item(at.id)).status).toBe('TIDY');
      return at;
    }

    it('refuses a test added while refactoring: the test set must be identical', async () => {
      const { dir, id } = await atTidy();
      write(dir, 'tests/extra.test.js', 'T mul_more mul=12\n');
      const c = await refused(id, 'test-set-identical');
      expect(c.detail).toMatch(/\+tests\/extra\.test\.js > mul_more/);
    });

    it('refuses a test removed while refactoring', async () => {
      const { dir, id } = await atTidy();
      write(dir, 'tests/mul.test.js', 'T mul_works mul=12\n');
      const c = await refused(id, 'test-set-identical');
      expect(c.detail).toMatch(/-tests\/mul\.test\.js > mul_again/);
    });
  });

  it('a rollback over the test-writing step drops the red set it produced', async () => {
    const { id } = await atBuild();
    expect((await agent().put(`/items/${id}`).send({ status: 'SPECS' })).status).toBe(200);
    const recs = (await item(id)).stepRecords;
    expect(recs.filter((x: any) => x.kind === 'record')).toEqual([]);
  });

  it('the SAME library on a default-shaped flow asks only for a green suite', async () => {
    const dir = makeRepo();
    const steps = [
      s('TODO', 0, { isAnchor: true }), s('IN_PROGRESS', 1, { role: 'coding' }),
      s('REVIEW', 2, { role: 'review' }), s('TEST', 3, { role: 'testing' }), s('DONE', 4, { isAnchor: true, role: 'closing' }),
    ];
    const id = await card(await project(await flow(steps), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT }), 'TODO');
    for (const expected of ['IN_PROGRESS', 'REVIEW', 'TEST', 'DONE']) {
      if (expected === 'TEST') await reviewed(id, dir);
      const r = await validate(id);
      expect(r.status, `${expected}: ${JSON.stringify(r.body)}`).toBe(200);
      expect((await item(id)).status).toBe(expected);
    }
    // ...and a red suite still stops it.
    const id2 = await card(await project(await flow(steps), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT }), 'IN_PROGRESS');
    impl(dir, { add: 'broken' });
    await refused(id2, 'suite-green');
  });

  describe('review findings (CGLAB-380 story review)', () => {
    const unignore = (dir: string) => {
      write(dir, '.gitignore', '');
      execSync('git add .gitignore && git commit -qm unignore', { cwd: dir, shell: '/bin/sh' });
    };

    it('the report the capture writes is not the card\'s change, even when it is not gitignored', async () => {
      const dir = makeRepo();
      unignore(dir);
      const id = await card(await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT }), 'START');
      for (const expected of ['ASK', 'SPECS']) {
        const r = await validate(id);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect((await item(id)).status).toBe(expected);
      }
      honestTests(dir);
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    it('in a shared tree, files another active card claims are not this card\'s change', async () => {
      const { dir, id } = await atSpecs();
      const pid = (await item(id)).projectId;
      // A sibling that got to BUILD the way cards do: through verify, which leaves an exit record.
      await card(pid, 'BUILD', { claims: ['src/sibling.js'], stepRecords: [{ kind: 'exit', step: 'SPECS', at: new Date().toISOString() }] });
      honestTests(dir);
      write(dir, 'src/sibling.js', 'theirs');
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    // 5b48b96b re-review: TODO -> BLOCKED needs no verify, so a claim made there is free and must excuse nothing.
    it('a claim held by a card that never left a step through verify does not make the change another card\'s', async () => {
      const { dir, id } = await atSpecs();
      const pid = (await item(id)).projectId;
      await card(pid, 'BLOCKED', { claims: ['src/sibling.js'] });
      honestTests(dir);
      write(dir, 'src/sibling.js', 'theirs');
      const c = await refused(id, 'only-test-files-changed');
      expect(c.detail).toMatch(/src\/sibling\.js/);
    });

    it('an unclaimed source change is still refused', async () => {
      const { dir, id } = await atSpecs();
      await agent().put(`/items/${id}`).send({ claims: ['tests'] });
      honestTests(dir);
      write(dir, 'src/sneaky.js', 'code');
      const c = await refused(id, 'only-test-files-changed');
      expect(c.detail).toMatch(/src\/sneaky\.js/);
    });

    it('a card already in the coding step when the flow gained roles warns and advances', async () => {
      const dir = makeRepo();
      const id = await card(await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT }), 'BUILD');
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const results = (await item(id)).lastChecks.results;
      expect(byId(results, 'red-set-passes-by-name')).toMatchObject({ outcome: 'unavailable', blocking: false });
    });

    it('the final transition of a default-shaped flow runs the suite once, not twice', async () => {
      const dir = makeRepo();
      const counter = path.join(dir, '..', `${path.basename(dir)}-runs`);
      repos.push(counter);
      const steps = [
        s('TODO', 0, { isAnchor: true }), s('IN_PROGRESS', 1, { role: 'coding' }),
        s('REVIEW', 2, { role: 'review' }), s('TEST', 3, { role: 'testing' }), s('DONE', 4, { isAnchor: true, role: 'closing' }),
      ];
      const id = await card(await project(await flow(steps), { projectRoot: dir, verifyCommand: `echo x >> ${counter} && node runner.cjs` }), 'TEST');
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await item(id)).status).toBe('DONE');
      expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    });
  });
});
