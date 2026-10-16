import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubClient, Flusher } from '../hub';
import { requeueDeadletter } from '../hub/deadletter';
import { createHubApp } from '../../../hub/src/server';
import { issueApiKey } from '../../../hub/src/auth/apiKey';
import { recomputeRollups } from '../../../hub/src/rollup';

const ts = `${process.pid}-${Math.random().toString(36).slice(2)}`;
const SENDER_DB = path.join(os.tmpdir(), `agenfk-hub-e2e-sender-${ts}.sqlite`);
const HUB_DB = path.join(os.tmpdir(), `agenfk-hub-e2e-hub-${ts}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const base of [SENDER_DB, HUB_DB]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = base + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
};

describe('hub end-to-end: outbox → ingest → query', () => {
  let sender: SQLiteStorageProvider;
  let hubServer: http.Server;
  let hubCtx: any;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    cleanup();

    sender = new SQLiteStorageProvider();
    await sender.init({ path: SENDER_DB });

    const out = await createHubApp({
      dbPath: HUB_DB,
      secretKey: SECRET,
      sessionSecret: 'sess-secret',
      defaultOrgId: 'org',
    });
    hubCtx = out.ctx;
    hubServer = out.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => hubServer.once('listening', () => resolve()));
    const addr = hubServer.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    token = await issueApiKey(hubCtx.db, 'org', 'e2e');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
    await hubCtx.db.close();
    await sender.shutdown();
    cleanup();
  });

  it('flushes a recorded event end-to-end', async () => {
    const client = new HubClient('e2e-installation', { url: baseUrl, token, orgId: 'org' });
    client.attachStorage(sender);
    client.recordEvent({
      type: 'item.created',
      projectId: 'p1',
      itemId: 'i1',
      payload: { title: 'Demo' },
    });
    expect(sender.hubOutboxCount()).toBe(1);

    const flusher = new Flusher(sender, { url: baseUrl, token, orgId: 'org' }, 'e2e-installation', 30_000, 500);
    await flusher.flush();
    expect(sender.hubOutboxCount()).toBe(0);

    const row = await hubCtx.db.get('SELECT * FROM events') as any;
    expect(row.type).toBe('item.created');
    expect(row.installation_id).toBe('e2e-installation');
    expect(JSON.parse(row.payload).payload.title).toBe('Demo');
    const inst = await hubCtx.db.get('SELECT * FROM installations') as any;
    expect(inst.id).toBe('e2e-installation');
  });

  it('replay is idempotent (re-pushing same event does not duplicate)', async () => {
    const client = new HubClient('e2e-installation', { url: baseUrl, token, orgId: 'org' });
    client.attachStorage(sender);
    client.recordEvent({ type: 'item.created', itemId: 'i1', payload: {} });
    const peeked = sender.hubOutboxPeek()[0];
    const flusher = new Flusher(sender, { url: baseUrl, token, orgId: 'org' }, 'e2e-installation', 30_000, 500);
    await flusher.flush();

    // Re-append the very same event_id with the original payload — simulates a
    // crash/restart scenario where the outbox row was not actually deleted.
    sender.hubOutboxAppend(peeked.event_id, peeked.occurred_at, peeked.payload);
    expect(sender.hubOutboxCount()).toBe(1);
    await flusher.flush();
    const cRow = await hubCtx.db.get('SELECT COUNT(*) AS c FROM events') as any;
    expect(cRow.c).toBe(1);
  });

  // #223, the incident end to end: a reinstall left this machine on a key bound
  // to its OLD installation, so the hub refused everything for days. Once the
  // machine is re-onboarded, the requeue sends the very same events — same
  // eventId, same occurredAt — and the hub rolls them up on their own days.
  it('deadlettered events reach the hub with their original identity after a re-join and a requeue', async () => {
    const dlPath = path.join(os.tmpdir(), `agenfk-hub-e2e-dl-${ts}.jsonl`);
    try {
      const staleKey = await issueApiKey(hubCtx.db, 'org', 'old-install', { installationId: 'inst-old' });
      const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const client = new HubClient('inst-new', { url: baseUrl, token: staleKey, orgId: 'org' });
      client.attachStorage(sender);
      client.recordEvent({ type: 'pr.opened', occurredAt: old, payload: { prNumber: 2, repo: 'acme/app' } });
      client.recordEvent({ type: 'item.closed', occurredAt: old, itemId: 'i1', payload: {} });
      const original = sender.hubOutboxPeek().map(r => [r.event_id, r.occurred_at]).sort();

      // 1. Refused: everything lands in the deadletter.
      const staleFlusher = new Flusher(sender, { url: baseUrl, token: staleKey, orgId: 'org' }, 'inst-new', 30_000, 500, undefined, dlPath);
      await staleFlusher.flush();
      expect(sender.hubOutboxCount()).toBe(0);
      expect(fs.readFileSync(dlPath, 'utf8').trim().split('\n')).toHaveLength(2);

      // 2. Requeue before fixing the binding: refused again, straight back, no loop.
      expect(requeueDeadletter({ storage: sender, path: dlPath, filters: {} }).requeued).toBe(2);
      await staleFlusher.flush();
      await staleFlusher.flush();
      expect(sender.hubOutboxCount()).toBe(0);
      expect(staleFlusher.getStatus().consecutiveFailures).toBe(0);
      expect(fs.readFileSync(dlPath, 'utf8').trim().split('\n')).toHaveLength(2);
      expect(Number((await hubCtx.db.get('SELECT COUNT(*) AS c FROM events') as any).c)).toBe(0);

      // 3. Re-join: a key bound to THIS installation. Today's activity gives
      //    the hub a rollup anchor, as on any live hub.
      const freshKey = await issueApiKey(hubCtx.db, 'org', 'rejoin', { installationId: 'inst-new' });
      const freshClient = new HubClient('inst-new', { url: baseUrl, token: freshKey, orgId: 'org' });
      freshClient.attachStorage(sender);
      freshClient.recordEvent({ type: 'item.created', itemId: 'i2', payload: {} });
      const flusher = new Flusher(sender, { url: baseUrl, token: freshKey, orgId: 'org' }, 'inst-new', 30_000, 500, undefined, dlPath);
      await flusher.flush();
      await recomputeRollups(hubCtx.db);

      // 4. Requeue and flush: delivered with the original identity.
      expect(requeueDeadletter({ storage: sender, path: dlPath, filters: {} }).requeued).toBe(2);
      await flusher.flush();
      expect(sender.hubOutboxCount()).toBe(0);
      expect(fs.existsSync(dlPath)).toBe(false);
      const stored = (await hubCtx.db.all("SELECT event_id, occurred_at FROM events WHERE type IN ('pr.opened', 'item.closed')") as any[])
        .map(r => [r.event_id, r.occurred_at]).sort();
      expect(stored).toEqual(original);
      const day = old.slice(0, 10);
      const rollup = await hubCtx.db.get('SELECT SUM(prs_opened) AS prs FROM rollups_daily WHERE org_id = ? AND day = ?', ['org', day]) as any;
      expect(Number(rollup?.prs)).toBe(1);
    } finally {
      fs.rmSync(dlPath, { force: true });
    }
  });

  it('halts on persistent 4xx (bad token)', async () => {
    const flusher = new Flusher(sender, { url: baseUrl, token: 'bogus', orgId: 'org' }, 'e2e-installation', 30_000, 500);
    const client = new HubClient('e2e-installation', { url: baseUrl, token: 'bogus', orgId: 'org' });
    client.attachStorage(sender);
    client.recordEvent({ type: 'item.created', payload: {} });
    for (let i = 0; i < 6; i++) {
      (flusher as any).nextEligibleAt = 0;
      await flusher.flush();
    }
    expect(flusher.getStatus().halted).toBe(true);
    expect(sender.hubOutboxCount()).toBe(1);
  });
});
