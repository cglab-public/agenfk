import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { sanitizeRemoteUrl } from '../util/remoteUrl';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

/**
 * Repository settings (RFC-002): the hub holds ONE authoritative verify command
 * per (org, canonical repository), its revision history, the CI receipts mode
 * and the producer allowlist.
 *
 * Repository identity is the canonical URL from `sanitizeRemoteUrl()` — the same
 * value `events.remote_url` carries — so `git@github.com:acme/app.git` and
 * `https://github.com/acme/app` are one repo to the hub, whatever spelling a
 * caller sends.
 *
 * The command is claimed first-writer-wins: `init` never overwrites an existing
 * record, so two installations racing on first contact cannot silently disagree
 * about how the repo is verified. Changing it afterwards is an admin act, lands
 * as a new revision, and is audited.
 *
 * Run against SQLite and pg-mem: the atomic first-writer-wins insert is exactly
 * the kind of statement that differs between dialects.
 */

const SECRET = 'a'.repeat(64);
const ADMIN_EMAIL = 'admin@x';
const PASSWORD = 'longenough1';

/**
 * A command naming a file on one person's machine.
 *
 * The hub holds ONE command per repository and hands it to every clone, so a
 * path that resolves on Ana's laptop is a command that runs there and nowhere
 * else. The hub cannot know anyone's checkout root, so it refuses the shape:
 * any absolute or home path, with its own code.
 *
 * Written with `/` separators and quoted: the hub is one server, and on Windows
 * a bare `C:\Users\ana\app\run.sh` in a test string loses its backslashes to the
 * shell before it ever reaches a path function.
 */
const PATH_ON_A_LAPTOP = '/Users/ana/app/run.sh';
const CMD_ON_A_LAPTOP = `bash "${PATH_ON_A_LAPTOP}"`;

const REPO_HTTPS = 'https://github.com/acme/app.git';
const REPO_SSH = 'git@github.com:acme/app.git';
const REPO_BARE = 'https://github.com/acme/app';
const REPO_OTHER = 'https://github.com/acme/widget.git';
const CMD_A = 'npm test';
const CMD_B = 'pnpm verify';
const CMD_ADMIN = 'make check';

/** Every spelling of acme/app in the spec's list. */
const REPO_SPELLINGS = [REPO_HTTPS, REPO_SSH, REPO_BARE];

/**
 * The canonical form the hub stores — what `sanitizeRemoteUrl()` (the value
 * `events.remote_url` carries) makes of every spelling below. The
 * canonicalisation test asserts that from the function itself, so the constant
 * and the helper cannot drift apart.
 */
const CANON = 'git@github.com:acme/app.git';

let __server: any;

type Backend = 'sqlite' | 'postgres';

describe.each<Backend>(['sqlite', 'postgres'])('hub repository settings (%s)', (backend) => {
  let db: HubDb;
  let cookieAdmin: string;
  let cookieView: string;
  let keyA: string;
  let keyA2: string;
  let keyB: string;
  let keyShared: string;

  const urlOf = (raw: string) => new URLSearchParams({ repo: raw }).toString();
  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });

  beforeEach(async () => {
    db = backend === 'sqlite' ? await openSqliteDb(':memory:') : await openPgMemDb();
    const out = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a', db,
    } as any);
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = out.app.listen(0);
    await createPasswordUser(db, 'org-a', ADMIN_EMAIL, PASSWORD, 'admin');
    await createPasswordUser(db, 'org-a', 'view@x', PASSWORD, 'viewer');
    cookieAdmin = await loginAs(__server, ADMIN_EMAIL, PASSWORD);
    cookieView = await loginAs(__server, 'view@x', PASSWORD);
    // Installation-bound keys, as `hub login` and invites issue them.
    keyA = await issueApiKey(db, 'org-a', 'alice-laptop', { installationId: 'inst-alice' });
    keyA2 = await issueApiKey(db, 'org-a', 'bob-laptop', { installationId: 'inst-bob' });
    keyB = await issueApiKey(db, 'org-b', 'other-org', { installationId: 'inst-other' });
    // An admin-minted key bound to no installation: shareable, e.g. a CI key.
    keyShared = await issueApiKey(db, 'org-a', 'ci');
    for (const [id, org] of [['inst-alice', 'org-a'], ['inst-bob', 'org-a'], ['inst-other', 'org-b']] as const) {
      await db.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
         VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'dev', 'Dev', 'dev@acme.test')`,
        [id, org],
      );
    }
  });

  afterEach(async () => {
    await drainApp(__server);
    await db.close();
    vi.unstubAllGlobals();
  });

  // ── helpers that talk to the routes under test ───────────────────────────
  //
  // The three routes are reached through a helper each, so one route's shape is
  // spelled out in one place. The storage layer is deliberately NOT asserted
  // from here: the spec fixes its columns, and a spec that re-typed them would
  // only fail twice whenever the implementation lands.
  const init = (key: string, repo: unknown, verifyCommand: unknown) =>
    supertest(__server).post('/v1/repo-settings/init').set(bearer(key)).send({ repo, verifyCommand } as any);
  const read = (key: string, repo: unknown, etag?: string) => {
    const r = supertest(__server).get(`/v1/repo-settings?${urlOf(String(repo))}`).set(bearer(key));
    return etag ? r.set('If-None-Match', etag) : r;
  };
  const adminGet = (path: string, query = '') =>
    supertest(__server).get(`/v1/admin/repos${path}${query}`).set('Cookie', cookieAdmin);
  const adminPut = (path: string, body: Record<string, unknown>, cookie = cookieAdmin) =>
    supertest(__server).put(`/v1/admin/repos/${path}`).set('Cookie', cookie).send(body as any);
  const audit = (area?: string) =>
    supertest(__server).get(`/v1/admin/audit${area ? `?area=${encodeURIComponent(area)}` : ''}`).set('Cookie', cookieAdmin);

  /** Audit rows, newest first. They are written as the response finishes, so wait for `want`. */
  async function auditRows(area: string, marker: string, want: string[]): Promise<any[]> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const r = await audit(area);
      const rows: any[] = r.body.rows ?? [];
      const mine = rows.filter(x => JSON.stringify([x.before, x.after, x.target]).includes(marker));
      if (want.every(a => mine.some(x => x.action === a)) || Date.now() > deadline) return mine;
      await new Promise(res => setTimeout(res, 20));
    }
  }

  /** Actions already recorded under an area, for any repo. */
  async function auditActions(): Promise<string[]> {
    return (await auditRows('repositories', '', [])).map((x: any) => x.action);
  }

  /** The repo under test, spelled the way the hub canonicalises it. */
  async function seedRepo(command = CMD_A, key = keyA): Promise<string> {
    const r = await init(key, REPO_HTTPS, command);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.created).toBe(true);
    expect(r.body.settings.remoteUrl).toBe(CANON);
    return CANON;
  }

  // ── init: first writer wins ──────────────────────────────────────────────
  describe('POST /v1/repo-settings/init', () => {
    it('a first init creates the record at revision 1 with receipts off', async () => {
      const r = await init(keyA, REPO_HTTPS, CMD_A);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.created).toBe(true);
      expect(r.body.settings).toMatchObject({
        remoteUrl: CANON,
        verifyCommand: CMD_A,
        revision: 1,
        receiptsMode: 'off',
        producers: [],
      });
      expect(r.body.settings.shadowThreshold).toBeNull();
      expect(r.body.settings.createdAt).toBeTruthy();
      expect(r.body.settings.updatedAt).toBeTruthy();
    });

    it('canonicalises every spelling of the remote onto one record', async () => {
      await seedRepo();
      for (const spelling of REPO_SPELLINGS) {
        expect(sanitizeRemoteUrl(spelling)).toBe(CANON);
        const r = await init(keyA2, spelling, CMD_B);
        expect(r.status, `${spelling} -> ${JSON.stringify(r.body)}`).toBe(200);
        expect(r.body.created).toBe(false);
        expect(r.body.settings.remoteUrl).toBe(CANON);
        // Never overwrites: the winner's command stands.
        expect(r.body.settings.verifyCommand).toBe(CMD_A);
      }
      const rows = await db.all<any[]>('SELECT * FROM repo_settings', []);
      expect(rows).toHaveLength(1);
    });

    it('resolves a race between two installations to exactly one winner', async () => {
      const results = await Promise.all([init(keyA, REPO_HTTPS, CMD_A), init(keyA2, REPO_SSH, CMD_B)]);
      expect(results.map(r => r.body.created).sort()).toEqual([false, true]);
      for (const r of results) {
        expect(r.status, JSON.stringify(r.body)).toBe(r.body.created ? 201 : 200);
      }
      // Both callers walk away with the SAME command and revision 1.
      expect(results[0].body.settings.verifyCommand).toBe(results[1].body.settings.verifyCommand);
      expect(results[0].body.settings.revision).toBe(1);
      expect(results[1].body.settings.revision).toBe(1);
      expect(results[0].body.settings.remoteUrl).toBe(CANON);

      // One row for the repo, and one command revision: the loser wrote nothing.
      expect(await db.all<any[]>('SELECT * FROM repo_settings', [])).toHaveLength(1);
      expect(await db.all<any[]>('SELECT * FROM repo_command_revisions', [])).toHaveLength(1);
    });

    it('never overwrites an admin revision', async () => {
      await seedRepo();
      const revised = await adminPut('command', { repo: REPO_SSH, verifyCommand: CMD_ADMIN });
      expect(revised.status, JSON.stringify(revised.body)).toBe(200);
      expect(revised.body).toMatchObject({ verifyCommand: CMD_ADMIN, revision: 2 });

      const r = await init(keyA2, REPO_BARE, 'cargo test');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.created).toBe(false);
      expect(r.body.settings.verifyCommand).toBe(CMD_ADMIN);
      expect(r.body.settings.revision).toBe(2);
    });

    it('refuses a key bound to no installation', async () => {
      const r = await init(keyShared, REPO_HTTPS, CMD_A);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe('installation_key_required');
      expect(r.body.error).toBeTruthy();
      const rows = await db.all<any[]>('SELECT * FROM repo_settings', []);
      expect(rows).toHaveLength(0);
    });

    it('rejects a missing or unusable verify command with 400 invalid_command', async () => {
      for (const bad of ['', '   ', 42, null]) {
        const r = await init(keyA, REPO_HTTPS, bad);
        expect(r.status, `${JSON.stringify(bad)} -> ${JSON.stringify(r.body)}`).toBe(400);
        expect(r.body.code).toBe('invalid_command');
      }
      const tooLong = await init(keyA, REPO_HTTPS, 'x'.repeat(5000));
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.code).toBe('invalid_command');
      const rows = await db.all<any[]>('SELECT * FROM repo_settings', []);
      expect(rows).toHaveLength(0);
    });

    it('refuses a command naming a path on one machine with 400 machine_specific_path, and writes nothing', async () => {
      const r = await init(keyA, REPO_HTTPS, CMD_ON_A_LAPTOP);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe('machine_specific_path');
      // The message names the path, so the person can find it in their own command.
      expect(String(r.body.error)).toContain(PATH_ON_A_LAPTOP);
      // Nothing half-claimed the repository: no record, and no revision either.
      expect(await db.all<any[]>('SELECT * FROM repo_settings', [])).toHaveLength(0);
      expect(await db.all<any[]>('SELECT * FROM repo_command_revisions', [])).toHaveLength(0);
    });

    it('rejects a missing or unusable repo with 400 invalid_repo', async () => {
      for (const bad of ['', '   ', null, 7]) {
        const r = await init(keyA, bad, CMD_A);
        expect(r.status, `${JSON.stringify(bad)} -> ${JSON.stringify(r.body)}`).toBe(400);
        expect(r.body.code).toBe('invalid_repo');
      }
      const rows = await db.all<any[]>('SELECT * FROM repo_settings', []);
      expect(rows).toHaveLength(0);
    });
  });

  // ── the installation-side read ───────────────────────────────────────────
  describe('GET /v1/repo-settings', () => {
    it('answers null for a repo nobody has initialised', async () => {
      const r = await read(keyA, REPO_OTHER);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ settings: null });
    });

    it('answers the view for a known repo', async () => {
      await seedRepo();
      const r = await read(keyA, REPO_BARE);
      expect(r.status).toBe(200);
      expect(r.body.settings).toMatchObject({
        remoteUrl: CANON, verifyCommand: CMD_A, revision: 1, receiptsMode: 'off', producers: [],
      });
      expect(r.body.settings.shadowThreshold).toBeNull();
    });

    it('sends an ETag and answers 304 when it is repeated', async () => {
      await seedRepo();
      const first = await read(keyA, REPO_HTTPS);
      const etag = first.headers.etag;
      expect(etag, 'a known repo answers an ETag').toBeTruthy();
      const again = await read(keyA, REPO_HTTPS, etag);
      expect(again.status).toBe(304);
      expect(again.text ?? '').toBe('');
    });

    it('changes the ETag when an admin revises the command', async () => {
      await seedRepo();
      const before = (await read(keyA, REPO_HTTPS)).headers.etag;
      expect((await adminPut('command', { repo: REPO_HTTPS, verifyCommand: CMD_ADMIN })).status).toBe(200);
      const after = (await read(keyA, REPO_HTTPS)).headers.etag;
      expect(after).toBeTruthy();
      expect(after).not.toBe(before);
      expect((await read(keyA, REPO_HTTPS, before)).status).toBe(200);
    });

    it('changes the ETag when an admin changes the receipts mode', async () => {
      await seedRepo();
      const before = (await read(keyA, REPO_HTTPS)).headers.etag;
      expect((await adminPut('mode', { repo: REPO_HTTPS, mode: 'shadow', shadowThreshold: 12 })).status).toBe(200);
      expect((await read(keyA, REPO_HTTPS)).headers.etag).not.toBe(before);
    });

    it('changes the ETag when the producer list changes without changing its size', async () => {
      await seedRepo();
      expect((await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-alice', allowed: true })).status).toBe(200);
      const before = (await read(keyA, REPO_HTTPS)).headers.etag;
      // One producer out, another in: the COUNT is 1 before and after, so a tag
      // over the count alone would let an installation serve the old allowlist.
      expect((await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-alice', allowed: false })).status).toBe(200);
      expect((await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-bob', allowed: true })).status).toBe(200);

      const after = (await read(keyA, REPO_HTTPS)).headers.etag;
      expect(after).toBeTruthy();
      expect(after).not.toBe(before);
      expect((await read(keyA, REPO_HTTPS, before)).status).toBe(200);
    });

    it('needs an api key', async () => {
      const r = await supertest(__server).get(`/v1/repo-settings?${urlOf(REPO_HTTPS)}`);
      expect(r.status).toBe(401);
    });
  });

  // ── tenancy ──────────────────────────────────────────────────────────────
  describe('tenancy', () => {
    it("org-b's key cannot see org-a's settings", async () => {
      await seedRepo();
      const r = await read(keyB, REPO_SSH);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ settings: null });
    });

    it("an org-b init of the same URL creates org-b's own record", async () => {
      await seedRepo();
      const r = await init(keyB, REPO_HTTPS, 'bundle exec rake test');
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.created).toBe(true);
      expect(r.body.settings.verifyCommand).toBe('bundle exec rake test');
      // org-a is untouched.
      const mine = await read(keyA, REPO_HTTPS);
      expect(mine.body.settings).toMatchObject({ verifyCommand: CMD_A, revision: 1 });
      const count = await db.all<any[]>('SELECT * FROM repo_settings', []);
      expect(count).toHaveLength(2);
    });

    it("org-b's admin cannot revise org-a's record", async () => {
      await seedRepo();
      const asB = await (async () => {
        await createPasswordUser(db, 'org-b', 'admin-b@x', PASSWORD, 'admin');
        return loginAs(__server, 'admin-b@x', PASSWORD);
      })();
      const r = await adminPut('command', { repo: REPO_HTTPS, verifyCommand: 'rm -rf' }, asB);
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expect(r.body.code).toBe('not_found');
      const mine = await read(keyA, REPO_HTTPS);
      expect(mine.body.settings.verifyCommand).toBe(CMD_A);
    });
  });

  // ── admin: command revisions ─────────────────────────────────────────────
  describe('admin command revisions', () => {
    it('PUT command bumps the revision, and the same command again does not', async () => {
      await seedRepo();
      const first = await adminPut('command', { repo: REPO_SSH, verifyCommand: CMD_ADMIN });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ verifyCommand: CMD_ADMIN, revision: 2, receiptsMode: 'off' });

      const again = await adminPut('command', { repo: REPO_SSH, verifyCommand: CMD_ADMIN });
      expect(again.status).toBe(200);
      expect(again.body.revision).toBe(2);

      const third = await adminPut('command', { repo: REPO_SSH, verifyCommand: 'just verify' });
      expect(third.body.revision).toBe(3);
    });

    it('two admins revising at the same moment both land, on consecutive revisions', async () => {
      await seedRepo();
      const results = await Promise.all([
        adminPut('command', { repo: REPO_HTTPS, verifyCommand: 'make check' }),
        adminPut('command', { repo: REPO_HTTPS, verifyCommand: 'just verify' }),
      ]);
      for (const r of results) {
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.revision, JSON.stringify(r.body)).toBeTruthy();
      }
      // Neither caller collides on the primary key: the two revisions are 2 and 3.
      expect(results.map(r => r.body.revision).sort((a: number, b: number) => a - b)).toEqual([2, 3]);
      // And each caller is told the revision ITS command landed on: the history
      // row for that revision says the same thing the response says, so the two
      // admins' writes did not end up in each other's revision numbers.
      for (const r of results) {
        const stored = await db.all<any[]>(
          'SELECT verify_command FROM repo_command_revisions WHERE org_id = ? AND remote_url = ? AND revision = ?',
          ['org-a', CANON, r.body.revision],
        );
        expect(stored, JSON.stringify(r.body)).toHaveLength(1);
        expect(String(stored[0].verify_command), JSON.stringify(r.body)).toBe(r.body.verifyCommand);
      }

      const revs = (await adminGet('/revisions', `?${urlOf(REPO_HTTPS)}`)).body.revisions;
      expect(revs.map((x: any) => x.revision)).toEqual([3, 2, 1]);
    });

    it('GET revisions lists admin then init, newest first, with who and where from', async () => {
      await seedRepo();
      expect((await adminPut('command', { repo: REPO_HTTPS, verifyCommand: CMD_ADMIN })).status).toBe(200);
      const r = await adminGet('/revisions', `?${urlOf(REPO_SSH)}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(Array.isArray(r.body.revisions), JSON.stringify(r.body)).toBe(true);
      const revs = r.body.revisions;
      expect(revs.map((x: any) => x.revision)).toEqual([2, 1]);
      expect(revs[0], JSON.stringify(revs)).toMatchObject({ revision: 2, verifyCommand: CMD_ADMIN, source: 'admin', actorEmail: ADMIN_EMAIL });
      expect(revs[0].createdAt).toBeTruthy();
      expect(revs[1]).toMatchObject({ revision: 1, verifyCommand: CMD_A, source: 'init', installationId: 'inst-alice' });
    });

    it('GET /v1/admin/repos lists the org repos as views', async () => {
      await seedRepo();
      await init(keyA2, REPO_OTHER, CMD_B);
      const r = await adminGet('');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.repos.map((x: any) => x.verifyCommand).sort()).toEqual([CMD_A, CMD_B].sort());
      expect(r.body.repos[0]).toMatchObject({ revision: 1, receiptsMode: 'off' });
    });

    it('PUT command on an unknown repo is 404 not_found', async () => {
      const r = await adminPut('command', { repo: REPO_OTHER, verifyCommand: CMD_ADMIN });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('not_found');
    });

    it('PUT command with a bad command is 400 invalid_command', async () => {
      await seedRepo();
      const r = await adminPut('command', { repo: REPO_HTTPS, verifyCommand: '   ' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('invalid_command');
    });

    it('PUT command naming a path on one machine is 400 machine_specific_path, and no revision is written', async () => {
      await seedRepo();
      const before = await db.all<any[]>('SELECT * FROM repo_command_revisions', []);
      expect(before).toHaveLength(1);

      const r = await adminPut('command', { repo: REPO_HTTPS, verifyCommand: CMD_ON_A_LAPTOP });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe('machine_specific_path');
      expect(String(r.body.error)).toContain(PATH_ON_A_LAPTOP);

      // The refused revision wrote no history row, and the record still holds
      // the command it held before — an admin cannot half-land a command.
      expect(await db.all<any[]>('SELECT * FROM repo_command_revisions', [])).toHaveLength(1);
      const stored = await db.all<any>('SELECT verify_command, revision FROM repo_settings', []);
      expect(stored).toHaveLength(1);
      expect(String(stored[0].verify_command)).toBe(CMD_A);
      expect(Number(stored[0].revision)).toBe(1);
    });
  });

  // ── admin: receipts mode ─────────────────────────────────────────────────
  describe('admin receipts mode', () => {
    it('stores shadow with a threshold', async () => {
      await seedRepo();
      const r = await adminPut('mode', { repo: REPO_HTTPS, mode: 'shadow', shadowThreshold: 12 });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ receiptsMode: 'shadow', shadowThreshold: 12, revision: 1 });
      const viaKey = await read(keyA, REPO_HTTPS);
      expect(viaKey.body.settings).toMatchObject({ receiptsMode: 'shadow', shadowThreshold: 12 });
    });

    it('refuses enforce while the repo has no threshold', async () => {
      await seedRepo();
      const r = await adminPut('mode', { repo: REPO_HTTPS, mode: 'enforce' });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe('threshold_required');
      const viaKey = await read(keyA, REPO_HTTPS);
      expect(viaKey.body.settings.receiptsMode).toBe('off');
    });

    it('accepts enforce once a threshold is set', async () => {
      await seedRepo();
      expect((await adminPut('mode', { repo: REPO_HTTPS, mode: 'shadow', shadowThreshold: 12 })).status).toBe(200);
      const r = await adminPut('mode', { repo: REPO_HTTPS, mode: 'enforce' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ receiptsMode: 'enforce', shadowThreshold: 12 });
    });

    it('refuses a mode that is not off, shadow or enforce', async () => {
      await seedRepo();
      for (const mode of ['on', '', 'Shadow', null]) {
        const r = await adminPut('mode', { repo: REPO_HTTPS, mode } as any);
        expect(r.status, `${JSON.stringify(mode)} -> ${JSON.stringify(r.body)}`).toBe(400);
        expect(r.body.code).toBe('invalid_mode');
      }
    });

    it('refuses a threshold that is not a positive whole number', async () => {
      await seedRepo();
      for (const shadowThreshold of [0, 2.5, -1, 'many']) {
        const r = await adminPut('mode', { repo: REPO_HTTPS, mode: 'shadow', shadowThreshold } as any);
        expect(r.status, `${shadowThreshold} -> ${JSON.stringify(r.body)}`).toBe(400);
        expect(r.body.code).toBe('invalid_threshold');
      }
      const viaKey = await read(keyA, REPO_HTTPS);
      expect(viaKey.body.settings).toMatchObject({ receiptsMode: 'off', shadowThreshold: null });
    });

    it('404s for a repo the org does not have', async () => {
      const r = await adminPut('mode', { repo: REPO_OTHER, mode: 'shadow', shadowThreshold: 5 });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('not_found');
    });
  });

  // ── admin: producers ─────────────────────────────────────────────────────
  describe('admin producers', () => {
    it('adds an installation of this org, idempotently, and removes it again', async () => {
      await seedRepo();
      const added = await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-bob', allowed: true });
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect(added.body.producers).toContain('inst-bob');
      expect(added.body.producers).toHaveLength(1);

      const again = await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-bob', allowed: true });
      expect(again.status).toBe(200);
      expect(again.body.producers).toEqual(['inst-bob']);

      const removed = await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-bob', allowed: false });
      expect(removed.status).toBe(200);
      expect(removed.body.producers).not.toContain('inst-bob');
    });

    it('refuses an installation belonging to another org', async () => {
      await seedRepo();
      const r = await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-other', allowed: true });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe('unknown_installation');
      expect((await read(keyA, REPO_HTTPS)).body.settings.producers).toEqual([]);
    });

    it('the producer list shows on the installation side too', async () => {
      await seedRepo();
      expect((await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-alice', allowed: true })).status).toBe(200);
      expect((await read(keyA, REPO_HTTPS)).body.settings.producers).toEqual(['inst-alice']);
    });

    // GH-256: only event ingest wrote the installations row, so a machine that
    // had just joined could not be made a producer until it reported.
    it('a machine that joined by invite can be made a producer before it reports', async () => {
      await seedRepo();
      const inv = await supertest(__server).post('/hub/invite/create').set('Cookie', cookieAdmin).send({});
      const joined = await supertest(__server).post('/hub/invite/redeem')
        .send({ inviteToken: inv.body.inviteToken, installation: { installationId: 'inst-new', gitEmail: 'new@acme.test' } });
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);

      const r = await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-new', allowed: true });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.producers).toContain('inst-new');
    });

    it('a machine that joined by device code can be made a producer before it reports', async () => {
      await seedRepo();
      const start = await supertest(__server).post('/hub/device/start')
        .send({ installation: { installationId: 'inst-device', osUser: 'dev' } });
      const approved = await supertest(__server).post('/hub/device/approve').set('Cookie', cookieAdmin)
        .send({ userCode: start.body.userCode });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      // Approved but never collected: no machine holds the key, so there is no
      // installation yet (it would otherwise become a fleet upgrade target).
      const early = await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-device', allowed: true });
      expect(early.body.code).toBe('unknown_installation');

      const collected = await supertest(__server).post('/hub/device/poll').send({ deviceCode: start.body.deviceCode });
      expect(collected.body.status).toBe('approved');
      const r = await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-device', allowed: true });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.producers).toContain('inst-device');
    });

    it('joining under another org\'s installation id does not adopt it', async () => {
      await seedRepo();
      const inv = await supertest(__server).post('/hub/invite/create').set('Cookie', cookieAdmin).send({});
      await supertest(__server).post('/hub/invite/redeem')
        .send({ inviteToken: inv.body.inviteToken, installation: { installationId: 'inst-other' } });

      const r = await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-other', allowed: true });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe('unknown_installation');
    });
  });

  // ── admin guard ──────────────────────────────────────────────────────────
  describe('admin guard', () => {
    it('a viewer is 403 on every admin route, and nobody is 401', async () => {
      const cases: Array<[string, 'get' | 'put', unknown?]> = [
        ['', 'get'],
        ['/revisions', 'get'],
        ['command', 'put', { repo: REPO_HTTPS, verifyCommand: CMD_ADMIN }],
        ['mode', 'put', { repo: REPO_HTTPS, mode: 'shadow', shadowThreshold: 9 }],
        ['producers', 'put', { repo: REPO_HTTPS, installationId: 'inst-bob', allowed: true }],
      ];
      for (const [path, method, body] of cases) {
        const asViewer = method === 'get'
          ? supertest(__server).get(`/v1/admin/repos${path}`).set('Cookie', cookieView)
          : supertest(__server).put(`/v1/admin/repos/${path}`).set('Cookie', cookieView).send(body as any);
        const r = await asViewer;
        expect(r.status, `viewer ${method.toUpperCase()} /v1/admin/repos${path}`).toBe(403);
        const asAnon = method === 'get'
          ? supertest(__server).get(`/v1/admin/repos${path}`)
          : supertest(__server).put(`/v1/admin/repos/${path}`).send(body as any);
        expect((await asAnon).status, `anon ${method.toUpperCase()} /v1/admin/repos${path}`).toBe(401);
      }
    });
  });

  // ── audit ────────────────────────────────────────────────────────────────
  describe('audit', () => {
    it('records the admin command revision before -> after, under the repositories area', async () => {
      await seedRepo(CMD_A);
      expect((await adminPut('command', { repo: REPO_HTTPS, verifyCommand: CMD_ADMIN })).status).toBe(200);

      const rows = await auditRows('repositories', CMD_ADMIN, ['repo.command-revise']);
      const revise = rows.find(x => x.action === 'repo.command-revise') ?? {};
      expect(revise, JSON.stringify(await auditActions())).toMatchObject({
        area: 'repositories', actorEmail: ADMIN_EMAIL,
      });
      expect(JSON.stringify(revise.before)).toContain(CMD_A);
      expect(JSON.stringify(revise.after)).toContain(CMD_ADMIN);
    });

    it('records the receipts mode change, and the init that first claimed the command', async () => {
      await seedRepo(CMD_A);
      expect((await adminPut('mode', { repo: REPO_HTTPS, mode: 'shadow', shadowThreshold: 12 })).status).toBe(200);

      const actions = await auditActions();
      expect(actions).toContain('repo.mode');
      expect(actions).toContain('repo.command-init');

      const mode = (await auditRows('repositories', CMD_A, ['repo.mode'])).find(x => x.action === 'repo.mode') ?? {};
      expect(mode, JSON.stringify(await auditActions())).toMatchObject({ area: 'repositories', actorEmail: ADMIN_EMAIL });
      expect(JSON.stringify(mode.before)).toContain('off');
      expect(JSON.stringify(mode.after)).toContain('shadow');
    });

    it('records a producer added to the allowlist, by the admin who added it', async () => {
      await seedRepo(CMD_A);
      expect((await adminPut('producers', { repo: REPO_HTTPS, installationId: 'inst-bob', allowed: true })).status).toBe(200);

      const producer = (await auditRows('repositories', 'inst-bob', ['repo.producer'])).find(x => x.action === 'repo.producer') ?? {};
      expect(producer, JSON.stringify(await auditActions())).toMatchObject({ area: 'repositories', actorEmail: ADMIN_EMAIL });
      expect(JSON.stringify(producer.before)).not.toContain('inst-bob');
      expect(JSON.stringify(producer.after)).toContain('inst-bob');
    });

    it('writes no audit row for a refused change', async () => {
      await seedRepo(CMD_A);
      expect((await adminPut('mode', { repo: REPO_HTTPS, mode: 'nope' })).status).toBe(400);
      expect((await adminPut('command', { repo: REPO_HTTPS, verifyCommand: 'x'.repeat(5000) })).status).toBe(400);

      // A row for the refused mode change would have said 'nope' or 'enforce'
      // somewhere; nothing this test did accepted either.
      const rows = await auditRows('repositories', 'nope', []);
      const modes = rows.filter(x => x.action === 'repo.mode');
      expect(modes.map(x => JSON.stringify([x.before, x.after]))).toEqual([]);
    });
  });
});

