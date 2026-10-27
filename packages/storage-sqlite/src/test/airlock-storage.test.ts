/**
 * Airlock storage (GH-294, T2): the policy rows (one per scope, written by
 * compare-and-swap on the revision), the capped decision log, and the approval
 * rows T5's grant flow will use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import { DEFAULT_AIRLOCK_POLICY, normalizeAirlockPolicy, type StoredAirlockPolicy } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { DatabaseSync } = require('node:sqlite');

let dir: string;
let dbPath: string;
let storage: SQLiteStorageProvider;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-airlock-storage-'));
  dbPath = path.join(dir, 'db.sqlite');
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

const row = (revision: number, mode: 'off' | 'observe' | 'enforce' = 'enforce', scope: 'local' | 'hub' = 'local'): StoredAirlockPolicy => ({
  scope,
  revision,
  policy: normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, mode }),
  updatedAt: new Date().toISOString(),
  updatedBy: 'tester',
  authority: scope === 'hub' ? 'hub' : 'local',
});

const decision = (n: number) => ({
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  client: 'pi',
  model: 'cloudflare/glm',
  tool: 'bash',
  capabilityKind: 'command',
  target: `curl http://host-${n}/`,
  decision: 'deny' as const,
  rule: 'denied-host',
  mode: 'enforce' as const,
  itemId: null,
  sessionId: null,
});

describe('airlock policy rows', () => {
  it('fresh db: null for both scopes', async () => {
    expect(await storage.getAirlockPolicy('local')).toBeNull();
    expect(await storage.getAirlockPolicy('hub')).toBeNull();
  });

  it('writes a scope at revision 0 -> 1 and reads it back; scopes are independent', async () => {
    const stored = await storage.putAirlockPolicy(row(1), 0);
    expect(stored.revision).toBe(1);
    const back = await storage.getAirlockPolicy('local');
    expect(back?.revision).toBe(1);
    expect(back?.policy.mode).toBe('enforce');
    expect(back?.authority).toBe('local');
    expect(await storage.getAirlockPolicy('hub')).toBeNull();
  });

  it('stale expectedRevision refused, nothing written', async () => {
    await storage.putAirlockPolicy(row(1, 'observe'), 0);
    await expect(storage.putAirlockPolicy(row(2, 'enforce'), 0)).rejects.toMatchObject({ code: 'AIRLOCK_STALE_REVISION', currentRevision: 1 });
    const back = await storage.getAirlockPolicy('local');
    expect(back?.revision).toBe(1);
    expect(back?.policy.mode).toBe('observe');
    // and a write against the current revision goes through
    const next = await storage.putAirlockPolicy(row(2, 'enforce'), 1);
    expect(next.revision).toBe(2);
    expect((await storage.getAirlockPolicy('local'))?.policy.mode).toBe('enforce');
  });

  it('a first write that expects a revision other than 0 is stale', async () => {
    await expect(storage.putAirlockPolicy(row(4), 3)).rejects.toMatchObject({ code: 'AIRLOCK_STALE_REVISION', currentRevision: 0 });
    expect(await storage.getAirlockPolicy('local')).toBeNull();
  });

  it('existing pre-airlock db gains the tables on init', async () => {
    await storage.shutdown();
    const old = path.join(dir, 'old.sqlite');
    const db = new DatabaseSync(old);
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, parent_id TEXT, data TEXT NOT NULL);
    `);
    db.close();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: old });
    const tables = new Set(((storage as any).database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map(r => r.name));
    expect(tables.has('airlock_policy')).toBe(true);
    expect(tables.has('airlock_decisions')).toBe(true);
    expect(tables.has('airlock_approvals')).toBe(true);
    expect(await storage.getAirlockPolicy('local')).toBeNull();
  });
});

describe('airlock decision log', () => {
  it('lists newest first', async () => {
    for (let i = 0; i < 3; i++) await storage.recordAirlockDecision(decision(i));
    const list = await storage.listAirlockDecisions({ limit: 10 });
    expect(list.map(d => d.target)).toEqual(['curl http://host-2/', 'curl http://host-1/', 'curl http://host-0/']);
    expect(list[0]).toMatchObject({ client: 'pi', decision: 'deny', rule: 'denied-host', mode: 'enforce', capabilityKind: 'command' });
  });

  it('decision log capped, oldest dropped', async () => {
    const cap = SQLiteStorageProvider.AIRLOCK_DECISION_CAP;
    expect(cap).toBe(5000);
    for (let i = 0; i < cap + 3; i++) await storage.recordAirlockDecision(decision(i));
    const count = ((storage as any).database.prepare('SELECT COUNT(*) AS n FROM airlock_decisions').get() as { n: number }).n;
    expect(count).toBe(cap);
    const all = await storage.listAirlockDecisions({ limit: cap + 10 });
    const targets = new Set(all.map(d => d.target));
    expect(targets.has('curl http://host-0/')).toBe(false);
    expect(targets.has('curl http://host-2/')).toBe(false);
    expect(targets.has('curl http://host-3/')).toBe(true);
    expect(targets.has(`curl http://host-${cap + 2}/`)).toBe(true);
  });
});

describe('airlock approvals (storage only; the grant flow is T5)', () => {
  it('upsert records a pending request; grant then consume once', async () => {
    await storage.upsertAirlockApproval({ key: 'k1', rule: 'cloud-mutation', summary: 'aws s3 rm s3://b/x', projectId: 'p', itemId: 'i', sessionId: 's', requestedAt: '2026-01-01T00:00:00.000Z' });
    let a = await storage.getAirlockApproval('k1');
    expect(a).toMatchObject({ key: 'k1', rule: 'cloud-mutation', grantedAt: null, consumedAt: null });

    const granted = await storage.grantAirlockApproval('k1', { grantedBy: 'ana', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z' });
    expect(granted?.grantedBy).toBe('ana');
    a = await storage.getAirlockApproval('k1');
    expect(a?.grantedAt).toBeTruthy();

    expect(await storage.consumeAirlockApproval('k1')).toBe(true);
    expect(await storage.consumeAirlockApproval('k1')).toBe(false);
    expect((await storage.getAirlockApproval('k1'))?.consumedAt).toBeTruthy();
  });

  it('an ungranted or unknown request cannot be consumed; grant of an unknown key is null', async () => {
    await storage.upsertAirlockApproval({ key: 'k2', rule: 'cloud-mutation', summary: 's', requestedAt: '2026-01-01T00:00:00.000Z' });
    expect(await storage.consumeAirlockApproval('k2')).toBe(false);
    expect(await storage.consumeAirlockApproval('nope')).toBe(false);
    expect(await storage.grantAirlockApproval('nope', { grantedBy: 'x', authority: 'board' })).toBeNull();
  });

  it('an expired grant cannot be consumed', async () => {
    await storage.upsertAirlockApproval({ key: 'k3', rule: 'cloud-mutation', summary: 's', requestedAt: '2026-01-01T00:00:00.000Z' });
    await storage.grantAirlockApproval('k3', { grantedBy: 'x', authority: 'board', expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(await storage.consumeAirlockApproval('k3')).toBe(false);
  });

  it('a re-request after the grant was consumed reopens it as pending, and it can be granted again', async () => {
    const req = { key: 'r1', rule: 'cloud-mutation', summary: 's', requestedAt: '2026-01-01T00:00:00.000Z' };
    await storage.upsertAirlockApproval(req);
    await storage.grantAirlockApproval('r1', { grantedBy: 'ana', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z' });
    expect(await storage.consumeAirlockApproval('r1')).toBe(true);

    const again = await storage.upsertAirlockApproval({ ...req, requestedAt: '2026-01-02T00:00:00.000Z' });
    expect(again).toMatchObject({ grantedAt: null, grantedBy: null, authority: null, expiresAt: null, consumedAt: null });
    expect((await storage.listAirlockApprovals({ pending: true })).map(a => a.key)).toEqual(['r1']);
    expect(await storage.consumeAirlockApproval('r1')).toBe(false);

    await storage.grantAirlockApproval('r1', { grantedBy: 'ana', authority: 'board' });
    expect(await storage.consumeAirlockApproval('r1')).toBe(true);
  });

  it('a re-request after the grant expired reopens it as pending', async () => {
    const req = { key: 'r2', rule: 'cloud-mutation', summary: 's', requestedAt: '2026-01-01T00:00:00.000Z' };
    await storage.upsertAirlockApproval(req);
    await storage.grantAirlockApproval('r2', { grantedBy: 'ana', authority: 'board', expiresAt: '2000-01-01T00:00:00.000Z' });
    const again = await storage.upsertAirlockApproval(req);
    expect(again).toMatchObject({ grantedAt: null, expiresAt: null, consumedAt: null });
    expect((await storage.listAirlockApprovals({ pending: true })).map(a => a.key)).toEqual(['r2']);
  });

  it('a re-request while the grant is still usable leaves the grant untouched', async () => {
    const req = { key: 'r3', rule: 'cloud-mutation', summary: 's', requestedAt: '2026-01-01T00:00:00.000Z' };
    await storage.upsertAirlockApproval(req);
    await storage.grantAirlockApproval('r3', { grantedBy: 'ana', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z' });
    const again = await storage.upsertAirlockApproval(req);
    expect(again).toMatchObject({ grantedBy: 'ana', expiresAt: '2099-01-01T00:00:00.000Z', consumedAt: null });
    expect(again.grantedAt).toBeTruthy();
    expect(await storage.consumeAirlockApproval('r3')).toBe(true);
  });

  it('lists pending approvals', async () => {
    await storage.upsertAirlockApproval({ key: 'a', rule: 'cloud-mutation', summary: 's', requestedAt: '2026-01-01T00:00:00.000Z' });
    await storage.upsertAirlockApproval({ key: 'b', rule: 'cloud-mutation', summary: 's', requestedAt: '2026-01-02T00:00:00.000Z' });
    await storage.grantAirlockApproval('a', { grantedBy: 'x', authority: 'board' });
    const pending = await storage.listAirlockApprovals({ pending: true });
    expect(pending.map(p => p.key)).toEqual(['b']);
  });
});
