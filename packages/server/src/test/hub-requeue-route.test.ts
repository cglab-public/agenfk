/**
 * #223: the HTTP surface of the deadletter requeue and of the sticky refusal
 * indicator.
 *
 *  - POST /internal/hub/requeue-deadletter: verify-token gated, like
 *    rewrite-outbox-org — it writes the outbox, which only the server opens.
 *  - GET /internal/hub/status: carries the indicator even when the hub is not
 *    configured (the refusals outlive a logout).
 *  - GET /hub/refusals: the board's read. The board holds no internal token, so
 *    this route is public on loopback and returns counts only — never payloads
 *    (actor emails, item titles) or paths.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Sandbox homedir BEFORE importing the server (see hub-org-summaries.test.ts):
// the deadletter path resolves under os.homedir() at call time.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-requeue-'));
vi.mocked(os.homedir).mockReturnValue(sandboxHome);

const mod = await import('../server');
const { app, VERIFY_TOKEN } = mod;

const __server = app.listen(0);
const agent = () => request(__server);
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });

const TEST_DB = testDbPath('hub-requeue-route-test-db.sqlite');
const DL = path.join(sandboxHome, '.agenfk', 'hub-deadletter.jsonl');
const ROUTE = '/internal/hub/requeue-deadletter';

function dlLine(eventId: string, reason = 'foreign_installation', type = 'pr.opened'): string {
  return JSON.stringify({
    eventId,
    occurredAt: '2026-10-07T10:00:00.000Z',
    deadletteredAt: '2026-10-07T10:00:05.000Z',
    reason,
    payload: {
      eventId, occurredAt: '2026-10-07T10:00:00.000Z', orgId: 'acme', installationId: 'inst-1', type,
      actor: { osUser: 'someone', gitEmail: 'someone@example.com' }, itemTitle: 'Secret title',
    },
  });
}
const seed = (...lines: string[]) => {
  fs.mkdirSync(path.dirname(DL), { recursive: true });
  fs.writeFileSync(DL, lines.join('\n') + '\n', { mode: 0o600 });
};

describe('deadletter requeue routes (#223)', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    await removeTestDb(TEST_DB, mod.closeStorage);
    await mod.initStorage();
  });
  afterAll(async () => {
    await removeTestDb(TEST_DB, mod.closeStorage);
    vi.mocked(os.homedir).mockRestore();
    try { fs.rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
  });
  beforeEach(() => {
    (mod.storage as any).database.prepare('DELETE FROM hub_outbox').run();
    fs.rmSync(DL, { force: true });
  });

  describe('POST /internal/hub/requeue-deadletter', () => {
    it('403 without the internal token, and nothing moves', async () => {
      seed(dlLine('a'));
      const res = await agent().post(ROUTE).set('x-agenfk-internal', 'wrong').send({ filters: {} });
      expect(res.status).toBe(403);
      expect((mod.storage as any).hubOutboxCount()).toBe(0);
      expect(fs.existsSync(DL)).toBe(true);
    });

    it('400 on malformed filters, including org_mismatch without --org', async () => {
      for (const body of [{ filters: { reason: ['x'] }, dryRun: true }, { filters: { since: 'soon' }, dryRun: true }, { filters: { reasons: ['org_mismatch'] }, dryRun: true }, { filters: {}, dryRun: 'yes' }, { filters: {}, dryRun: true, eventIds: 'a' }, { filters: {}, dryRun: true, eventIds: [''] }]) {
        const res = await agent().post(ROUTE).set('x-agenfk-internal', VERIFY_TOKEN).send(body);
        expect(res.status).toBe(400);
        expect(typeof res.body.error).toBe('string');
      }
    });

    // Review finding 5: a body that lost its fields must not become a real run.
    it('400 when dryRun is not given explicitly, and nothing moves', async () => {
      seed(dlLine('a'));
      for (const body of [{ filters: {} }, {}]) {
        const res = await agent().post(ROUTE).set('x-agenfk-internal', VERIFY_TOKEN).send(body);
        expect(res.status).toBe(400);
      }
      const notJson = await agent().post(ROUTE).set('x-agenfk-internal', VERIFY_TOKEN).set('Content-Type', 'text/plain').send('requeue please');
      expect(notJson.status).toBe(400);
      expect((mod.storage as any).hubOutboxCount()).toBe(0);
      expect(fs.readFileSync(DL, 'utf8')).toBe(dlLine('a') + '\n');
    });

    it('a real run with eventIds moves only those', async () => {
      seed(dlLine('a'), dlLine('b'));
      const res = await agent().post(ROUTE).set('x-agenfk-internal', VERIFY_TOKEN).send({ filters: {}, dryRun: false, eventIds: ['b'] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ requeued: 1, remaining: 1, eventIds: ['b'], excluded: { unconfirmed: 1 } });
      expect(fs.readFileSync(DL, 'utf8')).toBe(dlLine('a') + '\n');
    });

    it('dry run returns the summary and changes nothing', async () => {
      seed(dlLine('a'), dlLine('b', 'hidden_user'));
      const res = await agent().post(ROUTE).set('x-agenfk-internal', VERIFY_TOKEN).send({ filters: {}, dryRun: true });
      expect(res.status).toBe(200);
      expect(res.body.dryRun).toBe(true);
      expect(res.body.summary).toMatchObject({ count: 1, byReason: { foreign_installation: 1 }, byInstallation: { 'inst-1': 1 } });
      expect(res.body.excluded).toEqual({ 'reason:hidden_user': 1 });
      expect(res.body.eventIds).toEqual(['a']);
      expect(res.body.requeued).toBe(0);
      expect((mod.storage as any).hubOutboxCount()).toBe(0);
      expect(fs.readFileSync(DL, 'utf8').trim().split('\n')).toHaveLength(2);
    });

    it('a real run moves the lines into the outbox and out of the file', async () => {
      seed(dlLine('a'), dlLine('b', 'hidden_user'));
      const res = await agent().post(ROUTE).set('x-agenfk-internal', VERIFY_TOKEN).send({ filters: {}, dryRun: false });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ dryRun: false, requeued: 1, alreadyQueued: 0, remaining: 1, eventIds: ['a'] });
      const rows = (mod.storage as any).hubOutboxPeek();
      expect(rows.map((r: any) => [r.event_id, r.occurred_at])).toEqual([['a', '2026-10-07T10:00:00.000Z']]);
      expect(fs.readFileSync(DL, 'utf8')).toBe(dlLine('b', 'hidden_user') + '\n');
    });
  });

  describe('GET /internal/hub/status', () => {
    it('carries the deadletter indicator even with no hub configured', async () => {
      seed(dlLine('a'), dlLine('b'), dlLine('c', 'hidden_user'));
      const res = await agent().get('/internal/hub/status').set('x-agenfk-internal', VERIFY_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.deadletter).toEqual({
        count: 3, actionable: 2, since: '2026-10-07T10:00:05.000Z',
        reasons: { foreign_installation: 2, hidden_user: 1 }, unparseable: 0,
      });
    });
  });

  describe('GET /hub/refusals', () => {
    it('returns counts and a hint, never payloads or paths', async () => {
      seed(dlLine('a'), dlLine('b', 'hidden_user'));
      const res = await agent().get('/hub/refusals');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        count: 2, actionable: 1, since: '2026-10-07T10:00:05.000Z',
        reasons: { foreign_installation: 1, hidden_user: 1 }, unparseable: 0,
        hint: expect.stringMatching(/agenfk hub join/),
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/someone@example.com|Secret title|hub-deadletter|\.agenfk/);
    });

    it('is all zeros with a null hint when nothing was refused', async () => {
      const res = await agent().get('/hub/refusals');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 0, actionable: 0, since: null, reasons: {}, unparseable: 0, hint: null });
    });
  });
});
