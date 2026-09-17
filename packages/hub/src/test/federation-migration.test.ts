// Upgrade path for the identity-policy columns (CGLAB-184).
//
// Both columns were added inside CREATE TABLE IF NOT EXISTS, which never runs
// on a hub that already has the table. Without a guarded ALTER, the ping route
// throws on every upgraded hub and the whole fleet of children reads dead on
// the parent's roster — permanently, since a failed ping also stops the outbox
// draining. A fresh-schema parity test cannot see this by construction.
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

describe('identity_policy columns arrive on an existing database', () => {
  it('adds them by ALTER, and the heartbeat works on a hub upgraded from before they existed', async () => {
    cleanup();
    // Build the pre-CGLAB-184 shape: tables present, columns absent.
    const seed = await openDb(DB);
    await seed.run('ALTER TABLE child_hubs DROP COLUMN identity_policy');
    await seed.run('ALTER TABLE org_settings DROP COLUMN identity_policy');
    const before = await seed.all<{ name: string }>("SELECT name FROM pragma_table_info('child_hubs')");
    expect(before.map(c => c.name)).not.toContain('identity_policy');
    await seed.close();

    // Boot: the migration must add both.
    const out = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    const after = await out.ctx.db.all<{ name: string }>("SELECT name FROM pragma_table_info('child_hubs')");
    expect(after.map(c => c.name)).toContain('identity_policy');
    const osAfter = await out.ctx.db.all<{ name: string }>("SELECT name FROM pragma_table_info('org_settings')");
    expect(osAfter.map(c => c.name)).toContain('identity_policy');

    // And the route that reads them actually answers.
    await createPasswordUser(out.ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const cookie = (await supertest(out.app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    const inv = await supertest(out.app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const enr = await supertest(out.app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name: 'c' } });
    expect(enr.status).toBe(200);
    const ping = await supertest(out.app).post('/v1/federation/ping').set('Authorization', `Bearer ${enr.body.token}`).send({});
    expect(ping.status).toBe(200);
    expect(ping.body.identityPolicy).toBe('keep');

    out.ctx.stopWorkers?.();
    await drainApp(out.app);
    await out.ctx.db.close();
  });
});
