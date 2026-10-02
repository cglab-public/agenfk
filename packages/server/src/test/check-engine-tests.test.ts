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
async function reviewed(id: string, dir: string, { startedAt, agent: agentName, promptedAt }: { startedAt?: string; agent?: string; promptedAt?: string } = {}) {
  const first = execSync('git rev-list --max-parents=0 HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  const tdir = path.join(home, '.claude', 'projects', '-repo', 'sess', 'subagents');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-repo', 'sess.jsonl'), JSON.stringify({ sessionId: 'sess', timestamp: '2099-01-01T00:00:00.000Z' }) + '\n');
  const aid = agentName ?? id.slice(0, 8);
  const t = path.join(tdir, `agent-${aid}.jsonl`);
  // CGLAB-420: `startedAt` is when the reviewer began; what changed after it, it cannot have read.
  fs.writeFileSync(t, [
    ...(startedAt ? [{ isSidechain: true, agentId: aid, sessionId: 'sess', timestamp: startedAt }] : []),
    // A reviewer continued with a new message reads again from there.
    ...(promptedAt ? [{ isSidechain: true, agentId: aid, sessionId: 'sess', timestamp: promptedAt, type: 'user', message: { content: 'read the fixes too' } }] : []),
    { isSidechain: true, agentId: aid, sessionId: 'sess', timestamp: '2099-01-01T00:00:00.000Z' },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
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
/** The answer an honest agent gives red-is-assertion here: the red is the missing code (CGLAB-420). */
const NOT_WRITTEN_YET = { checkAnswers: [{ id: 'red-is-assertion', note: 'mul is not written yet, so the red is a TypeError until it is' }] };
const honestTests = (dir: string) => write(dir, 'tests/mul.test.js', 'T mul_works mul=12\nT mul_again mul=12\n');
/** ...and on to BUILD with honest red tests. */
async function atBuild(extra: Record<string, any[]> = {}) {
  const at = await atSpecs(extra);
  honestTests(at.dir);
  // The red is a TypeError (mul is not written yet): the warning is answered, as the step asks (CGLAB-420).
  const r = await validate(at.id, NOT_WRITTEN_YET);
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
    write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n'); // born green: a warning, answered (CGLAB-420)
    let r = await validate(id, { checkAnswers: [...NOT_WRITTEN_YET.checkAnswers, { id: 'new-tests-born-green', note: 'add_again pins add, which already exists' }] });
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

    // CGLAB-418: the usual cause is a test importing code not written yet, and code may not be written here.
    it('says how to write a test for code that does not exist yet when a test file fails to load', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      write(dir, 'tests/c.test.js', 'BROKEN\n');
      const c = await refused(id, 'no-broken-test-files');
      expect(c.detail).toMatch(/import it inside the test/i);
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

    /*
     * CGLAB-418: a red set recorded before the JUnit reader knew vitest's
     * import-failure shape holds the file itself as a test, `F > F`. The name
     * can never come back, so the card was stuck until a person overrode the
     * check. Such an entry stands for the file's tests: it passes when the file
     * now reports tests and every one of them passes, and on nothing less.
     */
    const plantPhantom = async (id: string, file: string) => {
      const records: any[] = (await storage.getItem(id) as any).stepRecords;
      const rec = records.find(r => r.kind === 'record' && r.name === 'redSet');
      expect(rec, JSON.stringify(records)).toBeDefined();
      rec.value = [...rec.value, `${file} > ${file}`];
      await storage.updateItem(id, { stepRecords: records } as any);
    };

    it('an old import-failure entry in the red set passes once its file loads and its tests pass (CGLAB-418)', async () => {
      const { dir, id } = await atBuild();
      await plantPhantom(id, 'tests/mul.test.js');
      impl(dir, { add: 'ok', mul: '12' });
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    it('an old import-failure entry does not pass while a test in its file fails (CGLAB-418)', async () => {
      const { dir, id } = await atBuild();
      await plantPhantom(id, 'tests/a.test.js');
      write(dir, 'tests/a.test.js', 'T add_works add=nope\n');
      impl(dir, { add: 'ok', mul: '12' });
      const c = await refused(id, 'red-set-passes-by-name');
      expect(c.detail).toMatch(/tests\/a\.test\.js/);
    });

    it('an old import-failure entry does not pass when its file reports no tests (CGLAB-418)', async () => {
      const { dir, id } = await atBuild();
      await plantPhantom(id, 'tests/gone.test.js');
      impl(dir, { add: 'ok', mul: '12' });
      const c = await refused(id, 'red-set-passes-by-name');
      expect(c.detail).toMatch(/tests\/gone\.test\.js/);
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

    it('names a changed report setting, not a mass swap, when the tests only look different because the report changed (d26832d6 #19)', async () => {
      // marketing-lab: adding a `file` attribute to the report renamed every
      // test, and the check listed them all as removed and re-added.
      const { id } = await atTidy();
      const pid = (await item(id)).projectId;
      await storage.updateProject(pid, { testReport: { format: 'junit-xml', command: 'node junit.cjs tests', reportPath: 'report.xml', surface: ['tests'] } } as never);
      const c = await refused(id, 'test-set-identical');
      expect(c.detail).toMatch(/test report setting changed/i);
      expect(c.detail).not.toMatch(/^the tests changed/);
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
      const r = await validate(id, NOT_WRITTEN_YET);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    it('a source change in the shared tree is this card\'s change, whatever another card once claimed', async () => {
      // 26c059f6: claims are gone, so no file is handed to another card. A
      // claim stored on an old sibling excuses nothing.
      const { dir, id } = await atSpecs();
      const pid = (await item(id)).projectId;
      await card(pid, 'BUILD', { claims: ['src/sibling.js'], stepRecords: [{ kind: 'exit', step: 'SPECS', at: new Date().toISOString() }] });
      honestTests(dir);
      write(dir, 'src/sibling.js', 'theirs');
      const c = await refused(id, 'only-test-files-changed');
      expect(c.detail).toMatch(/src\/sibling\.js/);
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

/*
 * CGLAB-420: what monitoring a real story (CGLAB-419) on the TDD flow showed
 * the checks leaving undone. Each block is one finding.
 */
describe('CGLAB-420: field findings from CGLAB-419', () => {
  const answers = (...ids: string[]) => ({ checkAnswers: ids.map(id => ({ id, note: `answered: ${id}` })) });
  // An author identity, so the review is judged rather than soft for want of one.
  const AUTHOR = { actor: { client: 'claude-code', sessionId: 'the-author' } };

  describe('a warning on the step that writes tests is answered before the card leaves', () => {
    it('refuses a failing warning nobody answered, saying how to answer it', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n'); // born green
      const c = await refused(id, 'new-tests-born-green');
      expect(c.detail).toMatch(/--check-note new-tests-born-green=/);
    });

    it('lets it leave once each failing warning is answered, and keeps the answer on the record', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n');
      const r = await validate(id, answers('new-tests-born-green', 'red-is-assertion'));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const exit = (await item(id)).stepRecords.filter((x: any) => x.kind === 'exit' && x.step === 'SPECS').pop();
      expect(byId(exit.checks, 'new-tests-born-green')).toMatchObject({ outcome: 'fail', blocking: false, answer: 'answered: new-tests-born-green' });
    });

    it('refuses an answer to a check this step does not have', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      const r = await validate(id, answers('no-such-check'));
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/no-such-check/);
    });

    it('a failing warning on the coding step still does not block', async () => {
      const { dir, id } = await atBuild({ BUILD: [{ id: 'new-tests-born-green' }] });
      impl(dir, { add: 'ok', mul: '12' });
      write(dir, 'tests/extra.test.js', 'T extra_green add=ok\n'); // green on arrival, on the coding step
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(byId((await item(id)).lastChecks.results, 'new-tests-born-green')).toMatchObject({ outcome: 'fail', blocking: false });
    });

    it('red on an error needs no answer: the code is simply not written yet', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir); // mul is missing: red-is-assertion fails, as it does on most honest cards
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    it('a person\'s pass of one born-green failure does not pass a different one later', async () => {
      const { dir, id } = await atSpecs();
      honestTests(dir);
      write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n');
      await refused(id, 'new-tests-born-green');
      const o = await agent().post(`/items/${id}/overrides`).set({ 'x-agenfk-ui': '1' }).send({ checkId: 'new-tests-born-green', reason: 'fine' });
      expect(o.status, JSON.stringify(o.body)).toBe(201);
      write(dir, 'tests/b.test.js', 'T add_thrice add=ok\n'); // a second test green on arrival
      await refused(id, 'new-tests-born-green');
    });
  });

  describe('fixes-reviewed: the fixes to a review\'s findings are flagged, not certified', () => {
    /** A top-level card walked honestly to the review step LOOK, with `own` lines of its own work, uncommitted as a card keeps it. */
    async function atLook(own = 0) {
      const at = await atBuild();
      impl(at.dir, { add: 'ok', mul: '12' });
      if (own) write(at.dir, 'src/feature.js', lines(own, 'feature'));
      for (const expected of ['TIDY', 'LOOK']) {
        const r = await validate(at.id, AUTHOR);
        expect(r.status, `${expected}: ${JSON.stringify(r.body)}`).toBe(200);
      }
      return at;
    }
    const lines = (n: number, name = 'fix') => Array.from({ length: n }, (_, i) => `const ${name}${i} = ${i};`).join('\n') + '\n';
    // Apart from the writes on both sides: an mtime carries sub-millisecond digits an ISO time does not.
    const reviewerBegins = async () => { await new Promise(r => setTimeout(r, 30)); const t = new Date().toISOString(); await new Promise(r => setTimeout(r, 30)); return t; };
    /** Verify off LOOK and read fixes-reviewed as the card left (a warning never holds it). */
    const leave = async (id: string) => {
      const r = await validate(id, AUTHOR);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return byId((await item(id)).stepRecords.filter((x: any) => x.kind === 'exit' && x.step === 'LOOK').pop().checks, 'fixes-reviewed');
    };

    it('flags a fix of more than a few lines written after the reviewer began, naming it, and lets the card go', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      write(dir, 'src/fix.js', lines(30));
      await reviewed(id, dir, { startedAt });
      const c = await leave(id);
      expect(c).toMatchObject({ outcome: 'fail', blocking: false });
      expect(c.detail).toMatch(/30 lines changed after the reviewer began/);
      expect(c.detail).toMatch(/src\/fix\.js/);
    });

    it('does not count the card\'s own reviewed work, however large and uncommitted', async () => {
      const { dir, id } = await atLook(40);
      await reviewed(id, dir, { startedAt: await reviewerBegins() });
      expect(await leave(id)).toMatchObject({ outcome: 'pass' });
    });

    it('a small fix to a file the card already changed a lot counts small, once that work is committed', async () => {
      const { dir, id } = await atLook(40);
      execSync('git add -A && git commit -qm "the card\'s work"', { cwd: dir, shell: '/bin/sh' });
      const startedAt = await reviewerBegins();
      fs.appendFileSync(path.join(dir, 'src/feature.js'), 'const oneMore = 1;\n');
      await reviewed(id, dir, { startedAt });
      const c = await leave(id);
      expect(c.outcome).toBe('pass');
      expect(c.detail).toMatch(/1 line\(s\) of follow-up/);
    });

    it('counts a test file removed after the reviewer began', async () => {
      const { dir, id } = await atLook();
      write(dir, 'tests/extra.test.js', lines(30, 't'));
      execSync('git add -A && git commit -qm "more tests"', { cwd: dir, shell: '/bin/sh' });
      const startedAt = await reviewerBegins();
      fs.rmSync(path.join(dir, 'tests/extra.test.js'));
      await reviewed(id, dir, { startedAt });
      const c = await leave(id);
      expect(c.outcome).toBe('fail');
      expect(c.detail).toMatch(/tests\/extra\.test\.js/);
    });

    it('lets a small fix pass as follow-up', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      write(dir, 'src/fix.js', lines(3));
      await reviewed(id, dir, { startedAt });
      expect((await leave(id)).outcome).toBe('pass');
    });

    it('small fixes re-recorded one by one add up: the allowance is not per record', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      for (let i = 0; i < 4; i++) {
        write(dir, `src/fix${i}.js`, lines(18, `f${i}`));
        await reviewed(id, dir, { startedAt, agent: 'first' });
      }
      expect((await leave(id)).detail).toMatch(/72 lines changed after the reviewer began/);
    });

    it('rolling back to fix and coming back to review does not clear it', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      await storage.updateItem(id, { status: 'TIDY' } as any);
      write(dir, 'src/fix.js', lines(60));
      expect((await validate(id, AUTHOR)).status).toBe(200); // back on LOOK
      await reviewed(id, dir, { startedAt, agent: 'first' });
      expect((await leave(id)).outcome).toBe('fail');
    });

    it('clears once a reviewer that began after the fixes records its review', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      write(dir, 'src/fix.js', lines(30));
      await reviewed(id, dir, { startedAt, agent: 'first' });
      await reviewed(id, dir, { startedAt: await reviewerBegins(), agent: 'second' });
      expect((await leave(id)).outcome).toBe('pass');
    });

    it('a reviewer given a new message after the fixes has read them; a note the harness injects is no such message', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      write(dir, 'src/fix.js', lines(30));
      const tdir = path.join(home, '.claude', 'projects', '-repo', 'sess', 'subagents');
      await reviewed(id, dir, { startedAt, agent: 'first', promptedAt: await reviewerBegins() });
      expect((await leave(id)).outcome).toBe('pass');
      // The same shape, but the late "prompt" is a hand-back reminder the harness injected.
      const { dir: d2, id: id2 } = await atLook();
      const s2 = await reviewerBegins();
      write(d2, 'src/fix.js', lines(30));
      await reviewed(id2, d2, { startedAt: s2, agent: 'third' });
      const t = path.join(tdir, 'agent-third.jsonl');
      const later = await reviewerBegins();
      const recs = fs.readFileSync(t, 'utf8').trim().split('\n');
      recs.splice(1, 0, JSON.stringify({ isSidechain: true, agentId: 'third', sessionId: 'sess', timestamp: later, type: 'user', isMeta: true, message: { content: '[handback-send-enforce] Your report has not been delivered' } }));
      fs.writeFileSync(t, recs.join('\n') + '\n');
      const rr = await agent().post(`/items/${id2}/review-records`).set(internal()).send({ transcript: t, range: `${execSync('git rev-list --max-parents=0 HEAD', { cwd: d2, encoding: 'utf8' }).trim()}..HEAD`, findings: [] });
      expect(rr.status, JSON.stringify(rr.body)).toBe(201);
      expect((await leave(id2)).outcome).toBe('fail');
    });

    it('main merged in during the review is not the card\'s work', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      execSync('git checkout -q -b upstream', { cwd: dir });
      write(dir, 'src/theirs.js', lines(50, 'theirs'));
      execSync('git add src/theirs.js && git commit -qm "main moved on" && git update-ref refs/remotes/origin/main HEAD && git checkout -q main && git merge -q --no-edit upstream', { cwd: dir, shell: '/bin/sh' });
      await reviewed(id, dir, { startedAt });
      expect((await leave(id)).outcome).toBe('pass');
    });
  });

  describe('on-card-branch judges the branch when none is recorded', () => {
    async function keyed(branch: string | null) {
      const dir = makeRepo();
      const pid = await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT });
      const id = await card(pid, 'START', { externalId: 'ABC-7' });
      if (branch) execSync(`git checkout -q -b ${branch}`, { cwd: dir });
      return id;
    }

    it('refuses a branch that carries none of the card\'s keys', async () => {
      const c = await refused(await keyed('feat/OTHER-9_theirs'), 'on-card-branch');
      expect(c.detail).toMatch(/feat\/OTHER-9_theirs/);
      expect(c.detail).toMatch(/ABC-7/);
    });

    it('passes on a branch that carries the card\'s key, saying so', async () => {
      const id = await keyed('feat/ABC-7_mine');
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(byId((await item(id)).lastChecks.results, 'on-card-branch').detail).toMatch(/ABC-7/);
    });

    it('does not take a GitHub issue number for a JIRA key', async () => {
      const dir = makeRepo();
      const pid = await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT });
      const id = await card(pid, 'START', { externalId: '42' });
      execSync('git checkout -q -b feat/login-fix', { cwd: dir });
      expect((await validate(id)).status).toBe(200);
    });

    it('does not judge a branch that names no key (release/..., develop)', async () => {
      for (const b of ['release/v2.0.0-beta.7', 'develop']) {
        const r = await validate(await keyed(b));
        expect(r.status, `${b}: ${JSON.stringify(r.body)}`).toBe(200);
      }
    });

    it('does not read ordinary words or standards in a branch name as another card\'s key', async () => {
      for (const b of ['feat/add-oauth-2-support', 'renovate/node-20', 'fix/utf-8-decoding', 'release/v2-3', 'fix/CVE-2024-1234', 'feat/UTF-8_support', 'hotfix/SHA-256_digest']) {
        const r = await validate(await keyed(b));
        expect(r.status, `${b}: ${JSON.stringify(r.body)}`).toBe(200);
      }
    });

    it('judges the key that leads the name, not one mentioned further along', async () => {
      const c = await refused(await keyed('fix/OTHER-420_field-findings-abc-7'), 'on-card-branch');
      expect(c.detail).toMatch(/named for OTHER-420/);
    });

    it('matches the key as a whole token, in any case', async () => {
      expect((await validate(await keyed('feat/abc-7_lowercase'))).status).toBe(200);
      const c = await refused(await keyed('feat/ABC-70_a-longer-key'), 'on-card-branch');
      expect(c.detail).toMatch(/ABC-70/);
    });

    it('passes on the default branch before a card branch exists', async () => {
      const id = await keyed(null);
      const r = await validate(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(byId((await item(id)).lastChecks.results, 'on-card-branch').detail).toMatch(/'main', which names no JIRA key/);
    });
  });

  describe('a parent\'s review sees what its children recorded', () => {
    /** A story with one task, the task walked honestly to its end: the story stops at its review step. */
    async function storyAtLook() {
      const dir = makeRepo();
      const pid = await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT });
      const story = (await agent().post('/items').send({ type: 'STORY', title: 'the story', projectId: pid })).body.id as string;
      await storage.updateItem(story, { status: 'START' } as any);
      const task = (await agent().post('/items').send({ type: 'TASK', title: 'the task', projectId: pid, parentId: story })).body.id as string;
      await storage.updateItem(task, { status: 'START' } as any);
      for (const expected of ['ASK', 'SPECS']) expect((await validate(task, AUTHOR)).status).toBe(200);
      honestTests(dir);
      write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n'); // add_again: born green
      expect((await validate(task, { ...AUTHOR, ...answers('new-tests-born-green', 'red-is-assertion') })).status).toBe(200);
      impl(dir, { add: 'ok', mul: '12' });
      // The reply of the verify that brought the story onto its review step.
      let arrived: any;
      for (const expected of ['TIDY', 'LOOK', 'FINISHED']) {
        const was = (await item(story)).status;
        const r = await validate(task, AUTHOR);
        expect(r.status, `${expected}: ${JSON.stringify(r.body)}`).toBe(200);
        if (was !== 'LOOK' && (await item(story)).status === 'LOOK') arrived = r;
      }
      expect((await item(story)).status).toBe('LOOK');
      expect(arrived, 'no verify brought the story onto LOOK').toBeDefined();
      return { dir, story, task, last: arrived };
    }

    it('the verify that brings the parent to its review hands over the tree\'s warnings, with their answers', async () => {
      const { last } = await storyAtLook();
      expect(last.body.message).toMatch(/the story/);
      expect(last.body.message).toMatch(/reviewer/i);
      expect(last.body.message).toMatch(/add_again/);
      expect(last.body.message).toMatch(/answered: new-tests-born-green/);
    });

    it('the brief reaches the CLI\'s async verify too', async () => {
      const dir = makeRepo();
      const pid = await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT });
      const story = (await agent().post('/items').send({ type: 'STORY', title: 'the async story', projectId: pid })).body.id as string;
      const task = (await agent().post('/items').send({ type: 'TASK', title: 'the task', projectId: pid, parentId: story })).body.id as string;
      await storage.updateItem(story, { status: 'START' } as any);
      await storage.updateItem(task, { status: 'START' } as any);
      for (const expected of ['ASK', 'SPECS']) expect((await validate(task, AUTHOR)).status).toBe(200);
      honestTests(dir);
      write(dir, 'tests/a.test.js', 'T add_works add=ok\nT add_again add=ok\n');
      expect((await validate(task, { ...AUTHOR, ...answers('new-tests-born-green', 'red-is-assertion') })).status).toBe(200);
      impl(dir, { add: 'ok', mul: '12' });
      expect((await validate(task, AUTHOR)).status).toBe(200); // TIDY
      const v = await validate(task, { ...AUTHOR, async: true }); // TIDY -> LOOK, as the CLI sends it
      let run: any = v.body;
      for (let i = 0; i < 200 && (!run || run.status === 'running' || run.runId); i++) {
        run = (await agent().get(`/items/validate-runs/${v.body.runId}`).set(internal())).body;
        if (run.status !== 'running') break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect((await item(story)).status).toBe('LOOK');
      expect(run.message ?? v.body.message).toMatch(/the async story[\s\S]*add_again/);
    });

    it('lists the tree\'s warnings for the PR, with each answer', async () => {
      const { story, task } = await storyAtLook();
      const ws = (await agent().get(`/items/${story}/warnings`)).body;
      expect(ws).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: task, check: 'new-tests-born-green', step: 'SPECS', answer: 'answered: new-tests-born-green' })]));
    });

    it('the parent\'s review step lists its children\'s warnings on its own checks', async () => {
      const { story } = await storyAtLook();
      const r = await validate(story, AUTHOR);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      const w = byId((await item(story)).lastChecks.results, 'tree-warnings');
      expect(w).toMatchObject({ outcome: 'fail', blocking: false });
      expect(w.detail).toMatch(/add_again/);
    });

    it('a test file one task committed after its freeze is late at the parent, though a later task\'s freeze holds it', async () => {
      const dir = makeRepo();
      const pid = await project(await flow(tddSteps()), { projectRoot: dir, verifyCommand: 'node runner.cjs', testReport: REPORT });
      const story = (await agent().post('/items').send({ type: 'STORY', title: 'two tasks', projectId: pid })).body.id as string;
      await storage.updateItem(story, { status: 'START' } as any);
      const walk = async (task: string, tests: () => void, during: () => void) => {
        for (const _ of ['ASK', 'SPECS']) expect((await validate(task, AUTHOR)).status).toBe(200);
        tests();
        expect((await validate(task, AUTHOR)).status).toBe(200);
        during();
        for (const _ of ['TIDY', 'LOOK', 'FINISHED']) expect((await validate(task, AUTHOR)).status).toBe(200);
      };
      const a = (await agent().post('/items').send({ type: 'TASK', title: 'a', projectId: pid, parentId: story })).body.id as string;
      await storage.updateItem(a, { status: 'START' } as any);
      await walk(a, () => honestTests(dir), () => {
        impl(dir, { add: 'ok', mul: '12' });
        write(dir, 'tests/sneaky.test.js', 'T sneaky add=ok\n'); // added after a's tests were frozen
        execSync(`git add -A && git commit -qm "close(task): a [${a}]"`, { cwd: dir, shell: '/bin/sh' });
      });
      const b = (await agent().post('/items').send({ type: 'TASK', title: 'b', projectId: pid, parentId: story })).body.id as string;
      await storage.updateItem(b, { status: 'START' } as any);
      await walk(b, () => write(dir, 'tests/c.test.js', 'T sub_works sub=ok\n'), () => impl(dir, { add: 'ok', mul: '12', sub: 'ok' }));
      expect((await item(story)).status).toBe('LOOK');
      await reviewed(story, dir);
      await validate(story, AUTHOR);
      const late = byId((await item(story)).lastChecks.results, 'tests-added-late');
      expect(late.outcome).toBe('fail');
      expect(late.detail).toMatch(/tests\/sneaky\.test\.js/);
      expect(late.detail).not.toMatch(/tests\/c\.test\.js/);
    });

    it('tests-added-late reads the children\'s frozen tests at the parent, and names a test file added after', async () => {
      const { dir, story } = await storyAtLook();
      write(dir, 'tests/late.test.js', 'T late_one add=ok\n');
      await reviewed(story, dir);
      const r = await validate(story, AUTHOR);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const late = byId((await item(story)).stepRecords.filter((x: any) => x.kind === 'exit' && x.step === 'LOOK').pop().checks, 'tests-added-late');
      expect(late.outcome).toBe('fail');
      expect(late.detail).toMatch(/tests\/late\.test\.js/);
      expect(late.detail).not.toMatch(/tests\/mul\.test\.js/);
    });
  });
});
