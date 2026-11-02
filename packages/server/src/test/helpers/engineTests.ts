/**
 * The harness of the check-engine end-to-end files (check-engine-tests*.test.ts):
 * one file until GH-274, split so the suite's workers can run its parts side by
 * side - it was the longest file in the run, and with files in parallel the
 * longest file is the floor of the run's wall clock. The tests are unchanged.
 *
 * Each file calls useEngineServer() once, at its top, after its own
 * vi.mock('axios') (a mock is hoisted only in the test file itself).
 */
import { removeTestDb, testDbPath } from './testDb';
import { expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { posixShell } from './posixShell';
import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../../server';

let __server: import('http').Server;
export const agent = () => request(__server);
/** Directories removed when the file ends. */
export const repos: string[] = [];
let home: string;
/** The file's sandboxed HOME, where review transcripts (CGLAB-381) are written: never the real ~/.claude. */
export const engineHome = () => home;

/** The server on its own database (`dbName`, in the run's test-db dir), in a sandboxed HOME, for the file's tests. */
export function useEngineServer(dbName: string) {
  const TEST_DB = testDbPath(dbName);
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-engine-tests-home-'));
    repos.push(home);
    process.env.HOME = process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows
    await initStorage();
    __server = app.listen(0);
  });
  afterAll(() => { process.env.HOME = savedHome; process.env.USERPROFILE = savedUserProfile; });
  afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
  afterAll(async () => {
    await removeTestDb(TEST_DB, closeStorage);
    for (const r of repos) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
}

export const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

/**
 * A toy project whose "test runner" (runner.cjs) reads tests/*.test.js lines
 * `T <name> <key>=<value>` and passes a test when src/impl.json has that value;
 * a missing key fails with a TypeError (an error, not an assertion), ` SKIP`
 * skips, and a file containing BROKEN fails to load. It writes a vitest-style
 * JSON report, so everything below goes through the real report reader.
 */
export const RUNNER = `const fs=require('fs'),path=require('path');
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
export const JUNIT_RUNNER = `const fs=require('fs'),path=require('path');
const dir=process.argv[2]||'tests';
const impl=fs.existsSync('src/impl.json')?JSON.parse(fs.readFileSync('src/impl.json','utf8')):{};
let bad=false,xml='<testsuites><testsuite name="t" timestamp="'+process.hrtime.bigint()+'">';
for(const f of fs.readdirSync(dir))for(const l of fs.readFileSync(path.join(dir,f),'utf8').split('\\n').filter(l=>l.startsWith('T '))){
const [,n,kv]=l.split(' ');const [k,v]=kv.split('=');xml+='<testcase classname="'+dir+'" name="'+n+'">';
if(impl[k]!==v){bad=true;xml+='<failure message="AssertionError: expected"/>';}xml+='</testcase>';}
fs.writeFileSync(process.argv[3]||'report.xml',xml+'</testsuite></testsuites>');process.exit(bad?1:0);
`;

export function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-engine-tests-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: posixShell() });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'runner.cjs'), RUNNER);
  fs.writeFileSync(path.join(dir, 'junit.cjs'), JUNIT_RUNNER);
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'T add_works add=ok\n');
  fs.writeFileSync(path.join(dir, 'src/impl.json'), JSON.stringify({ add: 'ok' }));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\n');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: posixShell() });
  return dir;
}
export const write = (dir: string, f: string, text: string) => fs.writeFileSync(path.join(dir, f), text);
export const impl = (dir: string, o: Record<string, string>) => write(dir, 'src/impl.json', JSON.stringify(o));
export const REPORT = { format: 'vitest-json', command: 'node runner.cjs', reportPath: 'report.json' };

/** Record an independent review by a (sandboxed) sub-agent over the whole history, as a review step now requires. */
export async function reviewed(id: string, dir: string, { startedAt, agent: agentName, promptedAt }: { startedAt?: string; agent?: string; promptedAt?: string } = {}) {
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
export async function flow(steps: any[]): Promise<string> {
  const res = await agent().post('/flows').send({ name: `engine-${++seq}`, steps });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
export async function project(flowId: string | null, extra: Record<string, unknown> = {}) {
  const p = await agent().post('/projects').send({ name: `engine-${++seq}` });
  expect(p.status).toBe(201);
  await storage.updateProject(p.body.id, { ...(flowId ? { flowId } : {}), ...extra } as never);
  return p.body.id as string;
}
export async function card(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  expect(c.status).toBe(201);
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
export const validate = (id: string, body: Record<string, unknown> = {}) =>
  agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok', ...body });
export const item = async (id: string) => (await agent().get(`/items/${id}?records=1`)).body;
export const byId = (checks: any[], id: string) => checks.find((c: any) => c.id === id);

export const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/** TDD-shaped, with names the server has never seen. */
export const tddSteps = (extra: Record<string, any[]> = {}) => [
  s('START', 0, { isAnchor: true }),
  s('ASK', 1, { role: 'planning' }),
  s('SPECS', 2, { role: 'test-authoring', ...(extra.SPECS ? { checks: extra.SPECS } : {}) }),
  s('BUILD', 3, { role: 'coding', ...(extra.BUILD ? { checks: extra.BUILD } : {}) }),
  s('TIDY', 4, { role: 'refactoring' }),
  s('LOOK', 5, { role: 'review' }),
  s('FINISHED', 6, { isAnchor: true, role: 'closing' }),
];

/** A card walked honestly to SPECS: the entry capture (1 passing test) is recorded. */
export async function atSpecs(extra: Record<string, any[]> = {}) {
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
export const NOT_WRITTEN_YET = { checkAnswers: [{ id: 'red-is-assertion', note: 'mul is not written yet, so the red is a TypeError until it is' }] };
export const honestTests = (dir: string) => write(dir, 'tests/mul.test.js', 'T mul_works mul=12\nT mul_again mul=12\n');
/** ...and on to BUILD with honest red tests. */
export async function atBuild(extra: Record<string, any[]> = {}) {
  const at = await atSpecs(extra);
  honestTests(at.dir);
  // The red is a TypeError (mul is not written yet): the warning is answered, as the step asks (CGLAB-420).
  const r = await validate(at.id, NOT_WRITTEN_YET);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect((await item(at.id)).status).toBe('BUILD');
  return at;
}
export const refused = async (id: string, check: string) => {
  const r = await validate(id);
  expect(r.status, JSON.stringify(r.body)).toBe(422);
  // A check can run twice (a role's and a stricter one the flow adds): take the one that blocked.
  const c = r.body.checks.find((x: any) => x.id === check && x.blocking) ?? byId(r.body.checks, check);
  expect(c, `${check} in ${JSON.stringify(r.body.checks)}`).toBeDefined();
  expect(c.blocking).toBe(true);
  return c;
};

/* CGLAB-420 (field findings from CGLAB-419), shared by its blocks. */
export const answers = (...ids: string[]) => ({ checkAnswers: ids.map(id => ({ id, note: `answered: ${id}` })) });
// An author identity, so the review is judged rather than soft for want of one.
export const AUTHOR = { actor: { client: 'claude-code', sessionId: 'the-author' } };

/* fixes-reviewed (CGLAB-420), shared by its two files. */
/** A top-level card walked honestly to the review step LOOK, with `own` lines of its own work, uncommitted as a card keeps it. */
export async function atLook(own = 0) {
  const at = await atBuild();
  impl(at.dir, { add: 'ok', mul: '12' });
  if (own) write(at.dir, 'src/feature.js', lines(own, 'feature'));
  for (const expected of ['TIDY', 'LOOK']) {
    const r = await validate(at.id, AUTHOR);
    expect(r.status, `${expected}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  return at;
}
export const lines = (n: number, name = 'fix') => Array.from({ length: n }, (_, i) => `const ${name}${i} = ${i};`).join('\n') + '\n';
// Apart from the writes on both sides: an mtime carries sub-millisecond digits an ISO time does not.
export const reviewerBegins = async () => { await new Promise(r => setTimeout(r, 30)); const t = new Date().toISOString(); await new Promise(r => setTimeout(r, 30)); return t; };
/** Verify off LOOK and read fixes-reviewed as the card left (a warning never holds it). */
export const leave = async (id: string) => {
  const r = await validate(id, AUTHOR);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return byId((await item(id)).stepRecords.filter((x: any) => x.kind === 'exit' && x.step === 'LOOK').pop().checks, 'fixes-reviewed');
};
