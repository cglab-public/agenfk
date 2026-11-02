import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { createHubApp } from '../server';
import { openDb } from '../db';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

/**
 * A repository's producer mode (RFC-002 Amendment 1, GH #289).
 *
 * Each repository says who may produce receipts CI can reuse:
 *
 *  - `listed` — "Only these installations" (the default, and every repository
 *    that existed before this change): the explicit `repo_producers` allowlist.
 *  - `all` — "All installations in the organization": any installation of the
 *    org that is not retired, decided LIVE, so a machine that joins later counts
 *    without an admin touching the repository, and retiring one stops its
 *    receipts counting both when it publishes and when CI asks.
 *
 * The explicit list is kept as it is while `all` is on, and applies again the
 * moment the repository is switched back. The switch is an admin act, audited
 * like every other repository setting, and installations see it in the view
 * they sync.
 *
 * Run against SQLite and pg-mem.
 */

const SECRET = 'a'.repeat(64);
const ADMIN_EMAIL = 'admin@x';
const VIEWER_EMAIL = 'viewer@x';
const PASSWORD = 'longenough1';

const REPO_HTTPS = 'https://github.com/acme/app.git';
const CANON = 'git@github.com:acme/app.git';
const CMD = 'npm test';
const TREE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);

let __server: any;

type Backend = 'sqlite' | 'postgres';

describe.each<Backend>(['sqlite', 'postgres'])('repository producer mode (%s)', (backend) => {
  let db: HubDb;
  let cookieAdmin: string;
  let cookieViewer: string;
  /** inst-alice: on the explicit allowlist. */
  let keyAlice: string;
  /** inst-bob: an installation of the org that is NOT on the allowlist. */
  let keyBob: string;

  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const srv = () => supertest(__server);

  const addInstallation = async (id: string, org = 'org-a') => {
    await db.run('DELETE FROM installations WHERE id = ?', [id]);
    await db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
       VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'dev', 'Dev', ?)`,
      [id, org, `${id}@acme.test`],
    );
  };

  const setMode = (producerMode: unknown, cookie = cookieAdmin, repo: unknown = REPO_HTTPS) =>
    srv().put('/v1/admin/repos/producer-mode').set('Cookie', cookie).send({ repo, producerMode } as any);
  const setProducer = (installationId: string, allowed: boolean) =>
    srv().put('/v1/admin/repos/producers').set('Cookie', cookieAdmin).send({ repo: REPO_HTTPS, installationId, allowed });
  const readSettings = (key: string, etag?: string) => {
    const r = srv().get(`/v1/repo-settings?${new URLSearchParams({ repo: REPO_HTTPS })}`).set(bearer(key));
    return etag ? r.set('If-None-Match', etag) : r;
  };
  const retire = (id: string) => srv().post(`/v1/admin/installations/${id}/retire`).set('Cookie', cookieAdmin);
  const restore = (id: string) => srv().delete(`/v1/admin/installations/${id}/retire`).set('Cookie', cookieAdmin);

  const verification = (over: Record<string, any> = {}): any => ({
    id: randomUUID(),
    kind: 'verification',
    version: 1,
    repo: REPO_HTTPS,
    receiptsMode: 'shadow',
    card: { id: 'card-root', title: 'Root', type: 'STORY', closedAt: '2026-06-01T10:00:00.000Z', owner: null, closedBy: { name: 'Dev', email: 'dev@acme.test' }, link: null },
    execution: { id: 'test-1', command: CMD, commandRevision: 1, exitCode: 0, startedAt: '2026-06-01T09:59:00.000Z', finishedAt: '2026-06-01T10:00:00.000Z', logPath: null },
    content: { commit: COMMIT, gitTree: TREE, treeState: null, treeStateVersion: 1 },
    reusable: true,
    ...over,
  });
  const report = () => {
    const text = 'PASS\n';
    return { report: { encoding: 'gzip+base64', data: zlib.gzipSync(Buffer.from(text)).toString('base64'), bytes: text.length } };
  };
  /** Publish as `key`; the hub's verdict. */
  const publish = async (key: string, rcpt = verification()) => {
    const r = await srv().post('/v1/receipts').set(bearer(key)).send({ receipt: rcpt, ...report() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: rcpt.id as string, reusable: r.body.reusable as boolean, reason: r.body.reason as string | null };
  };
  const mintCiToken = async () => {
    const r = await srv().post('/v1/admin/ci-tokens').set('Cookie', cookieAdmin).send({ repo: REPO_HTTPS });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.token as string;
  };
  /** producerAllowed for one receipt, as each of the three readers answers it. */
  const standing = async (token: string, id: string) => {
    const lookup = await srv().get('/v1/ci/receipts').query({ repo: REPO_HTTPS, kind: 'verification', tree: TREE }).set(bearer(token));
    expect(lookup.status, JSON.stringify(lookup.body)).toBe(200);
    const one = await srv().get(`/v1/ci/receipts/${id}`).set(bearer(token));
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const admin = await srv().get('/v1/admin/repos/receipts').query({ repo: REPO_HTTPS }).set('Cookie', cookieAdmin);
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    return {
      lookup: lookup.body.receipts.find((r: any) => r.id === id)?.producerAllowed,
      one: one.body.producerAllowed,
      admin: admin.body.receipts.find((r: any) => r.id === id)?.producerAllowed,
    };
  };

  async function auditRows(action: string): Promise<any[]> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const r = await srv().get('/v1/admin/audit?area=repositories').set('Cookie', cookieAdmin);
      const rows: any[] = (r.body.rows ?? []).filter((x: any) => x.action === action);
      if (rows.length || Date.now() > deadline) return rows;
      await new Promise(res => setTimeout(res, 20));
    }
  }

  beforeEach(async () => {
    db = backend === 'sqlite' ? await openSqliteDb(':memory:') : await openPgMemDb();
    const out = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a', db,
    } as any);
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = out.app.listen(0);
    // Start every test from empty tables, whatever the backend kept.
    for (const t of ['receipts', 'repo_producers', 'repo_command_revisions', 'repo_settings', 'ci_tokens', 'config_audit']) {
      await db.run(`DELETE FROM ${t}`, []);
    }
    await createPasswordUser(db, 'org-a', ADMIN_EMAIL, PASSWORD, 'admin').catch(() => undefined);
    await createPasswordUser(db, 'org-a', VIEWER_EMAIL, PASSWORD, 'viewer').catch(() => undefined);
    cookieAdmin = await loginAs(__server, ADMIN_EMAIL, PASSWORD);
    cookieViewer = await loginAs(__server, VIEWER_EMAIL, PASSWORD);
    await addInstallation('inst-alice');
    await addInstallation('inst-bob');
    keyAlice = await issueApiKey(db, 'org-a', 'alice-laptop', { installationId: 'inst-alice' });
    keyBob = await issueApiKey(db, 'org-a', 'bob-laptop', { installationId: 'inst-bob' });

    const init = await srv().post('/v1/repo-settings/init').set(bearer(keyAlice)).send({ repo: REPO_HTTPS, verifyCommand: CMD });
    expect(init.status, JSON.stringify(init.body)).toBe(201);
    expect((await setProducer('inst-alice', true)).status).toBe(200);
  });

  afterEach(async () => {
    await drainApp(__server);
    await db.close();
  });

  // ── the setting ──────────────────────────────────────────────────────────
  describe('the setting', () => {
    it('a repository starts on "only these installations", in both views', async () => {
      const r = await readSettings(keyAlice);
      expect(r.body.settings).toMatchObject({ producerMode: 'listed', producers: ['inst-alice'] });
      const list = await srv().get('/v1/admin/repos').set('Cookie', cookieAdmin);
      expect(list.body.repos.find((x: any) => x.remoteUrl === CANON)).toMatchObject({ producerMode: 'listed' });
    });

    it('an admin switches it to all and back, and the explicit list is kept untouched throughout', async () => {
      const on = await setMode('all');
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(on.body).toMatchObject({ remoteUrl: CANON, producerMode: 'all', producers: ['inst-alice'] });
      expect((await readSettings(keyAlice)).body.settings).toMatchObject({ producerMode: 'all', producers: ['inst-alice'] });

      // The list stays editable while it is not the one that applies.
      expect((await setProducer('inst-bob', true)).body).toMatchObject({ producerMode: 'all', producers: ['inst-alice', 'inst-bob'] });
      expect((await setProducer('inst-bob', false)).body.producers).toEqual(['inst-alice']);

      const off = await setMode('listed');
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(off.body).toMatchObject({ producerMode: 'listed', producers: ['inst-alice'] });
    });

    it('refuses a mode that is neither listed nor all, and changes nothing', async () => {
      for (const bad of ['everyone', '', null, 1, undefined]) {
        const r = await setMode(bad);
        expect(r.status, `${String(bad)}: ${JSON.stringify(r.body)}`).toBe(400);
        expect(r.body.code).toBe('invalid_producer_mode');
      }
      expect((await readSettings(keyAlice)).body.settings.producerMode).toBe('listed');
    });

    it('404s for a repository the org has no settings for, and 400s for a missing repository', async () => {
      const unknown = await setMode('all', cookieAdmin, 'https://github.com/acme/nope.git');
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('not_found');
      for (const bad of ['', '   ', null, 7]) {
        const r = await setMode('all', cookieAdmin, bad);
        expect(r.status, JSON.stringify(bad)).toBe(400);
        expect(r.body.code).toBe('invalid_repo');
      }
    });

    it('is for admins only', async () => {
      expect((await setMode('all', cookieViewer)).status).toBe(403);
      expect((await srv().put('/v1/admin/repos/producer-mode').send({ repo: REPO_HTTPS, producerMode: 'all' })).status).toBe(401);
      expect((await readSettings(keyAlice)).body.settings.producerMode).toBe('listed');
    });

    it('moves the ETag installations cache the settings under', async () => {
      const before = (await readSettings(keyAlice)).headers.etag;
      expect(before).toBeTruthy();
      expect((await setMode('all')).status).toBe(200);
      const after = await readSettings(keyAlice, before);
      expect(after.status).toBe(200);
      expect(after.headers.etag).not.toBe(before);
    });

    it('is audited as repo.producer-mode, before -> after, by the admin who switched it', async () => {
      expect((await setMode('all')).status).toBe(200);
      const [row] = await auditRows('repo.producer-mode');
      expect(row, 'no repo.producer-mode audit row').toBeTruthy();
      expect(row).toMatchObject({ area: 'repositories', actorEmail: ADMIN_EMAIL });
      expect(row.before).toMatchObject({ producer_mode: 'listed' });
      expect(row.after).toMatchObject({ producer_mode: 'all' });
    });

    it('a refused switch writes no audit row', async () => {
      expect((await setMode('everyone')).status).toBe(400);
      expect(await auditRows('repo.producer-mode')).toEqual([]);
    });
  });

  // ── at publish time ──────────────────────────────────────────────────────
  describe('when a receipt is published', () => {
    it('under listed, an installation off the list is not an allowed producer (unchanged)', async () => {
      expect(await publish(keyBob)).toMatchObject({ reusable: false, reason: 'producer_not_allowed' });
      expect(await publish(keyAlice)).toMatchObject({ reusable: true, reason: null });
    });

    it('under all, an installation of the org that is not on the list produces a reusable receipt', async () => {
      expect((await setMode('all')).status).toBe(200);
      expect(await publish(keyBob)).toMatchObject({ reusable: true, reason: null });
    });

    it('under all, an installation that joins after the switch counts with no admin action', async () => {
      expect((await setMode('all')).status).toBe(200);
      await addInstallation('inst-carol');
      const keyCarol = await issueApiKey(db, 'org-a', 'carol-laptop', { installationId: 'inst-carol' });
      expect(await publish(keyCarol)).toMatchObject({ reusable: true, reason: null });
    });

    it('under all, a retired installation is not an allowed producer', async () => {
      expect((await setMode('all')).status).toBe(200);
      // Retiring through the board also revokes the machine's keys; this is the
      // case of a key the retirement did not reach. The hub must still say no.
      await db.run('UPDATE installations SET retired_at = ? WHERE id = ?', [new Date().toISOString(), 'inst-bob']);
      expect(await publish(keyBob)).toMatchObject({ reusable: false, reason: 'producer_not_allowed' });
    });

    it('under all, an installation the hub has no row for is not an allowed producer', async () => {
      expect((await setMode('all')).status).toBe(200);
      const keyGhost = await issueApiKey(db, 'org-a', 'ghost', { installationId: 'inst-ghost' });
      await db.run('DELETE FROM installations WHERE id = ?', ['inst-ghost']);
      expect(await publish(keyGhost)).toMatchObject({ reusable: false, reason: 'producer_not_allowed' });
    });

    it('under all, an installation of ANOTHER org with the same repo is never this org\'s producer', async () => {
      expect((await setMode('all')).status).toBe(200);
      // The same installation id registered under org-b only.
      await addInstallation('inst-dave', 'org-b');
      const keyDaveA = await issueApiKey(db, 'org-a', 'dave-in-a', { installationId: 'inst-dave' });
      expect(await publish(keyDaveA)).toMatchObject({ reusable: false, reason: 'producer_not_allowed' });
    });

    it('switched back to listed, the kept list applies again', async () => {
      expect((await setMode('all')).status).toBe(200);
      expect((await setMode('listed')).status).toBe(200);
      expect(await publish(keyBob)).toMatchObject({ reusable: false, reason: 'producer_not_allowed' });
      expect(await publish(keyAlice)).toMatchObject({ reusable: true });
    });
  });

  // ── at CI read time ──────────────────────────────────────────────────────
  describe('when CI asks', () => {
    it('under all, a receipt counts while its installation is live, stops when it is retired, and counts again when restored', async () => {
      expect((await setMode('all')).status).toBe(200);
      const { id } = await publish(keyBob);
      const token = await mintCiToken();
      expect(await standing(token, id)).toEqual({ lookup: true, one: true, admin: true });

      expect((await retire('inst-bob')).status).toBe(200);
      expect(await standing(token, id)).toEqual({ lookup: false, one: false, admin: false });

      expect((await restore('inst-bob')).status).toBe(200);
      expect(await standing(token, id)).toEqual({ lookup: true, one: true, admin: true });
    });

    it('switching to all makes an off-list producer\'s earlier receipt count as allowed now; switching back takes it away', async () => {
      const { id } = await publish(keyBob);
      const token = await mintCiToken();
      expect(await standing(token, id)).toEqual({ lookup: false, one: false, admin: false });
      expect((await setMode('all')).status).toBe(200);
      expect(await standing(token, id)).toEqual({ lookup: true, one: true, admin: true });
      expect((await setMode('listed')).status).toBe(200);
      expect(await standing(token, id)).toEqual({ lookup: false, one: false, admin: false });
    });

    it('under all, a receipt whose installation belongs to another org, or has no row, never counts', async () => {
      expect((await setMode('all')).status).toBe(200);
      await addInstallation('inst-dave', 'org-b');
      const keyDaveA = await issueApiKey(db, 'org-a', 'dave-in-a', { installationId: 'inst-dave' });
      const foreign = await publish(keyDaveA);
      const { id: gone } = await publish(keyBob);
      await db.run('DELETE FROM installations WHERE id = ?', ['inst-bob']);
      const token = await mintCiToken();
      expect(await standing(token, foreign.id)).toEqual({ lookup: false, one: false, admin: false });
      expect(await standing(token, gone)).toEqual({ lookup: false, one: false, admin: false });
    });

    it('under listed, retirement is not consulted: a listed producer\'s receipt still counts (unchanged)', async () => {
      const { id } = await publish(keyAlice);
      const token = await mintCiToken();
      await db.run('UPDATE installations SET retired_at = ? WHERE id = ?', [new Date().toISOString(), 'inst-alice']);
      expect(await standing(token, id)).toEqual({ lookup: true, one: true, admin: true });
    });

    it('under listed, the list alone decides, as before', async () => {
      const { id } = await publish(keyAlice);
      const token = await mintCiToken();
      expect(await standing(token, id)).toEqual({ lookup: true, one: true, admin: true });
      expect((await setProducer('inst-alice', false)).status).toBe(200);
      expect(await standing(token, id)).toEqual({ lookup: false, one: false, admin: false });
    });
  });
});

// ── an existing hub gains the column at boot ───────────────────────────────
describe('producer_mode on a hub created before the column existed (sqlite, through bootstrap)', () => {
  const DB = path.join(os.tmpdir(), `agenfk-hub-producer-mode-${process.pid}.sqlite`);
  const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };
  afterEach(cleanup);

  it('adds producer_mode, existing repositories read "listed", their allowlist is untouched, and the mode can be switched', async () => {
    cleanup();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const seed = new DatabaseSync(DB);
    // repo_settings and repo_producers exactly as RFC-002 first shipped them.
    seed.exec(`CREATE TABLE repo_settings (
      org_id TEXT NOT NULL, remote_url TEXT NOT NULL, verify_command TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      receipts_mode TEXT NOT NULL DEFAULT 'off' CHECK (receipts_mode IN ('off','shadow','enforce')),
      shadow_threshold INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, remote_url)
    );
    CREATE TABLE repo_producers (
      org_id TEXT NOT NULL, remote_url TEXT NOT NULL, installation_id TEXT NOT NULL,
      added_at TEXT NOT NULL, added_by_email TEXT,
      PRIMARY KEY (org_id, remote_url, installation_id)
    );`);
    seed.exec(`INSERT INTO repo_settings (org_id, remote_url, verify_command, revision, receipts_mode, created_at, updated_at)
               VALUES ('org-a', '${CANON}', 'npm test', 3, 'shadow', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`);
    seed.exec(`INSERT INTO repo_producers (org_id, remote_url, installation_id, added_at)
               VALUES ('org-a', '${CANON}', 'inst-alice', '2026-10-01T00:00:00Z')`);
    seed.close();

    const db = await openDb(DB);
    try {
      const row = await db.get<any>('SELECT producer_mode, revision, receipts_mode FROM repo_settings WHERE org_id = ? AND remote_url = ?', ['org-a', CANON]);
      expect(row).toMatchObject({ producer_mode: 'listed', receipts_mode: 'shadow' });
      expect(Number(row.revision)).toBe(3);
      const producers = await db.all<any>('SELECT installation_id FROM repo_producers WHERE org_id = ?', ['org-a']);
      expect(producers.map(p => p.installation_id)).toEqual(['inst-alice']);

      // The upgraded table takes the new value and refuses one it does not know.
      await db.run("UPDATE repo_settings SET producer_mode = 'all' WHERE org_id = 'org-a'", []);
      expect((await db.get<any>('SELECT producer_mode FROM repo_settings', [])).producer_mode).toBe('all');
      await expect(db.run("UPDATE repo_settings SET producer_mode = 'everyone' WHERE org_id = 'org-a'", [])).rejects.toThrow();
    } finally {
      await db.close();
    }

    // A second boot over the upgraded file is a no-op, not a duplicate-column crash.
    const again = await openDb(DB);
    expect((await again.get<any>('SELECT producer_mode FROM repo_settings', [])).producer_mode).toBe('all');
    await again.close();
  });
});

// The Postgres side of the same migration cannot be exercised through
// bootstrap here: it only runs when repo_settings already exists without the
// column, and pg-mem refuses `CREATE TABLE IF NOT EXISTS` (with NOT NULL
// columns) over an existing table, so bootstrapping over a seeded older schema
// fails on the schema block before reaching the migration (measured; the same
// limit display-name.test.ts records). A fresh Postgres bootstrap, which the
// described suite above runs on every test, carries the column from the schema.
describe('producer_mode on a fresh Postgres hub', () => {
  it('defaults new repositories to "listed" and refuses an unknown mode', async () => {
    const db = await openPgMemDb();
    try {
      await db.run(
        `INSERT INTO repo_settings (org_id, remote_url, verify_command, revision, receipts_mode, created_at, updated_at)
         VALUES ('org-pg', ?, 'npm test', 1, 'off', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
        [CANON],
      );
      expect((await db.get<any>("SELECT producer_mode FROM repo_settings WHERE org_id = 'org-pg'", [])).producer_mode).toBe('listed');
      await expect(db.run("UPDATE repo_settings SET producer_mode = 'everyone' WHERE org_id = 'org-pg'", [])).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
