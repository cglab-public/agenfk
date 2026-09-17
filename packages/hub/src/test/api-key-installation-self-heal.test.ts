/**
 * An api_key's installation binding is written once, at issuance, and never
 * repaired (BUG bb27c0aa). A key minted without one — through the admin
 * "create key" form, or by an older CLI — is then structurally invisible to
 * every fleet operation: GET /v1/upgrade-directive returns 204 for an unbound
 * key because it cannot be attributed to a machine. Production showed two
 * machines (Diego, Guilherme) in exactly that state: their events ingested
 * fine, but no directive could ever reach them.
 *
 * So an unbound key binds itself to the machine it is demonstrably running on,
 * the first time that machine reports.
 *
 * THE GUARD IS THE POINT, NOT AN AFTERTHOUGHT. An org-wide key is a SUPPORTED
 * thing ("legacy org-wide keys (null installation_id) are exempt" — the BOLA
 * check in routes/events.ts). Binding one to the first machine that used it
 * would make every OTHER machine on that key fail the `foreign_installation`
 * check — turning a working fleet into a rejecting one, which is strictly worse
 * than the bug being fixed. So a key only self-binds when it is shaped like a
 * per-machine credential AND the batch names a single installation AND that
 * installation has no other live bound key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { hashToken } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-selfheal-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const INST_A = 'inst-selfheal-a';
const INST_B = 'inst-selfheal-b';

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const ev = (installationId: string, i: number) => ({
  eventId: `ev-${installationId}-${i}`,
  installationId,
  orgId: 'org-a',
  occurredAt: '2026-09-17T12:00:00Z',
  type: 'task.completed',
  actor: { osUser: 'gcsiqueira', gitName: 'Guilherme Siqueira', gitEmail: 'guilherme.siqueira@cglab.com' },
  payload: {},
});

describe('an unbound api_key self-binds to the machine that reports through it', () => {
  let app: any; let ctx: any; let cookie: string;

  const bindOf = (token: string) =>
    ctx.db.get('SELECT installation_id FROM api_keys WHERE token_hash = ?', [hashToken(token)])
      .then((r: any) => r?.installation_id ?? null);

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a',
    });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' }))
      .headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    await drainApp(app);
    ctx.stopWorkers?.();
    await ctx.db.close();
    cleanup();
  });

  const post = (token: string, events: unknown[]) =>
    supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });

  it('binds a per-machine key on the first report from its machine', async () => {
    // The real production case: an older CLI joined through the device flow
    // without sending identity, so the key was minted unbound (device:2C6K-V9N5,
    // device:2Z3C-5ZNA) and its machine could never be upgraded.
    const token = await issueApiKey(ctx.db, 'org-a', 'device:guilherme');
    expect(await bindOf(token)).toBeNull();

    const r = await post(token, [ev(INST_A, 1)]);

    expect(r.status).toBe(200);
    expect(await bindOf(token)).toBe(INST_A);
  });

  it('makes the machine reachable — the directive that was 204 forever now arrives', async () => {
    const token = await issueApiKey(ctx.db, 'org-a', 'invite:diego.penha@cglab.com');
    await ctx.db.run(
      `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type, scope_id)
       VALUES ('dir-selfheal', 'org-a', '1.2.3', 'installation', ?)`, [INST_A],
    );
    await ctx.db.run(
      `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
       VALUES ('dir-selfheal', ?, 'pending')`, [INST_A],
    );

    // Before any report: unbound, so the directive is unreachable.
    const before = await supertest(app).get('/v1/upgrade-directive').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(204);

    await post(token, [ev(INST_A, 1)]);

    const after = await supertest(app).get('/v1/upgrade-directive').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.targetVersion).toBe('1.2.3');
  });

  it('does NOT bind an org-wide key, so its other machines keep working', async () => {
    // A shared/CI key is supported. Binding it to the first machine would make
    // every other machine on it fail foreign_installation.
    const token = await issueApiKey(ctx.db, 'org-a', 'shared-ci');

    await post(token, [ev(INST_A, 1)]);
    expect(await bindOf(token)).toBeNull();

    const second = await post(token, [ev(INST_B, 2)]);
    expect(second.status).toBe(200);
    expect(second.body.rejected ?? 0).toBe(0);
    expect(await bindOf(token)).toBeNull();
  });

  it('does NOT bind an email-labelled SHARED key, so its other machines keep ingesting', async () => {
    // The counterexample that broke the first version of this guard: an address
    // is the most natural label for a shared key (`builds@`, `ci@`, `team@`), and
    // inferring "one machine" from it pinned the key to the first machine that
    // reported — after which every other machine was refused as
    // foreign_installation, still answered 200, and had its rows deadlettered.
    const token = await issueApiKey(ctx.db, 'org-a', 'builds@cglab.com');

    await post(token, [ev(INST_A, 1)]);
    expect(await bindOf(token)).toBeNull();

    const second = await post(token, [ev(INST_B, 2)]);
    expect(second.status).toBe(200);
    expect(second.body.rejected ?? 0).toBe(0);
    expect(await bindOf(token)).toBeNull();
  });

  it('binds to a machine whose only previous key was revoked', async () => {
    // The revoked_at filter exists so a machine can recover: restarting an
    // onboarding must not be blocked by its own dead key.
    const dead = await issueApiKey(ctx.db, 'org-a', 'device:DEAD', { installationId: INST_A });
    await ctx.db.run('UPDATE api_keys SET revoked_at = ? WHERE token_hash = ?',
      [new Date().toISOString(), hashToken(dead)]);
    const fresh = await issueApiKey(ctx.db, 'org-a', 'device:FRESH');

    await post(fresh, [ev(INST_A, 1)]);

    expect(await bindOf(fresh)).toBe(INST_A);
  });

  it('binds a bare "invite" label — the older CLI invite shape', async () => {
    // connect.ts labels an identity-less invite redeem exactly `invite`, and it
    // is the same single-use token as the prefixed form, so excluding it would
    // leave that machine unbound for no reason. Its device twin always carries a
    // colon, which is why the two flows are not symmetric by accident.
    const token = await issueApiKey(ctx.db, 'org-a', 'invite');

    await post(token, [ev(INST_A, 1)]);

    expect(await bindOf(token)).toBe(INST_A);
  });

  it('does not bind on a batch where nothing was accepted', async () => {
    // seenInstallations holds only ACCEPTED events; a fully rejected batch must
    // not be read as evidence that this key belongs to that machine.
    const token = await issueApiKey(ctx.db, 'org-a', 'device:ZZZZ');

    const r = await post(token, [{ ...ev(INST_A, 1), orgId: 'org-other' }]);

    expect(r.status).toBe(200);
    expect(r.body.rejected ?? 0).toBeGreaterThan(0);
    expect(await bindOf(token)).toBeNull();
  });

  it('does not bind when one batch spans two installations', async () => {
    const token = await issueApiKey(ctx.db, 'org-a', 'device:MULTI');

    await post(token, [ev(INST_A, 1), ev(INST_B, 2)]);

    expect(await bindOf(token)).toBeNull();
  });

  it('does not bind to a machine that already has a live bound key', async () => {
    // Nothing to fix: the machine already receives directives through its
    // bound key, and an extra binding would add ambiguity for no gain.
    await issueApiKey(ctx.db, 'org-a', 'device:first', { installationId: INST_A });
    const spare = await issueApiKey(ctx.db, 'org-a', 'device:spare');

    await post(spare, [ev(INST_A, 1)]);

    expect(await bindOf(spare)).toBeNull();
  });
});
