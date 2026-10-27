/**
 * Airlock on a HUB-JOINED installation (GH-294, T2).
 *
 * The rule the user decided (2026-10-27): a hub-joined installation can NOT
 * overrule the policy. Every local write is refused with 409
 * HUB_OWNS_AIRLOCK_POLICY - mirroring HUB_OWNS_VERIFY_COMMAND - and the refusal
 * is reported to the hub as airlock.local-write-refused. No passkey, no board
 * header, no agent token changes that.
 *
 * The hub config is forced through the environment BEFORE the server module is
 * imported (hubClient reads it at import), and fetch is stubbed so nothing
 * reaches a network. The outbound hub machinery is never started under a test
 * runner (startHubSubsystems), so events stay in the local outbox.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('airlock-policy-hub-joined-test-db.sqlite');
const ENV_KEYS = ['AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG', 'AGENFK_DB_PATH'];
const savedEnv: Record<string, string | undefined> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let __server: import('http').Server;
const agent = () => request(__server);

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.AGENFK_HUB_URL = 'http://hub.invalid';
  process.env.AGENFK_HUB_TOKEN = 'agk_test';
  process.env.AGENFK_HUB_ORG = 'org-airlock';
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests'); }));
  server = await import('../server');
  await server.initStorage();
  __server = server.app.listen(0);
});

afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  await removeTestDb(TEST_DB, server.closeStorage);
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const validPolicy = { schemaVersion: 1, mode: 'enforce', models: [], appliesWhenModelUnknown: true };

const outbox = (): Array<{ type: string; orgId: string; payload: any }> =>
  (server.storage.hubOutboxPeek(10_000) as Array<{ payload: string }>).map(r => JSON.parse(r.payload));

describe('hub-joined installation', () => {
  it('GET reports the policy as hub-managed', async () => {
    const res = await agent().get('/airlock/policy');
    expect(res.status).toBe(200);
    expect(res.body.hubManaged).toBe(true);
    expect(res.body.effective.mode).toBe('off');
  });

  it('PUT is 409 HUB_OWNS_AIRLOCK_POLICY, nothing is stored, and the refusal is queued for the hub', async () => {
    const res = await agent().put('/airlock/policy').send({ policy: validPolicy, expectedRevision: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('HUB_OWNS_AIRLOCK_POLICY');
    expect(String(res.body.message)).toMatch(/hub/i);
    expect(await server.storage.getAirlockPolicy('local')).toBeNull();
    const refused = outbox().filter(e => e.type === 'airlock.local-write-refused');
    expect(refused.length).toBe(1);
    expect(refused[0].orgId).toBe('org-airlock');
  });

  it('neither the board header nor the agent token overrules it', async () => {
    const board = await agent().put('/airlock/policy').set('x-agenfk-ui', '1').send({ policy: validPolicy, expectedRevision: 0 });
    expect(board.status).toBe(409);
    expect(board.body.error).toBe('HUB_OWNS_AIRLOCK_POLICY');
    const token = await agent().put('/airlock/policy').set('x-agenfk-internal', server.VERIFY_TOKEN).send({ policy: validPolicy, expectedRevision: 0 });
    expect(token.status).toBe(409);
    expect(await server.storage.getAirlockPolicy('local')).toBeNull();
    expect(outbox().filter(e => e.type === 'airlock.local-write-refused').length).toBe(3);
  });

  it('an invalid policy is still refused as hub-owned: the hub check comes first', async () => {
    const res = await agent().put('/airlock/policy').send({ policy: { mode: 'sometimes' }, expectedRevision: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('HUB_OWNS_AIRLOCK_POLICY');
  });

  it('evaluate still answers from the effective policy', async () => {
    const res = await agent().post('/airlock/evaluate').send({
      client: 'opencode', model: { provider: 'x', id: 'y' }, toolName: 'bash', args: { command: 'curl http://169.254.169.254/' },
    });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toEqual({ decision: 'allow', why: 'mode-off' });
  });
});
