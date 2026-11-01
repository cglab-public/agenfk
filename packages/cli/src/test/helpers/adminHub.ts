/**
 * A real hub on loopback for `agenfk hub admin …` tests (CGLAB-702), with an
 * admin signed in. Each story's spec drives its commands against this, not a
 * mocked axios: the commands exist to talk to the hub, and only the hub can
 * say whether they ask it the right thing.
 *
 * The caller mocks `os.homedir()` (vi.mock is hoisted per file) and passes the
 * sandbox home here, so the credential lands where the CLI will look for it.
 */
import { vi, expect } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import supertest from 'supertest';
import { registerHubCommands } from '../../commands/hub';
import { createHubApp } from '../../../../hub/src/server';
import { createPasswordUser } from '../../../../hub/src/auth/password';
import { loginAs } from '../../../../hub/src/test/helpers/loginAs';
import { drainApp } from '../../../../hub/src/test/helpers/drainApp';

export interface AdminHub {
  server: http.Server;
  url: string;
  ctx: any;
  /** The board cookie of admin@x, for setting up state the way the UI would. */
  cookie: string;
  /** Runs `agenfk <args>`; rejects with "exit N" when the command exits. */
  run: (args: string[]) => Promise<void>;
  /** Everything printed to stdout / stderr since the last clear. */
  out: () => string;
  err: () => string;
  clear: () => void;
  /** Runs `agenfk <args> --json` and parses what it printed. */
  json: <T = any>(args: string[]) => Promise<T>;
  close: () => Promise<void>;
}

export async function startAdminHub(home: string, name: string): Promise<AdminHub> {
  const dbPath = path.join(os.tmpdir(), `agenfk-cli-${name}-${process.pid}.sqlite`);
  const rmDb = () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true }); };
  rmDb();
  fs.rmSync(path.join(home, '.agenfk'), { recursive: true, force: true });

  const hub = await createHubApp({ dbPath, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
  const server = hub.app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  await createPasswordUser(hub.ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
  const cookie = await loginAs(server, 'admin@x', 'longenough1');

  // Sign the CLI in the way `hub admin login` does, minus the wait for a person.
  const start = await supertest(server).post('/hub/admin-device/start').send({});
  await supertest(server).post('/hub/admin-device/approve').set('Cookie', cookie).send({ userCode: start.body.userCode });
  const poll = await supertest(server).post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
  expect(poll.body.status).toBe('approved');
  fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agenfk', 'hub-admin.json'), JSON.stringify({
    url, token: poll.body.token, orgId: poll.body.orgId, email: 'admin@x', role: 'admin', expiresAt: poll.body.expiresAt,
  }), { mode: 0o600 });

  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const out = () => logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
  const err = () => errSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
  const clear = () => { logSpy.mockClear(); errSpy.mockClear(); };

  const run = async (args: string[]) => {
    const p = new Command();
    p.exitOverride();
    registerHubCommands(p);
    await p.parseAsync(args, { from: 'user' });
  };

  return {
    server, url, ctx: hub.ctx, cookie, run, out, err, clear,
    json: async (args) => { clear(); await run([...args, '--json']); return JSON.parse(out()); },
    close: async () => {
      vi.restoreAllMocks();
      await drainApp(server);
      await hub.ctx.db.close();
      rmDb();
    },
  };
}
