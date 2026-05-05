/**
 * Story 7 — per-installation agenfk version surfaced from event metadata.
 *
 * The local server's flusher attaches `x-agenfk-version: <ver>` to every
 * /v1/events POST. The hub persists the latest seen version onto the
 * installations row, and admin endpoints surface it so the Upgrades panel
 * (Story 4) can show "currently running" alongside each installation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-installation-version-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const sample = (overrides: any = {}) => ({
  eventId: 'e-' + Math.random().toString(36).slice(2),
  installationId: 'inst-1',
  orgId: 'org-a',
  occurredAt: '2026-05-03T10:00:00Z',
  actor: { osUser: 'tester', gitName: null, gitEmail: null },
  type: 'item.created',
  projectId: 'p1',
  itemId: 'i1',
  payload: {},
  ...overrides,
});

describe('Story 7 — per-installation agenfk version', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let fleetToken: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookieAdmin = login.headers['set-cookie']?.[0] ?? '';
    fleetToken = await issueApiKey(ctx.db, 'org-a', 'inst-1-key', { installationId: 'inst-1' } as any);
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('schema migration', () => {
    it('installations table has agenfk_version + agenfk_version_updated_at columns', async () => {
      const cols = await ctx.db.all<{ name: string }>(
        "SELECT name FROM pragma_table_info('installations')",
      );
      const names = cols.map(c => c.name);
      expect(names).toContain('agenfk_version');
      expect(names).toContain('agenfk_version_updated_at');
    });
  });

  describe('hub ingest persists x-agenfk-version header', () => {
    it('records the header on the matching installation row', async () => {
      await supertest(app)
        .post('/v1/events')
        .set('Authorization', `Bearer ${fleetToken}`)
        .set('x-agenfk-version', '0.3.0-beta.22')
        .send({ events: [sample()] });
      const row = await ctx.db.get<{ agenfk_version: string; agenfk_version_updated_at: string }>(
        'SELECT agenfk_version, agenfk_version_updated_at FROM installations WHERE id = ?',
        ['inst-1'],
      );
      expect(row.agenfk_version).toBe('0.3.0-beta.22');
      expect(row.agenfk_version_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('updates to the latest version when a newer batch arrives', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${fleetToken}`)
        .set('x-agenfk-version', '0.3.0-beta.21')
        .send({ events: [sample({ eventId: 'e1' })] });
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${fleetToken}`)
        .set('x-agenfk-version', '0.3.0-beta.22')
        .send({ events: [sample({ eventId: 'e2' })] });
      const row = await ctx.db.get<{ agenfk_version: string }>(
        'SELECT agenfk_version FROM installations WHERE id = ?',
        ['inst-1'],
      );
      expect(row.agenfk_version).toBe('0.3.0-beta.22');
    });

    it('leaves the row alone when the header is absent', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${fleetToken}`)
        .set('x-agenfk-version', '0.3.0-beta.20')
        .send({ events: [sample({ eventId: 'e1' })] });
      // Second batch with no header — must not clobber to null/unknown.
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${fleetToken}`)
        .send({ events: [sample({ eventId: 'e2' })] });
      const row = await ctx.db.get<{ agenfk_version: string }>(
        'SELECT agenfk_version FROM installations WHERE id = ?',
        ['inst-1'],
      );
      expect(row.agenfk_version).toBe('0.3.0-beta.20');
    });

    it('rejects malformed version values (semver allowlist)', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${fleetToken}`)
        .set('x-agenfk-version', '0.0.0; rm -rf /')
        .send({ events: [sample()] });
      const row = await ctx.db.get<{ agenfk_version: string | null }>(
        'SELECT agenfk_version FROM installations WHERE id = ?',
        ['inst-1'],
      );
      // Malformed input must NOT be persisted.
      expect(row.agenfk_version).toBeFalsy();
    });
  });

  describe('admin endpoints surface the version', () => {
    it('GET /v1/admin/upgrade includes agenfkVersion on per-installation target rows', async () => {
      // Seed an event so the installations row exists with a known version.
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${fleetToken}`)
        .set('x-agenfk-version', '0.3.0-beta.22')
        .send({ events: [sample()] });

      // Issue a directive — must reuse the project's existing release-existence
      // check; supply a stub via re-creating the app would be heavier than
      // worth it here, so we issue a directive to a pre-existing installation
      // and accept the network call (or the test infra's stubs) — instead,
      // directly insert a directive + target row, then read it back.
      await ctx.db.run(
        `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type, scope_id)
         VALUES ('dir-1', 'org-a', '0.3.1', 'installation', 'inst-1')`,
      );
      await ctx.db.run(
        `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
         VALUES ('dir-1', 'inst-1', 'pending')`,
      );

      const r = await supertest(app).get('/v1/admin/upgrade').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      const d = r.body.directives.find((x: any) => x.directiveId === 'dir-1');
      expect(d).toBeDefined();
      const target = d.targets.find((t: any) => t.installationId === 'inst-1');
      expect(target.agenfkVersion).toBe('0.3.0-beta.22');
      expect(target.agenfkVersionUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });
  });
});
