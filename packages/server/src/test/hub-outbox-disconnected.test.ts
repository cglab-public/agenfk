/**
 * TDD for outboxing hub events while the hub is DISCONNECTED (CGLAB-11).
 *
 * Previously HubClient.recordEvent bailed when no hub config was present, so
 * every event (including pr.opened) raised before `agenfk hub login` was
 * silently discarded — a later login could never back-fill them.
 *
 * Contract:
 *  - recordEvent with NO config still appends to the local outbox, with the
 *    pending-org sentinel '' baked into the payload (installationId intact).
 *  - When unconfigured, the outbox is capped (AGENFK_HUB_OUTBOX_CAP, default
 *    10000): oldest rows beyond the cap are pruned so a never-connected
 *    install can't grow the DB without bound.
 *  - hubOutboxRewriteOrgId('', orgId) stamps the pending rows — run at boot
 *    when a config IS present, so events queued pre-login deliver correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubClient } from '../hub/hubClient';

describe('HubClient.recordEvent while disconnected', () => {
  let dbPath: string;
  let storage: SQLiteStorageProvider;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `hub-outbox-disc-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(() => {
    delete process.env.AGENFK_HUB_OUTBOX_CAP;
    for (const suffix of ['', '-shm', '-wal']) {
      const f = `${dbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('appends to the outbox with the pending-org sentinel instead of dropping', () => {
    const client = new HubClient('install-1', null); // explicitly unconfigured
    client.attachStorage(storage);

    client.recordEvent({ type: 'pr.opened', projectId: 'p1', payload: { prNumber: 7, repo: 'a/b' } } as any);

    expect(storage.hubOutboxCount()).toBe(1);
    const [row] = storage.hubOutboxPeek(1);
    const event = JSON.parse(row.payload);
    expect(event.type).toBe('pr.opened');
    expect(event.orgId).toBe(''); // pending sentinel
    expect(event.installationId).toBe('install-1');
    expect(event.payload.prNumber).toBe(7);
  });

  it('still records normally when configured (orgId baked in as before)', () => {
    const client = new HubClient('install-2', { url: 'https://hub.example', token: 't', orgId: 'acme' });
    client.attachStorage(storage);

    client.recordEvent({ type: 'pr.opened', payload: {} } as any);

    const [row] = storage.hubOutboxPeek(1);
    expect(JSON.parse(row.payload).orgId).toBe('acme');
  });

  it('caps the unconfigured outbox, pruning the OLDEST rows', () => {
    process.env.AGENFK_HUB_OUTBOX_CAP = '5';
    const client = new HubClient('install-3', null);
    client.attachStorage(storage);

    for (let i = 0; i < 8; i++) {
      client.recordEvent({ type: 'item.closed', occurredAt: new Date(2026, 0, 1, 0, 0, i).toISOString(), payload: { seq: i } } as any);
    }

    expect(storage.hubOutboxCount()).toBe(5);
    const rows = storage.hubOutboxPeek(10);
    const seqs = rows.map(r => JSON.parse(r.payload).payload.seq);
    expect(seqs).toEqual([3, 4, 5, 6, 7]); // oldest three pruned
  });

  it('pending rows are stampable to a real org via hubOutboxRewriteOrgId', () => {
    const client = new HubClient('install-4', null);
    client.attachStorage(storage);
    client.recordEvent({ type: 'pr.opened', payload: {} } as any);
    client.recordEvent({ type: 'item.closed', payload: {} } as any);

    const rewritten = storage.hubOutboxRewriteOrgId('', 'acme');
    expect(rewritten).toBe(2);
    for (const row of storage.hubOutboxPeek(10)) {
      expect(JSON.parse(row.payload).orgId).toBe('acme');
    }
  });
});

describe('server boot stamps pending outbox rows when hub is configured', () => {
  it('server.ts rewrites the pending-org sentinel before starting the flusher', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    // The boot path must stamp pre-login events so the flusher doesn't ship
    // (or the hub reject) events with an empty orgId.
    expect(src).toMatch(/hubOutboxRewriteOrgId\(\s*['"]{2}\s*,/);
  });

  it('recordHubEvent no longer early-returns on a disabled hub', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    expect(src).not.toMatch(/if\s*\(\s*!hubClient\.isEnabled\s*\)\s*return/);
  });
});
