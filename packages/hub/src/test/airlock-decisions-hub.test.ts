import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { ORG_ID_CHILD_TABLES } from '../routes/orgRename';
import { AIRLOCK_DECISIONS_PAGE_MAX, MAX_DECISION_CURSOR_CHARS, MAX_DECISION_EVENT_ID_CHARS } from '../services/airlock';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

/**
 * The org's recent Airlock denials and alerts (GH-294, HUB-1).
 *
 * Installations send every Airlock event through their outbox (/v1/events);
 * the hub keeps them all in `events` like any other. An `airlock.decision` that
 * is a denial (deny, needs-human-approval - in observe mode, what enforce
 * would have done) or that carries an `alert` is also kept in
 * `airlock_decisions`, indexed by org and time, so the admin reads:
 *
 *   GET /v1/admin/airlock/decisions   newest first, a page at a time, filterable
 *
 * Run against SQLite and pg-mem, since production is Postgres.
 */

const SECRET = 'a'.repeat(64);
const ADMIN = 'admin@x';
const PASSWORD = 'longenough1';

let __server: any;

type Backend = 'sqlite' | 'postgres';

let seq = 0;
const event = (orgId: string, installationId: string, type: string, payload: unknown, occurredAt: string, eventId?: string) => ({
  eventId: eventId ?? `ev-${++seq}-${Math.random().toString(36).slice(2)}`,
  installationId,
  orgId,
  occurredAt,
  actor: { osUser: 'tester', gitName: null, gitEmail: `${installationId}@x` },
  type,
  payload,
});

/** A decision as the server's logDecision sends it: the record minus sessionId, plus revision and policySource. */
const decision = (over: Record<string, unknown> = {}) => ({
  ts: '2026-01-27T10:00:00.000Z',
  client: 'pi',
  model: 'cloudflare-workers-ai/qwen',
  tool: 'bash',
  capabilityKind: 'url',
  target: 'https://evil.example/upload',
  decision: 'deny',
  rule: 'uploadToUnlistedHost',
  mode: 'enforce',
  itemId: 'item-1',
  source: 'tool',
  revision: 3,
  policySource: 'hub',
  ...over,
});

describe.each<Backend>(['sqlite', 'postgres'])('hub airlock recent denials (%s)', (backend) => {
  let db: HubDb;
  let cookieAdmin: string;
  let cookieViewer: string;
  let cookieOrgB: string;
  let keyAlice: string;
  let keyBob: string;
  let keyB: string;

  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const post = (key: string, events: unknown[]) => supertest(__server).post('/v1/events').set(bearer(key)).send({ events });
  /** One decision from an installation, at the given time (the payload's ts). */
  const send = (key: string, inst: string, over: Record<string, unknown> = {}, org = 'org-a') => {
    const p = decision(over);
    return post(key, [event(org, inst, 'airlock.decision', p, String(p.ts))]);
  };
  const list = (query: Record<string, string | number> = {}, cookie = cookieAdmin) =>
    supertest(__server).get('/v1/admin/airlock/decisions').query(query).set('Cookie', cookie);
  const targets = (body: any) => (body.decisions as any[]).map(d => d.target);

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
    keyBob = await issueApiKey(db, 'org-a', 'bob-laptop', { installationId: 'inst-bob' });
    keyB = await issueApiKey(db, 'org-b', 'other-org', { installationId: 'inst-other' });
  });

  afterEach(async () => {
    await drainApp(__server);
    await db.close();
  });

  describe('ingest', () => {
    it('accepts and keeps every Airlock event type with the other hub events', async () => {
      const types = ['airlock.decision', 'airlock.alert', 'airlock.policy-changed', 'airlock.local-write-refused', 'airlock.approval'];
      const r = await post(keyAlice, types.map((t, i) => event('org-a', 'inst-alice', t, t === 'airlock.decision' ? decision() : { n: i }, `2026-01-27T10:0${i}:00.000Z`)));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ ingested: types.length, rejected: 0 });
      const kept = await db.all<{ type: string }>("SELECT type FROM events WHERE org_id = 'org-a' ORDER BY type");
      expect(kept.map(k => k.type)).toEqual([...types].sort());
    });

    it('a denial is listed with what the installation reported, and where it came from', async () => {
      await send(keyAlice, 'inst-alice');
      const r = await list();
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.decisions).toHaveLength(1);
      expect(r.body.decisions[0]).toMatchObject({
        at: '2026-01-27T10:00:00.000Z',
        installationId: 'inst-alice',
        userKey: 'inst-alice@x',
        client: 'pi',
        model: 'cloudflare-workers-ai/qwen',
        tool: 'bash',
        capabilityKind: 'url',
        target: 'https://evil.example/upload',
        decision: 'deny',
        rule: 'uploadToUnlistedHost',
        mode: 'enforce',
        source: 'tool',
        alert: null,
        itemId: 'item-1',
        revision: 3,
        policySource: 'hub',
      });
      expect(typeof r.body.decisions[0].revision).toBe('number');
      expect(typeof r.body.decisions[0].eventId).toBe('string');
      expect(r.body.next).toBeNull();
    });

    it('a decision that needs human approval is listed; an allow is not', async () => {
      await send(keyAlice, 'inst-alice', { decision: 'needs-human-approval', target: 'aws s3 rm', ts: '2026-01-27T10:00:00.000Z' });
      await send(keyAlice, 'inst-alice', { decision: 'allow', target: 'https://github.com', ts: '2026-01-27T10:01:00.000Z' });
      const r = await list();
      expect(targets(r.body)).toEqual(['aws s3 rm']);
      expect(r.body.decisions[0].decision).toBe('needs-human-approval');
    });

    it('an observe-mode would-be denial is listed, labelled observe', async () => {
      await send(keyAlice, 'inst-alice', { mode: 'observe', decision: 'deny', target: 'https://would.example' });
      const r = await list();
      expect(r.body.decisions).toHaveLength(1);
      expect(r.body.decisions[0]).toMatchObject({ mode: 'observe', decision: 'deny', target: 'https://would.example' });
    });

    it('an allowed call that raised an alert is listed with its category; an unknown category is not an alert', async () => {
      await send(keyAlice, 'inst-alice', { decision: 'allow', alert: 'cloud-storage', target: 's3.amazonaws.com', ts: '2026-01-27T10:00:00.000Z' });
      await send(keyAlice, 'inst-alice', { decision: 'allow', alert: 'made-up', target: 'odd.example', ts: '2026-01-27T10:01:00.000Z' });
      await send(keyAlice, 'inst-alice', { decision: 'deny', alert: 'made-up', target: 'denied.example', ts: '2026-01-27T10:02:00.000Z' });
      const r = await list();
      expect(targets(r.body)).toEqual(['denied.example', 's3.amazonaws.com']);
      expect(r.body.decisions[0].alert).toBeNull();
      expect(r.body.decisions[1].alert).toBe('cloud-storage');
    });

    it('a decision with no source reads as a tool call; a proxy decision keeps its source', async () => {
      const { source: _s, ...noSource } = decision({ target: 'no-source', ts: '2026-01-27T10:00:00.000Z' });
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.decision', noSource, '2026-01-27T10:00:00.000Z')]);
      await send(keyAlice, 'inst-alice', { source: 'proxy', tool: 'proxy', capabilityKind: 'host', target: 'evil.example:443', ts: '2026-01-27T10:01:00.000Z' });
      const r = await list();
      expect(r.body.decisions.map((d: any) => [d.target, d.source])).toEqual([['evil.example:443', 'proxy'], ['no-source', 'tool']]);
    });

    it('the same event delivered twice is listed once', async () => {
      const e = event('org-a', 'inst-alice', 'airlock.decision', decision(), '2026-01-27T10:00:00.000Z', 'ev-dup');
      await post(keyAlice, [e]);
      await post(keyAlice, [e]);
      expect((await list()).body.decisions).toHaveLength(1);
    });

    it('a decision with no readable decision, or dated in the future, is kept as an event but not listed', async () => {
      await send(keyAlice, 'inst-alice', { decision: 42, target: 'bad-decision' });
      // Listed newest first, one dated ahead would sit at the top for good.
      const future = decision({ ts: '2099-01-01T00:00:00.000Z', target: 'from-the-future' });
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.decision', future, '2026-01-27T10:00:00.000Z')]);
      expect((await list()).body.decisions).toEqual([]);
      const kept = await db.all<{ n: number | string }>("SELECT COUNT(*) AS n FROM events WHERE org_id = 'org-a' AND type = 'airlock.decision'");
      expect(Number(kept[0].n)).toBe(2);
    });

    it('a decision whose own time cannot be read is listed at the time the event was sent', async () => {
      const p = decision({ ts: 'not a time', target: 'event-time' });
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.decision', p, '2026-01-27T09:30:00+01:00')]);
      expect((await list()).body.decisions[0]).toMatchObject({ target: 'event-time', at: '2026-01-27T08:30:00.000Z' });
    });

    it('a batch mixing malformed decisions with ordinary events stores every event; a revision past the column range is dropped and a NUL stripped', async () => {
      const r = await post(keyAlice, [
        event('org-a', 'inst-alice', 'item.created', {}, '2026-01-27T09:00:00.000Z'),
        event('org-a', 'inst-alice', 'airlock.decision', decision({ revision: 2147483648, target: 'huge-revision' }), '2026-01-27T10:00:00.000Z'),
        event('org-a', 'inst-alice', 'airlock.decision', decision({ target: 'nul\u0000target', rule: 'r\u0000', ts: '2026-01-27T10:01:00.000Z' }), '2026-01-27T10:01:00.000Z'),
        event('org-a', 'inst-alice', 'item.updated', {}, '2026-01-27T11:00:00.000Z'),
      ]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ ingested: 4, rejected: 0 });
      const kept = await db.all<{ n: number | string }>("SELECT COUNT(*) AS n FROM events WHERE org_id = 'org-a'");
      expect(Number(kept[0].n)).toBe(4);
      const listed = (await list()).body.decisions;
      expect(listed.map((d: any) => [d.target, d.rule, d.revision])).toEqual([
        ['nultarget', 'r', 3],
        ['huge-revision', 'uploadToUnlistedHost', null],
      ]);
    });

    it('a denial that cannot be written never costs the batch its events', async () => {
      // Whatever makes the denial's own row fail, the events around it are kept.
      await db.exec('DROP TABLE airlock_decisions');
      const r = await post(keyAlice, [
        event('org-a', 'inst-alice', 'item.created', {}, '2026-01-27T09:00:00.000Z'),
        event('org-a', 'inst-alice', 'airlock.decision', decision(), '2026-01-27T10:00:00.000Z'),
        event('org-a', 'inst-alice', 'item.updated', {}, '2026-01-27T11:00:00.000Z'),
      ]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ ingested: 3, rejected: 0 });
      const kept = await db.all<{ n: number | string }>("SELECT COUNT(*) AS n FROM events WHERE org_id = 'org-a'");
      expect(Number(kept[0].n)).toBe(3);
    });

    it("a field longer than the hub keeps is cut short", async () => {
      await send(keyAlice, 'inst-alice', { target: 'x'.repeat(5000), rule: 'r'.repeat(5000) });
      const d = (await list()).body.decisions[0];
      expect(d.target.length).toBeLessThan(5000);
      expect(d.target.length).toBeGreaterThan(0);
      expect(d.rule.length).toBeLessThan(5000);
    });
  });

  describe('reading', () => {
    it('newest first, by the decision time', async () => {
      await send(keyAlice, 'inst-alice', { target: 'second', ts: '2026-01-27T10:01:00.000Z' });
      await send(keyAlice, 'inst-alice', { target: 'third', ts: '2026-01-27T10:02:00.000Z' });
      await send(keyAlice, 'inst-alice', { target: 'first', ts: '2026-01-27T10:00:00.000Z' });
      expect(targets((await list()).body)).toEqual(['third', 'second', 'first']);
    });

    it('a page at a time: the cursor resumes after the last row, even among rows at the same instant', async () => {
      const batch = Array.from({ length: 5 }, (_, i) => {
        const p = decision({ target: `t${i}`, ts: i < 3 ? '2026-01-27T10:00:00.000Z' : `2026-01-27T10:0${i}:00.000Z` });
        return event('org-a', 'inst-alice', 'airlock.decision', p, String(p.ts));
      });
      await post(keyAlice, batch);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r = await list(cursor ? { limit: 2, cursor } : { limit: 2 });
        expect(r.status).toBe(200);
        expect(r.body.decisions.length).toBeLessThanOrEqual(2);
        seen.push(...targets(r.body));
        cursor = r.body.next;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen.slice(0, 2)).toEqual(['t4', 't3']);
      expect([...seen].sort()).toEqual(['t0', 't1', 't2', 't3', 't4']);
    });

    it('pages past a row with the longest event id kept; a longer one is kept as an event but not listed', async () => {
      const longest = 'e'.repeat(MAX_DECISION_EVENT_ID_CHARS);
      await post(keyAlice, [
        event('org-a', 'inst-alice', 'airlock.decision', decision({ target: 'newest', ts: '2026-01-27T10:02:00.000Z' }), '2026-01-27T10:02:00.000Z'),
        event('org-a', 'inst-alice', 'airlock.decision', decision({ target: 'long-id', ts: '2026-01-27T10:01:00.000Z' }), '2026-01-27T10:01:00.000Z', longest),
        event('org-a', 'inst-alice', 'airlock.decision', decision({ target: 'oldest', ts: '2026-01-27T10:00:00.000Z' }), '2026-01-27T10:00:00.000Z'),
        event('org-a', 'inst-alice', 'airlock.decision', decision({ target: 'too-long-id' }), '2026-01-27T10:00:30.000Z', 'x'.repeat(MAX_DECISION_EVENT_ID_CHARS + 1)),
      ]);
      const first = await list({ limit: 2 });
      expect(targets(first.body)).toEqual(['newest', 'long-id']);
      const second = await list({ limit: 2, cursor: first.body.next });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(targets(second.body)).toEqual(['oldest']);
      expect(second.body.next).toBeNull();
    });

    it('a cursor the hub did not give is refused, not read as the first page', async () => {
      for (const cursor of ['not-a-cursor', Buffer.from('[1,2]').toString('base64url'), 'a'.repeat(MAX_DECISION_CURSOR_CHARS + 1)]) {
        const r = await list({ cursor });
        expect(r.status, cursor.slice(0, 20)).toBe(400);
      }
    });

    it('a page is never larger than the hard cap, whatever limit is asked for', async () => {
      const n = AIRLOCK_DECISIONS_PAGE_MAX + 1;
      const batch = Array.from({ length: n }, (_, i) => {
        const p = decision({ target: `t${i}`, ts: new Date(Date.parse('2026-01-27T10:00:00.000Z') + i * 1000).toISOString() });
        return event('org-a', 'inst-alice', 'airlock.decision', p, String(p.ts));
      });
      expect((await post(keyAlice, batch)).body.ingested).toBe(n);
      const r = await list({ limit: 100000 });
      expect(r.body.decisions).toHaveLength(AIRLOCK_DECISIONS_PAGE_MAX);
      expect(r.body.next).toEqual(expect.any(String));
      const rest = await list({ limit: 100000, cursor: r.body.next });
      expect(rest.body.decisions).toHaveLength(1);
      expect(rest.body.next).toBeNull();
    });

    describe('filters', () => {
      beforeEach(async () => {
        await send(keyAlice, 'inst-alice', { target: 'alice-pi-tool', client: 'pi', source: 'tool', mode: 'enforce', ts: '2026-01-27T10:00:00.000Z' });
        await send(keyAlice, 'inst-alice', { target: 'alice-oc-proxy', client: 'opencode', source: 'proxy', mode: 'observe', alert: 'metadata-endpoint', ts: '2026-01-27T10:01:00.000Z' });
        await send(keyBob, 'inst-bob', { target: 'bob-pi-proxy', client: 'pi', source: 'proxy', mode: 'enforce', alert: 'ioc-host', ts: '2026-01-27T10:02:00.000Z' });
        await send(keyBob, 'inst-bob', { target: 'bob-oc-tool', client: 'opencode', source: 'tool', mode: 'observe', ts: '2026-01-27T10:03:00.000Z' });
      });

      it('by client', async () => {
        expect(targets((await list({ client: 'pi' })).body)).toEqual(['bob-pi-proxy', 'alice-pi-tool']);
      });

      it('by installation', async () => {
        expect(targets((await list({ installation: 'inst-bob' })).body)).toEqual(['bob-oc-tool', 'bob-pi-proxy']);
      });

      it('by source', async () => {
        expect(targets((await list({ source: 'proxy' })).body)).toEqual(['bob-pi-proxy', 'alice-oc-proxy']);
      });

      it('by alert category, or any alert', async () => {
        expect(targets((await list({ alert: 'ioc-host' })).body)).toEqual(['bob-pi-proxy']);
        expect(targets((await list({ alert: 'any' })).body)).toEqual(['bob-pi-proxy', 'alice-oc-proxy']);
      });

      it('by mode', async () => {
        expect(targets((await list({ mode: 'observe' })).body)).toEqual(['bob-oc-tool', 'alice-oc-proxy']);
      });

      it('together, and the cursor keeps them', async () => {
        expect(targets((await list({ client: 'pi', source: 'proxy' })).body)).toEqual(['bob-pi-proxy']);
        const first = await list({ installation: 'inst-alice', limit: 1 });
        expect(targets(first.body)).toEqual(['alice-oc-proxy']);
        const second = await list({ installation: 'inst-alice', limit: 1, cursor: first.body.next });
        expect(targets(second.body)).toEqual(['alice-pi-tool']);
        expect(second.body.next).toBeNull();
      });

      it('a value outside the known ones is refused', async () => {
        for (const q of [{ source: 'shell' }, { alert: 'nope' }, { mode: 'loud' }]) {
          const r = await list(q);
          expect(r.status, JSON.stringify(q)).toBe(400);
        }
      });
    });
  });

  describe('org isolation', () => {
    it("org B's admin sees none of org A's denials, and org A none of org B's", async () => {
      await send(keyAlice, 'inst-alice', { target: 'org-a-denial' });
      await send(keyB, 'inst-other', { target: 'org-b-denial' }, 'org-b');
      expect(targets((await list({}, cookieOrgB)).body)).toEqual(['org-b-denial']);
      expect(targets((await list()).body)).toEqual(['org-a-denial']);
      expect(targets((await list({ installation: 'inst-other' })).body)).toEqual([]);
    });

    it("org B's key cannot file a denial in org A", async () => {
      const r = await send(keyB, 'inst-other', { target: 'forged' });
      expect(r.body.rejected).toBe(1);
      expect((await list()).body.decisions).toEqual([]);
    });

    it('an org rename carries the denials along', () => {
      expect(ORG_ID_CHILD_TABLES).toContain('airlock_decisions');
    });
  });

  describe('who may read', () => {
    it('an api key is refused', async () => {
      expect((await supertest(__server).get('/v1/admin/airlock/decisions').set(bearer(keyAlice))).status).toBe(401);
    });

    it('a viewer is refused', async () => {
      expect((await list({}, cookieViewer)).status).toBe(403);
    });

    it('no credential is refused', async () => {
      expect((await supertest(__server).get('/v1/admin/airlock/decisions')).status).toBe(401);
    });
  });
});
