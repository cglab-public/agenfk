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
  it('releaseAirlockHubPolicy moves the hub row to local in one step, at the next local revision', async () => {
    await storage.putAirlockPolicy(row(2, 'off', 'local'), 0);
    await storage.putAirlockPolicy(row(7, 'enforce', 'hub'), 0);
    const local = await storage.releaseAirlockHubPolicy(7, { updatedAt: '2026-10-27T00:00:00.000Z', updatedBy: 'left the hub' });
    expect(local?.revision).toBe(3);
    expect(local?.authority).toBe('local');
    expect((await storage.getAirlockPolicy('local'))?.policy.mode).toBe('enforce');
    expect(await storage.getAirlockPolicy('hub')).toBeNull();
  });

  it('releaseAirlockHubPolicy changes nothing when the hub row is not the expected one', async () => {
    await storage.putAirlockPolicy(row(8, 'enforce', 'hub'), 0);
    expect(await storage.releaseAirlockHubPolicy(7, { updatedAt: 'x', updatedBy: 'y' })).toBeNull();
    expect((await storage.getAirlockPolicy('hub'))?.revision).toBe(8);
    expect(await storage.getAirlockPolicy('local')).toBeNull();
  });

  it('deleteAirlockPolicy removes only that scope, and says whether it removed one', async () => {
    await storage.putAirlockPolicy(row(1, 'enforce', 'hub'), 0);
    await storage.putAirlockPolicy(row(1, 'observe', 'local'), 0);
    expect(await storage.deleteAirlockPolicy('hub')).toBe(true);
    expect(await storage.getAirlockPolicy('hub')).toBeNull();
    expect((await storage.getAirlockPolicy('local'))?.policy.mode).toBe('observe');
    expect(await storage.deleteAirlockPolicy('hub')).toBe(false);
  });

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

  it('TEL-1: a decision keeps its source (tool or proxy) and client', async () => {
    await storage.recordAirlockDecision({ ...decision(0), source: 'tool' });
    await storage.recordAirlockDecision({ ...decision(1), client: 'opencode', source: 'proxy', tool: 'proxy', capabilityKind: 'host', target: 'evil.example:443' });
    const [proxy, tool] = await storage.listAirlockDecisions({ limit: 10 });
    expect(proxy).toMatchObject({ source: 'proxy', client: 'opencode', target: 'evil.example:443', capabilityKind: 'host' });
    expect(tool).toMatchObject({ source: 'tool', client: 'pi' });
  });

  it('TEL-1: a decision recorded without a source is a tool decision', async () => {
    await storage.recordAirlockDecision(decision(0));
    expect((await storage.listAirlockDecisions({ limit: 1 }))[0].source).toBe('tool');
  });

  it('TEL-1: a decision log made before sources gains the column; its rows read as tool decisions', async () => {
    await storage.shutdown();
    const old = path.join(dir, 'pre-source.sqlite');
    const db = new DatabaseSync(old);
    db.exec(`
      CREATE TABLE airlock_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, client TEXT NOT NULL, model TEXT, tool TEXT NOT NULL,
        capability_kind TEXT, target TEXT, decision TEXT NOT NULL, rule TEXT, mode TEXT NOT NULL, item_id TEXT, session_id TEXT
      );
      INSERT INTO airlock_decisions (ts, client, tool, decision, mode) VALUES ('2026-01-01T00:00:00.000Z', 'pi', 'bash', 'deny', 'enforce');
    `);
    db.close();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: old });
    const columns = ((storage as any).database.prepare('PRAGMA table_info(airlock_decisions)').all() as { name: string }[]).map(c => c.name);
    expect(columns).toContain('source');
    const [before] = await storage.listAirlockDecisions({ limit: 1 });
    expect(before).toMatchObject({ source: 'tool', client: 'pi', tool: 'bash' });
    await storage.recordAirlockDecision({ ...decision(5), source: 'proxy' });
    expect((await storage.listAirlockDecisions({ limit: 1 }))[0].source).toBe('proxy');
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
  it('deny (T5): leaves pending, revokes an unused grant, survives a re-request, and a grant clears it', async () => {
    const req = { key: 'd1', rule: 'cloud-mutation', summary: 's', requestedAt: '2026-01-01T00:00:00.000Z' };
    await storage.upsertAirlockApproval(req);
    await storage.grantAirlockApproval('d1', { grantedBy: 'ana', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z' });
    const denied = await storage.denyAirlockApproval('d1', { deniedBy: 'bo' });
    expect(denied).toMatchObject({ deniedBy: 'bo', grantedAt: null, expiresAt: null });
    expect(denied?.deniedAt).toBeTruthy();
    expect(await storage.consumeAirlockApproval('d1')).toBe(false);
    expect(await storage.listAirlockApprovals({ pending: true })).toEqual([]);

    const again = await storage.upsertAirlockApproval({ ...req, requestedAt: '2026-01-02T00:00:00.000Z' });
    expect(again.deniedAt).toBeTruthy();

    const granted = await storage.grantAirlockApproval('d1', { grantedBy: 'ana', authority: 'board' });
    expect(granted).toMatchObject({ deniedAt: null, deniedBy: null });
    expect(await storage.consumeAirlockApproval('d1')).toBe(true);
    expect(await storage.denyAirlockApproval('nope', { deniedBy: 'bo' })).toBeNull();
  });

  it('consume and the re-request judge expiry by the clock they are given', async () => {
    const req = { key: 'c1', rule: 'cloud-mutation', summary: 's', requestedAt: '2026-01-01T00:00:00.000Z' };
    await storage.upsertAirlockApproval(req);
    await storage.grantAirlockApproval('c1', { grantedBy: 'ana', authority: 'board', expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(await storage.consumeAirlockApproval('c1', '2031-01-01T00:00:00.000Z')).toBe(false);
    const again = await storage.upsertAirlockApproval(req, '2031-01-01T00:00:00.000Z');
    expect(again.grantedAt).toBeNull();
  });

  it('an approvals table from before denials gains their columns on init', async () => {
    await storage.shutdown();
    const old = path.join(dir, 'old-approvals.sqlite');
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE airlock_approvals (key TEXT PRIMARY KEY, rule TEXT NOT NULL, summary TEXT NOT NULL, project_id TEXT, item_id TEXT,
      session_id TEXT, requested_at TEXT NOT NULL, granted_at TEXT, granted_by TEXT, authority TEXT, expires_at TEXT, consumed_at TEXT);
      INSERT INTO airlock_approvals (key, rule, summary, requested_at) VALUES ('old', 'cloud-mutation', 's', '2026-01-01T00:00:00.000Z');`);
    db.close();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: old });
    expect(await storage.denyAirlockApproval('old', { deniedBy: 'bo' })).toMatchObject({ key: 'old', deniedBy: 'bo' });
  });
});

describe('airlock approvals: review fixes (T5 round 1)', () => {
  const scope = { sessionId: 's1', itemId: 'i1' };
  const ask = (key: string, over: Record<string, unknown> = {}) =>
    storage.upsertAirlockApproval({ key, rule: 'cloud-mutation', summary: 's', sessionId: 's1', itemId: 'i1', requestedAt: '2026-01-01T00:00:00.000Z', ...over });

  it('consumes a set of grants all together or not at all', async () => {
    await ask('a'); await ask('b');
    const ga = (await storage.getAirlockApproval('a'))!.generation!;
    await storage.grantAirlockApproval('a', { grantedBy: 'x', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z', generation: ga });
    expect(await storage.consumeAirlockApprovals(['a', 'b'], scope)).toBe(false);
    expect((await storage.getAirlockApproval('a'))?.consumedAt).toBeNull();
    const gb = (await storage.getAirlockApproval('b'))!.generation!;
    await storage.grantAirlockApproval('b', { grantedBy: 'x', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z', generation: gb });
    expect(await storage.consumeAirlockApprovals(['a', 'b'], scope)).toBe(true);
    expect(await storage.consumeAirlockApprovals(['a'], scope)).toBe(false);
  });

  it('a grant is consumed only in the scope (session and card) that asked for it', async () => {
    await ask('c');
    const g = (await storage.getAirlockApproval('c'))!.generation!;
    await storage.grantAirlockApproval('c', { grantedBy: 'x', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z', generation: g });
    expect(await storage.consumeAirlockApprovals(['c'], { sessionId: 's2', itemId: 'i1' })).toBe(false);
    expect(await storage.consumeAirlockApprovals(['c'], { sessionId: 's1', itemId: 'i2' })).toBe(false);
    expect(await storage.consumeAirlockApprovals(['c'], scope)).toBe(true);
  });

  it('a re-request from another scope does not take over a usable grant', async () => {
    await ask('d');
    const g = (await storage.getAirlockApproval('d'))!.generation!;
    await storage.grantAirlockApproval('d', { grantedBy: 'x', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z', generation: g });
    await ask('d', { sessionId: 's2' });
    expect((await storage.getAirlockApproval('d'))?.sessionId).toBe('s1');
  });

  it('a reopened request is a new generation; a grant for the old one changes nothing', async () => {
    await ask('e');
    const g1 = (await storage.getAirlockApproval('e'))!.generation!;
    await storage.grantAirlockApproval('e', { grantedBy: 'x', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z', generation: g1 });
    expect(await storage.consumeAirlockApprovals(['e'], scope)).toBe(true);
    const consumed = await storage.getAirlockApproval('e');
    const replay = await storage.grantAirlockApproval('e', { grantedBy: 'x', authority: 'board', expiresAt: '2100-01-01T00:00:00.000Z', generation: g1 });
    expect(replay?.transition).toBe('refused');
    expect(await storage.getAirlockApproval('e')).toMatchObject({ consumedAt: consumed!.consumedAt, expiresAt: consumed!.expiresAt });
    await ask('e');
    const g2 = (await storage.getAirlockApproval('e'))!.generation!;
    expect(g2).toBeGreaterThan(g1);
    expect((await storage.grantAirlockApproval('e', { grantedBy: 'x', authority: 'board', generation: g1 }))?.transition).toBe('refused');
    expect((await storage.grantAirlockApproval('e', { grantedBy: 'x', authority: 'board', generation: g2 }))?.transition).toBe('changed');
    // The grant is itself a new version: an answer for the one the person now sees is idempotent.
    const g3 = (await storage.getAirlockApproval('e'))!.generation!;
    expect(g3).toBeGreaterThan(g2);
    expect((await storage.grantAirlockApproval('e', { grantedBy: 'x', authority: 'board', generation: g3 }))?.transition).toBe('unchanged');
  });

  it('every transition is a new generation: grant, deny, consume, reopen, and a change of who asked', async () => {
    await ask('g');
    const gens = [(await storage.getAirlockApproval('g'))!.generation!];
    const gen = async () => (await storage.getAirlockApproval('g'))!.generation!;
    await ask('g', { sessionId: 's2' });                      // pending, asked by someone else
    gens.push(await gen());
    await ask('g', { sessionId: 's2', itemId: 'i9' });        // and from another card
    gens.push(await gen());
    await ask('g', { sessionId: 's2', itemId: 'i9' });        // the same asker again: same version
    expect(await gen()).toBe(gens[gens.length - 1]);
    await storage.grantAirlockApproval('g', { grantedBy: 'x', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z', generation: await gen() });
    gens.push(await gen());
    await storage.denyAirlockApproval('g', { deniedBy: 'x', generation: await gen() });
    gens.push(await gen());
    await storage.grantAirlockApproval('g', { grantedBy: 'x', authority: 'board', expiresAt: '2099-01-01T00:00:00.000Z', generation: await gen() });
    gens.push(await gen());
    expect(await storage.consumeAirlockApprovals(['g'], { sessionId: 's2', itemId: 'i9' })).toBe(true);
    gens.push(await gen());
    await ask('g', { sessionId: 's2', itemId: 'i9' });        // reopened
    gens.push(await gen());
    for (let i = 1; i < gens.length; i++) expect(gens[i], `step ${i}`).toBeGreaterThan(gens[i - 1]);
  });

  it('stores the structured, redacted capabilities a request is bound to', async () => {
    await ask('f', { capabilities: [{ kind: 'path', value: '~/.aws/credentials', access: 'read' }, { kind: 'url', value: 'https://x.example/' }] });
    expect((await storage.getAirlockApproval('f'))?.capabilities).toEqual([{ kind: 'path', value: '~/.aws/credentials', access: 'read' }, { kind: 'url', value: 'https://x.example/' }]);
  });
});
