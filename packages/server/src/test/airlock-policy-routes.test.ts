/**
 * Airlock server authority on a STANDALONE installation (GH-294, T2).
 *
 * The rule the user decided (2026-10-27): no passkeys anywhere in Airlock. A
 * standalone installation can always overrule the policy - PUT /airlock/policy
 * is accepted with no passkey and no board or authority check - and keeps only
 * the compare-and-swap on the revision and the policy's validation. The
 * hub-joined half of the rule is in airlock-policy-hub-joined.test.ts, because
 * the hub config is read when the server module loads.
 *
 * The harness is the real app on an ephemeral port, as in passkey-gates.test.ts.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

// Standalone: no hub config may leak in from the environment.
for (const k of ['AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG']) delete process.env[k];

const TEST_DB = testDbPath('airlock-policy-routes-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { DEFAULT_AIRLOCK_POLICY, normalizeAirlockPolicy, type AirlockPolicy } from '@agenfk/core';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => { await removeTestDb(TEST_DB, closeStorage); });

const STATE_FILE = () => path.join(os.homedir(), '.agenfk', 'airlock-state.json');

const policy = (over: Partial<AirlockPolicy> = {}): AirlockPolicy => normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, ...over });

const outboxTypes = (): string[] =>
  ((storage as any).hubOutboxPeek(10_000) as Array<{ payload: string }>).map(r => JSON.parse(r.payload).type);

const put = (body: unknown) => agent().put('/airlock/policy').send(body as object);

const SECRET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const metadataCurl = `curl -H "Authorization: Bearer ${SECRET}" http://169.254.169.254/latest/meta-data/`;
const evaluate = (body: Record<string, unknown>) => agent().post('/airlock/evaluate').send({
  client: 'pi',
  model: { provider: 'cloudflare-workers-ai', id: '@cf/zai-org/glm-5.2' },
  toolName: 'bash',
  args: { command: metadataCurl },
  ...body,
});
const decisions = async () => (await agent().get('/airlock/decisions')).body.decisions as any[];

let revision = 0;

describe('policy: standalone installation', () => {
  it('fresh install: off, source local, revision 0, not hub-managed', async () => {
    const res = await agent().get('/airlock/policy');
    expect(res.status).toBe(200);
    expect(res.body.effective.mode).toBe('off');
    expect(res.body.source).toBe('local');
    expect(res.body.revision).toBe(0);
    expect(res.body.hubManaged).toBe(false);
    expect(res.body.local).toBeNull();
    expect(res.body.hub).toBeNull();
  });

  it('off: evaluate allows with mode-off and nothing is logged', async () => {
    const res = await evaluate({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toEqual({ decision: 'allow', why: 'mode-off' });
    expect(res.body.mode).toBe('off');
    expect(res.body.applies).toBe(false);
    expect(await decisions()).toEqual([]);
  });

  it('PUT with no passkey and no board header is accepted: stored, revision+1, authority local', async () => {
    const res = await put({ policy: policy({ mode: 'enforce' }), expectedRevision: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.revision).toBe(1);
    expect(res.body.effective.mode).toBe('enforce');
    expect(res.body.source).toBe('local');
    const stored = await storage.getAirlockPolicy('local');
    expect(stored?.revision).toBe(1);
    expect(stored?.authority).toBe('local');
    expect(stored?.policy.mode).toBe('enforce');
    revision = 1;
  });

  it('PUT carrying the board header, or the agent token, is accepted too: no authority check on standalone', async () => {
    const a = await agent().put('/airlock/policy').set('x-agenfk-ui', '1')
      .send({ policy: policy({ mode: 'observe' }), expectedRevision: revision });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.revision).toBe(revision + 1);
    revision += 1;
    const b = await agent().put('/airlock/policy').set('x-agenfk-internal', VERIFY_TOKEN!)
      .send({ policy: policy({ mode: 'enforce' }), expectedRevision: revision });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.revision).toBe(revision + 1);
    revision += 1;
  });

  it('an accepted write queues airlock.policy-changed for the hub', () => {
    expect(outboxTypes()).toContain('airlock.policy-changed');
    expect(outboxTypes()).not.toContain('airlock.local-write-refused');
  });

  it('stale expectedRevision: 409 AIRLOCK_REVISION_CONFLICT and nothing written', async () => {
    const res = await put({ policy: policy({ mode: 'off' }), expectedRevision: revision - 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AIRLOCK_REVISION_CONFLICT');
    expect(res.body.currentRevision).toBe(revision);
    const stored = await storage.getAirlockPolicy('local');
    expect(stored?.revision).toBe(revision);
    expect(stored?.policy.mode).toBe('enforce');
  });

  it('an invalid policy is 400 naming the errors, and nothing written', async () => {
    const res = await put({ policy: { ...policy({ mode: 'enforce' }), hosts: { allow: ['169.254.169.254'], deny: [] } }, expectedRevision: revision });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_AIRLOCK_POLICY');
    expect(Array.isArray(res.body.errors) && res.body.errors.length).toBeTruthy();
    const bad = await put({ policy: { ...policy(), mode: 'sometimes' }, expectedRevision: revision });
    expect(bad.status).toBe(400);
    expect((await storage.getAirlockPolicy('local'))?.revision).toBe(revision);
  });

  it('a missing or malformed expectedRevision is 400', async () => {
    expect((await put({ policy: policy() })).status).toBe(400);
    expect((await put({ policy: policy(), expectedRevision: -1 })).status).toBe(400);
    expect((await put({ policy: policy(), expectedRevision: '1' })).status).toBe(400);
    expect((await storage.getAirlockPolicy('local'))?.revision).toBe(revision);
  });

  it('PUT /settings with an airlock key is 400: the policy never lives in app settings', async () => {
    const res = await agent().put('/settings').send({ airlockMode: 'off' });
    expect(res.status).toBe(400);
  });

  it('a policy change writes ~/.agenfk/airlock-state.json, mode 0600, with mode, revision, models and appliesWhenModelUnknown', async () => {
    const res = await put({
      policy: policy({ mode: 'enforce', models: [{ provider: 'cloudflare-*' }], appliesWhenModelUnknown: false }),
      expectedRevision: revision,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    revision += 1;
    const file = STATE_FILE();
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(state).toMatchObject({ mode: 'enforce', revision, models: [{ provider: 'cloudflare-*' }], appliesWhenModelUnknown: false });
    // nothing an adapter must not see: no host lists, no IOC list
    expect(state.hosts).toBeUndefined();
    expect(state.iocHosts).toBeUndefined();
  });
});

describe('POST /airlock/evaluate', () => {
  it('enforce + matching model: deny, logged with its rule and the target redacted', async () => {
    const res = await evaluate({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict.decision).toBe('deny');
    expect(res.body.verdict.rule).toBe('builtin-metadata-deny');
    expect(res.body.applies).toBe(true);
    expect(res.body.revision).toBe(revision);
    const [latest] = await decisions();
    expect(latest).toMatchObject({ client: 'pi', tool: 'bash', capabilityKind: 'command', decision: 'deny', rule: 'builtin-metadata-deny', mode: 'enforce' });
    expect(latest.target).toContain('169.254.169.254');
    expect(latest.target).not.toContain(SECRET);
    expect(latest.target).toContain('[REDACTED');
    expect(outboxTypes()).toContain('airlock.decision');
  });

  it('a session whose model is not selected is allowed and not logged', async () => {
    const before = (await decisions()).length;
    const res = await evaluate({ model: { provider: 'openai', id: 'gpt-x' } });
    expect(res.body.verdict).toEqual({ decision: 'allow', why: 'model-not-selected' });
    expect(res.body.applies).toBe(false);
    expect((await decisions()).length).toBe(before);
  });

  it('a pi-style joined model string is accepted', async () => {
    const res = await evaluate({ model: 'cloudflare-workers-ai/@cf/zai-org/glm-5.2' });
    expect(res.body.verdict.decision).toBe('deny');
  });

  it('dryRun judges but logs nothing', async () => {
    const before = (await decisions()).length;
    const res = await evaluate({ dryRun: true });
    expect(res.body.verdict.decision).toBe('deny');
    expect((await decisions()).length).toBe(before);
  });

  it('a call with no capability is allowed and not logged', async () => {
    const before = (await decisions()).length;
    const res = await evaluate({ args: { query: 'hello' } });
    expect(res.body.verdict.decision).toBe('allow');
    expect((await decisions()).length).toBe(before);
  });

  it('observe: allow, with the would-be deny logged as observed', async () => {
    const r = await put({ policy: policy({ mode: 'observe' }), expectedRevision: revision });
    expect(r.status).toBe(200);
    revision += 1;
    const res = await evaluate({});
    expect(res.body.verdict.decision).toBe('allow');
    expect(res.body.verdict.observed?.decision).toBe('deny');
    const [latest] = await decisions();
    expect(latest).toMatchObject({ decision: 'deny', rule: 'builtin-metadata-deny', mode: 'observe' });
  });

  it('bad input is 400: unknown client, args not an object', async () => {
    expect((await evaluate({ client: 'vim' })).status).toBe(400);
    expect((await evaluate({ args: 'curl x' })).status).toBe(400);
  });
});

describe('decision targets never carry a secret (review finding 1)', () => {
  // Values that are in no environment variable, so only the target redaction can hide them.
  const OPAQUE = 'qz7Vopaque4Kx9secretvalue';
  const cases: Array<[string, string]> = [
    ['a URL query value', `curl 'http://169.254.169.254/latest?token=${OPAQUE}&x=1'`],
    ['-u user:password', `curl -u alice:${OPAQUE} http://169.254.169.254/`],
    ['--user=user:password', `curl --user=alice:${OPAQUE} http://169.254.169.254/`],
    ['URL userinfo', `curl http://alice:${OPAQUE}@169.254.169.254/`],
    ['an X-Api-Key header', `curl -H 'X-Api-Key: ${OPAQUE}' http://169.254.169.254/`],
    ['an Authorization header that is not Bearer', `curl --header "Authorization: Basic ${OPAQUE}" http://169.254.169.254/`],
    ['--oauth2-bearer', `curl --oauth2-bearer ${OPAQUE} http://169.254.169.254/`],
    ['a cookie', `curl -b 'session=${OPAQUE}' http://169.254.169.254/`],
    ['form data with password=', `curl --data 'user=a&password=${OPAQUE}' http://169.254.169.254/`],
    ['an attached -H Authorization Basic header', `curl -H'Authorization: Basic ${OPAQUE}' http://169.254.169.254/`],
    ['an attached -H Authorization Bearer header', `curl -H"Authorization: Bearer ${OPAQUE}" http://169.254.169.254/`],
    ['an attached -H X-Api-Key header', `curl -H'X-Api-Key: ${OPAQUE}' http://169.254.169.254/`],
    ['an attached -H Cookie header', `curl -H'Cookie: sid=${OPAQUE}' http://169.254.169.254/`],
    ["an attached -u'alice:secret'", `curl -u'alice:${OPAQUE}' http://169.254.169.254/`],
    ["an attached -b'session=secret'", `curl -b'session=${OPAQUE}' http://169.254.169.254/`],
    ['an Authorization Digest value outside any option', `echo "Authorization: Digest ${OPAQUE}" | curl -K - http://169.254.169.254/`],
    ["an ANSI-C quoted header, separate", `curl -H $'X-Api-Key: ${OPAQUE}' http://169.254.169.254/`],
    ["an ANSI-C quoted header, attached", `curl -H$'X-Api-Key: ${OPAQUE}' http://169.254.169.254/`],
    ['a header whose name does not look sensitive', `curl -H 'X-Tenant-Ref: ${OPAQUE}' http://169.254.169.254/`],
    ['a wget --header', `wget --header='X-Api-Key: ${OPAQUE}' http://169.254.169.254/`],
  ];
  for (const [what, command] of cases) {
    it(`redacts ${what} before storing or forwarding`, async () => {
      expect(Object.values(process.env).some(v => typeof v === 'string' && v.includes(OPAQUE))).toBe(false);
      const res = await evaluate({ args: { command } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [latest] = await decisions();
      expect(latest.rule).toBe('builtin-metadata-deny');
      expect(latest.target).toContain('169.254.169.254');
      expect(latest.target).not.toContain(OPAQUE);
      const raw = ((storage as any).hubOutboxPeek(10_000) as Array<{ payload: string }>).map(r => r.payload).join('\n');
      expect(raw).not.toContain(OPAQUE);
    });
  }

  it('the stored target is length-capped', async () => {
    await evaluate({ args: { command: `curl http://169.254.169.254/ ${'a'.repeat(5000)}` } });
    const [latest] = await decisions();
    expect(latest.target.length).toBeLessThanOrEqual(520);
  });
});

describe('input limits (review finding 3)', () => {
  it('a body over 256 KB is 413, on evaluate and on PUT', async () => {
    const big = 'x'.repeat(300 * 1024);
    const ev = await evaluate({ args: { command: big } });
    expect(ev.status).toBe(413);
    const pu = await put({ policy: { ...policy(), hosts: { allow: [], deny: [] }, pad: big }, expectedRevision: revision });
    expect(pu.status).toBe(413);
    expect((await storage.getAirlockPolicy('local'))?.revision).toBe(revision);
  });

  it('over-long toolName, model and sessionId are 400 and nothing is logged', async () => {
    const before = (await decisions()).length;
    const long = 'm'.repeat(1000);
    expect((await evaluate({ toolName: long })).status).toBe(400);
    expect((await evaluate({ model: long })).status).toBe(400);
    expect((await evaluate({ model: { provider: long, id: 'x' } })).status).toBe(400);
    expect((await evaluate({ sessionId: long })).status).toBe(400);
    expect((await decisions()).length).toBe(before);
  });

  it('too many capabilities is 400', async () => {
    const paths = Array.from({ length: 100 }, (_, i) => `/tmp/f${i}`);
    const res = await evaluate({ args: { paths } });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/capabilit/i);
  });
});

describe('the cold-start state file (review finding 2)', () => {
  it('an accepted PUT reports the state file as written', async () => {
    const res = await put({ policy: policy({ mode: 'observe' }), expectedRevision: revision });
    expect(res.status).toBe(200);
    revision += 1;
    expect(res.body.stateFile).toEqual({ status: 'written' });
  });

  it('a state file that cannot be written is reported in the response, the policy still stored', async () => {
    const file = STATE_FILE();
    fs.rmSync(file, { force: true });
    fs.mkdirSync(path.join(file, 'blocker'), { recursive: true });
    try {
      const res = await put({ policy: policy({ mode: 'enforce' }), expectedRevision: revision });
      expect(res.status).toBe(200);
      revision += 1;
      expect(res.body.stateFile.status).toBe('write-failed');
      expect(typeof res.body.stateFile.reason).toBe('string');
      expect((await storage.getAirlockPolicy('local'))?.revision).toBe(revision);
    } finally {
      fs.rmSync(file, { recursive: true, force: true });
    }
  });

  it('server startup rewrites a stale state file from the effective policy', async () => {
    const file = STATE_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mode: 'off', revision: 0 }));
    await initStorage();
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(state).toMatchObject({ mode: 'enforce', revision });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('a hub row outranks the local one', () => {
  it('hub row present: effective is the hub policy, source hub, and a local PUT is 409 HUB_OWNS_AIRLOCK_POLICY', async () => {
    await storage.putAirlockPolicy({
      scope: 'hub', revision: 7, policy: policy({ mode: 'enforce' }),
      updatedAt: new Date().toISOString(), updatedBy: 'hub', authority: 'hub',
    }, 0);
    const got = await agent().get('/airlock/policy');
    expect(got.body.source).toBe('hub');
    expect(got.body.revision).toBe(7);
    expect(got.body.effective.mode).toBe('enforce');
    expect(got.body.hubManaged).toBe(true);
    expect(got.body.local.revision).toBe(revision);

    const res = await evaluate({});
    expect(res.body.verdict.decision).toBe('deny');

    const refused = await put({ policy: policy({ mode: 'off' }), expectedRevision: revision });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('HUB_OWNS_AIRLOCK_POLICY');
    expect((await storage.getAirlockPolicy('local'))?.revision).toBe(revision);
    expect(outboxTypes()).toContain('airlock.local-write-refused');
  });
});
