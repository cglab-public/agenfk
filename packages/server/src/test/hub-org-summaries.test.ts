/**
 * Story e3068dce (CGLAB-117): per-org outbox summaries powering
 * `agenfk hub carry-over`'s confirmation summary.
 *
 * The carry-over command reads counts / time range / event types from
 * GET /internal/hub/status — which must expose them even when the hub is NOT
 * configured (a stale-org install is exactly when carry-over is needed).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Sandbox homedir via a CALL-TIME mock of os.homedir() (item 9c297075), armed
// BEFORE importing the server: on a hub-configured dev machine a real
// ~/.agenfk/hub.json would construct the real hubFlusher, making `enabled`
// non-deterministic (and pointing the flusher at the live hub). The mock works
// under any runner — an env override only works while libuv follows the JS env
// (not under Stryker's threads pool).
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-status-'));
vi.mocked(os.homedir).mockReturnValue(sandboxHome);

const mod = await import('../server');
const { app, VERIFY_TOKEN } = mod;

const TEST_DB = path.resolve('./hub-org-summaries-test-db.sqlite');

describe('hub outbox org summaries', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await mod.initStorage();
  });
  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    vi.mocked(os.homedir).mockRestore();
    try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  beforeEach(async () => {
    (mod.storage as any).database.prepare('DELETE FROM hub_outbox').run();
  });

  const queue = (id: string, orgId: string | undefined, occurredAt: string, type: string) => {
    (mod.storage as any).hubOutboxAppend(id, occurredAt, JSON.stringify({
      eventId: id, orgId, occurredAt, type, payload: {},
    }));
  };

  it('hubOutboxOrgSummaries(): per-org count, occurred range and type tallies', async () => {
    queue('a1', 'acme', '2026-01-01T00:00:00Z', 'item.created');
    queue('a2', 'acme', '2026-01-05T00:00:00Z', 'item.closed');
    queue('a3', 'acme', '2026-01-09T00:00:00Z', 'item.moved');
    queue('b1', 'old-corp', '2026-02-02T00:00:00Z', 'item.created');
    (mod.storage as any).hubOutboxAppend('rot', '2026-01-01T00:00:00Z', 'NOT-JSON');
    (mod.storage as any).hubOutboxAppend('noorg', '2026-01-01T00:00:00Z', JSON.stringify({ eventId: 'noorg', type: 'x' }));

    const summaries = (mod.storage as any).hubOutboxOrgSummaries();
    expect(summaries.acme).toEqual({
      count: 3, firstOccurredAt: '2026-01-01T00:00:00Z', lastOccurredAt: '2026-01-09T00:00:00Z',
      types: { 'item.created': 1, 'item.closed': 1, 'item.moved': 1 },
    });
    expect(summaries['old-corp'].count).toBe(1);
    // Unparseable payloads and rows without an orgId carry no org to summarize.
    expect(Object.keys(summaries).sort()).toEqual(['acme', 'old-corp']);
  });

  it('hubOutboxOrgSummaries(): a row without a type counts toward the org but gets no type tally', async () => {
    queue('t1', 'acme', '2026-01-05T00:00:00Z', 'item.created');
    (mod.storage as any).hubOutboxAppend('t2', '2026-01-03T00:00:00Z', JSON.stringify({ eventId: 't2', orgId: 'acme' }));
    const summaries = (mod.storage as any).hubOutboxOrgSummaries();
    expect(summaries.acme.count).toBe(2);
    expect(summaries.acme.types).toEqual({ 'item.created': 1 });
    // Range folds across type-groups regardless of scan order (NULL-type
    // group sorts first): min comes from the typed row, max from the NULL one.
    expect(summaries.acme.firstOccurredAt).toBe('2026-01-03T00:00:00Z');
    expect(summaries.acme.lastOccurredAt).toBe('2026-01-05T00:00:00Z');
  });

  it('GET /internal/hub/status includes orgs even with the hub unconfigured', async () => {
    queue('s1', 'old-corp', '2026-03-01T00:00:00Z', 'item.created');
    const res = await request(app)
      .get('/internal/hub/status')
      .set('x-agenfk-internal', VERIFY_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.orgs['old-corp'].count).toBe(1);
    expect(res.body.orgs['old-corp'].types['item.created']).toBe(1);
  });

  it('GET /internal/hub/status still requires the internal token', async () => {
    const res = await request(app).get('/internal/hub/status');
    expect(res.status).toBe(403);
  });
});
