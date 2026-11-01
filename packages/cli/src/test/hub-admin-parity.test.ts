/**
 * CGLAB-702 S7: the admin CLI keeps up with the board.
 *
 * Every route a signed-in person can reach on the hub (it sits behind the
 * hub's session or admin guard) is either called by an `agenfk hub admin`
 * command, or listed in NOT_IN_CLI with the reason it has no command. A new
 * board route therefore fails here until the CLI covers it or someone writes
 * down why it should not; a command declaring a route the hub no longer
 * serves fails too.
 *
 * And every read command prints something a person can read: no
 * `undefined`, `[object Object]` or `NaN` from a field name guessed wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import supertest from 'supertest';
import { registerHubCommands } from '../commands/hub';
import { coveredRoutes } from '../hubAdmin/client';
import { NOT_IN_CLI } from '../hubAdmin/parity';
import { boardRoutesOf } from '../../../hub/src/services/configAuditRoutes';
import { startAdminHub, AdminHub } from './helpers/adminHub';
import { issueApiKey } from '../../../hub/src/auth/apiKey';
import { upsertInstallation } from '../../../hub/src/services/installations';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-admin-parity-')) };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});

let hub: AdminHub;
beforeEach(async () => { hub = await startAdminHub(sandboxHome, 'parity'); });
afterEach(async () => { await hub.close(); });

describe('parity with the board', () => {
  it('finds the board\'s routes by their guard (a sanity check on the walker)', () => {
    const board = boardRoutesOf(hub.app);
    expect(board).toContain('GET /v1/admin/users');
    expect(board).toContain('GET /v1/timeline');
    expect(board).toContain('POST /hub/invite/create');
    // Not board routes: an installation's ingest, and the unauthenticated device start.
    expect(board).not.toContain('POST /v1/events');
    expect(board).not.toContain('POST /hub/device/start');
  });

  it('every board route has an admin command, or a written reason it has none', () => {
    registerHubCommands(new Command());
    const covered = new Set(coveredRoutes());
    const board = boardRoutesOf(hub.app);
    const missing = board.filter(r => !covered.has(r) && !(r in NOT_IN_CLI));
    expect(missing, `board routes with no \`agenfk hub admin\` command (cover them, or add them to NOT_IN_CLI with a reason):\n${missing.join('\n')}`).toEqual([]);
  });

  it('every route a command declares is one the hub serves, and every exclusion is still a board route', () => {
    registerHubCommands(new Command());
    const board = new Set(boardRoutesOf(hub.app));
    expect(coveredRoutes().filter(r => !board.has(r)), 'commands declaring routes the hub does not serve behind its guards').toEqual([]);
    expect(Object.keys(NOT_IN_CLI).filter(r => !board.has(r)), 'stale NOT_IN_CLI entries').toEqual([]);
    for (const [route, why] of Object.entries(NOT_IN_CLI)) expect(why.length, route).toBeGreaterThan(20);
  });
});

describe('the commands this story added', () => {
  it('`installations approve` approves a machine\'s login code (only with --yes) and the machine collects its key', async () => {
    const start = await supertest(hub.server).post('/hub/device/start').send({ installation: { installationId: 'inst-new', osUser: 'n', gitName: null, gitEmail: 'n@x' } });
    await expect(hub.run(['hub', 'admin', 'installations', 'approve', start.body.userCode])).rejects.toThrow(/exit 1/);
    expect((await supertest(hub.server).post('/hub/device/poll').send({ deviceCode: start.body.deviceCode })).body.status).toBe('pending');
    hub.clear();
    await hub.run(['hub', 'admin', 'installations', 'approve', start.body.userCode, '--yes']);
    expect(hub.out()).toContain('n@x');
    const poll = await supertest(hub.server).post('/hub/device/poll').send({ deviceCode: start.body.deviceCode });
    expect(poll.body.status).toBe('approved');
    expect((await supertest(hub.server).get('/v1/ping').set('Authorization', `Bearer ${poll.body.token}`)).body.installationId).toBe('inst-new');
  });

  it('`flows projects` lists what the board offers as project targets', async () => {
    const key = await issueApiKey(hub.ctx.db, 'org', 'm', { installationId: 'inst-p' });
    await supertest(hub.server).post('/v1/events').set('Authorization', `Bearer ${key}`).send({ events: [{
      eventId: 'e-p', installationId: 'inst-p', orgId: 'org', occurredAt: '2026-10-01T10:00:00Z',
      actor: { osUser: 'p', gitName: null, gitEmail: 'p@x' }, type: 'item.created', remoteUrl: 'git@github.com:acme/web.git', payload: {},
    }] });
    expect(await hub.json(['hub', 'admin', 'flows', 'projects'])).toEqual((await supertest(hub.server).get('/v1/admin/projects').set('Cookie', hub.cookie)).body);
  });
});

describe('human-readable output', () => {
  beforeEach(async () => {
    await upsertInstallation(hub.ctx.db, 'org', { installationId: 'inst-1', osUser: 'dev', gitName: 'Dev', gitEmail: 'dev@x' });
    const key = await issueApiKey(hub.ctx.db, 'org', 'machine', { installationId: 'inst-1' });
    await supertest(hub.server).post('/v1/events').set('Authorization', `Bearer ${key}`).send({ events: [{
      eventId: 'e-1', installationId: 'inst-1', orgId: 'org', occurredAt: '2026-10-01T10:00:00Z',
      actor: { osUser: 'dev', gitName: 'Dev', gitEmail: 'dev@x' }, type: 'pr.opened', remoteUrl: 'git@github.com:acme/api.git',
      payload: { prNumber: 1, repo: 'acme/api', model: 'model-a', harness: 'pi', sizing: { epic: 0, story: 0, task: 1, bug: 0 }, sizingShadow: { epic: 0, story: 0, task: 1, bug: 0 }, leafStory: 0 },
    }] });
    await supertest(hub.server).post('/v1/repo-settings/init').set('Authorization', `Bearer ${key}`).send({ repo: 'https://github.com/acme/api.git', verifyCommand: 'npm test' });
    await supertest(hub.server).put('/v1/admin/airlock').set('Cookie', hub.cookie).send({ policy: {
      schemaVersion: 1, mode: 'enforce', models: [{ client: 'pi', provider: 'x' }], appliesWhenModelUnknown: true, hosts: { allow: ['github.com'], deny: [] },
    }, expectedRevision: 0 });
    await supertest(hub.server).post('/v1/admin/models/mappings').set('Cookie', hub.cookie).send({ aliasModel: 'm', canonicalModel: 'model-a' });

    // Something in every table, so a cell reading a wrong field shows up as missing data.
    const asBoard = (m: 'post' | 'put', p: string, body: unknown) => (supertest(hub.server) as any)[m](p).set('Cookie', hub.cookie).send(body);
    await asBoard('post', '/v1/admin/ci-tokens', { label: 'gha-smoke', scope: 'org' });
    await asBoard('post', '/v1/admin/hidden-users', { userKey: 'gone@x' });
    await asBoard('post', '/v1/admin/user-keys/merge', { from: 'old@x', to: 'new@x' });
    await asBoard('post', '/v1/admin/flows', { definition: { name: 'Smoke Flow', steps: [
      { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true }, { id: 's1', name: 'work', label: 'W', order: 1 },
      { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true }] } });
    await asBoard('put', '/v1/admin/jira', { clientId: 'cid-smoke', clientSecret: 's' });
    const now = new Date().toISOString();
    await hub.ctx.db.run('INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)', ['child-1', 'org', 'Child One', now, now]);
  });

  /** Each read command, and what the seeded hub must make it print (in its cells, not just its headings). */
  const READS: Record<string, RegExp | null> = {
    'whoami': /admin@x/, 'sessions list': /admin@x/, 'users list': /admin@x\s+admin\s+yes/,
    'identities suggestions': null, 'identities merges': /old@x\s+new@x/, 'identities hidden': /gone@x\s+admin@x/,
    'installations list': /inst-1\s+dev@x/, 'sign-in show': /Password: on/, 'api-keys list': /machine/,
    'ci-tokens list': /gha-smoke\s+org\s+admin@x/, 'flows list': /Smoke Flow\s+1\s+hub\s+no/, 'flows default': /\d+\. \S+/,
    'flows assignments': null, 'flows registry show': /\S+\/\S+@\S+/, 'flows dispatches': null, 'flows projects': /acme\/api/,
    'upgrades list': null, 'upgrades dispatches': null, 'repoint status': /No address change/,
    'airlock policy show': /allow: github\.com/, 'airlock installations': null, 'airlock history': /admin@x/,
    'airlock decisions': null, 'airlock dataset show': /Collection: off/, 'airlock learning list': /Policy revision 1/,
    'repos list': /acme\/api\.git\s+npm test\s+1\s+off/, 'models list': /model-a\s+1/, 'org pending': /Nothing pending/,
    'federation status': /No parent hub/, 'federation identity-policy show': /Child One\s+child-1\s+inherit/,
    'child-hubs list': /child-1\s+Child One/, 'jira show': /cid-smoke/, 'audit list': /admin@x\s+board/,
  };

  it('every read command prints its data, and never undefined, [object Object] or NaN', async () => {
    for (const [cmd, expected] of Object.entries(READS)) {
      hub.clear();
      await hub.run(['hub', 'admin', ...cmd.split(' ')]);
      const out = hub.out();
      expect(out.trim().length, cmd).toBeGreaterThan(0);
      expect(out, cmd).not.toMatch(/undefined|\[object Object\]|\bNaN\b/);
      if (expected) expect(out, cmd).toMatch(expected);
    }
  });
});
