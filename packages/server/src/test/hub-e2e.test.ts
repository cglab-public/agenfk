import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubClient, Flusher } from '../hub';
import { createHubApp } from '../../../hub/src/server';
import { issueApiKey } from '../../../hub/src/auth/apiKey';

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

    const out = createHubApp({
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
    token = issueApiKey(hubCtx.db, 'org', 'e2e');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
    hubCtx.db.close();
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

    const row = hubCtx.db.prepare('SELECT * FROM events').get() as any;
    expect(row.type).toBe('item.created');
    expect(row.installation_id).toBe('e2e-installation');
    expect(JSON.parse(row.payload).payload.title).toBe('Demo');
    const inst = hubCtx.db.prepare('SELECT * FROM installations').get() as any;
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
    const c = (hubCtx.db.prepare('SELECT COUNT(*) AS c FROM events').get() as any).c;
    expect(c).toBe(1);
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
