import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openDb } from '../db';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const SECRET = 'a'.repeat(64);
const DB = path.join(os.tmpdir(), `agenfk-hub-fed-migration-${process.pid}.sqlite`);
const cleanup = () => {
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
};
afterEach(cleanup);

const NEW_COLUMNS = ['identity_person', 'identity_installation'];
const columns = async (db: any, table: string) =>
  (await db.all("SELECT name FROM pragma_table_info('" + table + "')") as Array<{ name: string }>).map(c => c.name);

/** Rebuild a deployed hub's shape: the per-field columns absent, and the binary policy `legacy` (or no column at all). */
async function seedOldHub(legacy: 'pseudonymize' | 'none') {
  const seed = await openDb(DB);
  for (const t of ['child_hubs', 'org_settings']) {
    for (const c of NEW_COLUMNS) await seed.run(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    if (legacy !== 'none') await seed.run(`ALTER TABLE ${t} ADD COLUMN identity_policy TEXT`);
  }
  if (legacy !== 'none') {
    await seed.run("INSERT INTO org_settings (org_id, identity_policy) VALUES ('org', 'pseudonymize')");
    const now = new Date().toISOString();
    await seed.run("INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen, identity_policy) VALUES ('old-child', 'org', 'old', ?, ?, 'pseudonymize')", [now, now]);
  }
  expect(await columns(seed, 'child_hubs')).not.toContain('identity_person');
  await seed.close();
}

async function bootAndEnroll() {
  const out = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
  await createPasswordUser(out.ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
  const cookie = (await supertest(out.app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  const inv = await supertest(out.app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
  const enr = await supertest(out.app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name: 'c' } });
  expect(enr.status).toBe(200);
  const ping = await supertest(out.app).post('/v1/federation/ping').set('Authorization', `Bearer ${enr.body.token}`).send({});
  const close = async () => { out.ctx.stopWorkers?.(); await drainApp(out.app); await out.ctx.db.close(); };
  return { out, cookie, ping, close };
}

describe('identity coding columns arrive on an existing database', () => {
  it('adds them by ALTER, and the heartbeat works on a hub upgraded from before identity settings existed', async () => {
    cleanup();
    await seedOldHub('none');
    const { out, ping, close } = await bootAndEnroll();
    for (const t of ['child_hubs', 'org_settings']) {
      for (const c of NEW_COLUMNS) expect(await columns(out.ctx.db, t)).toContain(c);
    }
    expect(ping.status).toBe(200);
    expect(ping.body.identity).toEqual({ person: 'as-written', installation: 'as-written' });
    await close();
  });

  it('resets an existing pseudonymize, group and per child, to as written', async () => {
    cleanup();
    await seedOldHub('pseudonymize');
    const { out, cookie, ping, close } = await bootAndEnroll();
    expect(ping.body.identity).toEqual({ person: 'as-written', installation: 'as-written' });
    expect(ping.body.identityPolicy).toBe('keep');
    const read = await supertest(out.app).get('/v1/admin/federation/identity').set('Cookie', cookie);
    expect(read.body.group).toEqual({ person: null, installation: null });
    const old = read.body.childHubs.find((c: any) => c.id === 'old-child');
    expect(old).toMatchObject({ override: { person: null, installation: null }, effective: { person: 'as-written', installation: 'as-written' } });
    expect((await out.ctx.db.get("SELECT identity_policy FROM org_settings WHERE org_id = 'org'")).identity_policy).toBeNull();
    expect((await out.ctx.db.get("SELECT identity_policy FROM child_hubs WHERE id = 'old-child'")).identity_policy).toBeNull();
    await close();
  });

  it('keeps per-field settings made after the upgrade across a restart', async () => {
    cleanup();
    await seedOldHub('pseudonymize');
    const first = await bootAndEnroll();
    await supertest(first.out.app).put('/v1/admin/federation/identity').set('Cookie', first.cookie).send({ person: 'coded' });
    await first.close();
    const again = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    expect(await again.ctx.db.get("SELECT identity_person FROM org_settings WHERE org_id = 'org'")).toEqual({ identity_person: 'coded' });
    again.ctx.stopWorkers?.();
    await drainApp(again.app);
    await again.ctx.db.close();
  });
});
