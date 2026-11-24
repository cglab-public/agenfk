/**
 * CGLAB-702 S2: People & access from the command line - users, identities,
 * installations, sign-in, API keys, installation invites and CI tokens.
 * Every command runs against a real hub; state is checked through the hub's
 * own API (as the board would see it), not through the command's output alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import supertest from 'supertest';
import { startAdminHub, AdminHub } from './helpers/adminHub';
import { createPasswordUser } from '../../../hub/src/auth/password';
import { issueApiKey } from '../../../hub/src/auth/apiKey';
import { upsertInstallation } from '../../../hub/src/services/installations';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-admin-people-')) };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});

let hub: AdminHub;
beforeEach(async () => { hub = await startAdminHub(sandboxHome, 'people'); });
afterEach(async () => { await hub.close(); });

const board = (method: 'get' | 'post' | 'put' | 'delete', p: string) => (supertest(hub.server) as any)[method](p).set('Cookie', hub.cookie);
const userRow = async (email: string) => (await board('get', '/v1/admin/users')).body.find((u: any) => u.email === email);

/** Feeds `text` to the command as stdin, the way `echo pw | agenfk …` would. */
async function withStdin(text: string, fn: () => Promise<void>): Promise<void> {
  const real = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: Readable.from([text]), configurable: true });
  try { await fn(); } finally { Object.defineProperty(process, 'stdin', real); }
}

describe('users', () => {
  it('lists users', async () => {
    const users = await hub.json(['hub', 'admin', 'users', 'list']);
    expect(users.map((u: any) => u.email)).toContain('admin@x');
  });

  it('invites an SSO user, and a password user with the password read from stdin', async () => {
    await hub.run(['hub', 'admin', 'users', 'invite', 'sso@x', '--role', 'viewer']);
    expect((await userRow('sso@x')).role).toBe('viewer');
    await withStdin('longenough2\n', () => hub.run(['hub', 'admin', 'users', 'invite', 'pw@x', '--role', 'admin', '--password-stdin']));
    const login = await supertest(hub.server).post('/auth/login').send({ email: 'pw@x', password: 'longenough2' });
    expect(login.status).toBe(200);
  });

  it('refuses an invite without a valid --role', async () => {
    await expect(hub.run(['hub', 'admin', 'users', 'invite', 'x@x'])).rejects.toThrow(/exit 1|required/);
    await expect(hub.run(['hub', 'admin', 'users', 'invite', 'x@x', '--role', 'owner'])).rejects.toThrow(/exit 1/);
    expect(await userRow('x@x')).toBeUndefined();
  });

  it('changes role, deactivates and reactivates, addressing users by email', async () => {
    await createPasswordUser(hub.ctx.db, 'org', 'v@x', 'longenough1', 'viewer');
    await hub.run(['hub', 'admin', 'users', 'set-role', 'v@x', 'admin']);
    expect((await userRow('v@x')).role).toBe('admin');
    await expect(hub.run(['hub', 'admin', 'users', 'set-role', 'v@x', 'viewer'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toContain('--yes');
    expect((await userRow('v@x')).role).toBe('admin');
    await hub.run(['hub', 'admin', 'users', 'set-role', 'v@x', 'viewer', '--yes']);
    expect((await userRow('v@x')).role).toBe('viewer');
    await hub.run(['hub', 'admin', 'users', 'deactivate', 'v@x', '--yes']);
    expect(Number((await userRow('v@x')).active)).toBe(0);
    await hub.run(['hub', 'admin', 'users', 'activate', 'v@x']);
    expect(Number((await userRow('v@x')).active)).toBe(1);
  });

  it('sets a password from stdin', async () => {
    await createPasswordUser(hub.ctx.db, 'org', 'v@x', 'longenough1', 'viewer');
    await withStdin('brandnewpass', () => hub.run(['hub', 'admin', 'users', 'set-password', 'v@x', '--password-stdin']));
    expect((await supertest(hub.server).post('/auth/login').send({ email: 'v@x', password: 'brandnewpass' })).status).toBe(200);
  });

  it('deletes only with --yes', async () => {
    await createPasswordUser(hub.ctx.db, 'org', 'v@x', 'longenough1', 'viewer');
    await expect(hub.run(['hub', 'admin', 'users', 'delete', 'v@x'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toContain('--yes');
    expect(await userRow('v@x')).toBeTruthy();
    await hub.run(['hub', 'admin', 'users', 'delete', 'v@x', '--yes']);
    expect(await userRow('v@x')).toBeUndefined();
  });

  it('two accounts differing only in case: the exact one is used, an inexact one is refused', async () => {
    await supertest(hub.server).post('/v1/admin/users/invite').set('Cookie', hub.cookie).send({ email: 'Alice@x', role: 'viewer' });
    await supertest(hub.server).post('/v1/admin/users/invite').set('Cookie', hub.cookie).send({ email: 'alice@x', role: 'viewer' });
    await hub.run(['hub', 'admin', 'users', 'delete', 'alice@x', '--yes']);
    expect(await userRow('alice@x')).toBeUndefined();
    expect(await userRow('Alice@x')).toBeTruthy();
    await supertest(hub.server).post('/v1/admin/users/invite').set('Cookie', hub.cookie).send({ email: 'alice@x', role: 'viewer' });
    hub.clear();
    await expect(hub.run(['hub', 'admin', 'users', 'delete', 'ALICE@X', '--yes'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/differ only in case/);
    expect(await userRow('Alice@x')).toBeTruthy();
    expect(await userRow('alice@x')).toBeTruthy();
  });

  it('an unknown email is a clear error, not a request for an empty id', async () => {
    await expect(hub.run(['hub', 'admin', 'users', 'set-role', 'ghost@x', 'admin'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/no user .*ghost@x/i);
  });

  it('reports the hub\'s refusal in its own words (cannot demote yourself)', async () => {
    await expect(hub.run(['hub', 'admin', 'users', 'set-role', 'admin@x', 'viewer', '--yes'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/own account/);
  });
});

describe('identities', () => {
  it('merges one user key into another, lists the merge, and reverts it', async () => {
    await hub.run(['hub', 'admin', 'identities', 'merge', 'old@x', 'new@x', '--yes']);
    const merges = await hub.json(['hub', 'admin', 'identities', 'merges']);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ from: 'old@x', to: 'new@x', revertedAt: null });
    await hub.run(['hub', 'admin', 'identities', 'revert', merges[0].id, '--yes']);
    const after = await hub.json(['hub', 'admin', 'identities', 'merges']);
    expect(after[0].revertedAt).not.toBeNull();
  });

  it('merge needs --yes', async () => {
    await expect(hub.run(['hub', 'admin', 'identities', 'merge', 'old@x', 'new@x'])).rejects.toThrow(/exit 1/);
    expect((await board('get', '/v1/admin/user-keys/merges')).body).toHaveLength(0);
  });

  it('lists suggestions', async () => {
    expect(Array.isArray(await hub.json(['hub', 'admin', 'identities', 'suggestions']))).toBe(true);
  });

  it('unhides exactly the key named, even one holding % characters', async () => {
    await board('post', '/v1/admin/hidden-users').send({ userKey: 'alice%40x' });
    await board('post', '/v1/admin/hidden-users').send({ userKey: 'alice@x' });
    await hub.run(['hub', 'admin', 'identities', 'unhide', 'alice%40x']);
    expect((await hub.json(['hub', 'admin', 'identities', 'hidden'])).map((h: any) => h.userKey)).toEqual(['alice@x']);
    await board('post', '/v1/admin/hidden-users').send({ userKey: '100%' });
    await hub.run(['hub', 'admin', 'identities', 'unhide', '100%']);
    expect((await hub.json(['hub', 'admin', 'identities', 'hidden'])).map((h: any) => h.userKey)).toEqual(['alice@x']);
  });

  it('hides a person (with --yes) and unhides them', async () => {
    await hub.run(['hub', 'admin', 'identities', 'hide', 'Gone@X', '--yes']);
    expect((await hub.json(['hub', 'admin', 'identities', 'hidden'])).map((h: any) => h.userKey)).toEqual(['gone@x']);
    await hub.run(['hub', 'admin', 'identities', 'unhide', 'gone@x']);
    expect(await hub.json(['hub', 'admin', 'identities', 'hidden'])).toEqual([]);
  });
});

describe('installations', () => {
  beforeEach(async () => {
    await upsertInstallation(hub.ctx.db, 'org', { installationId: 'inst-1', osUser: 'dev', gitName: 'Dev', gitEmail: 'dev@x' });
  });

  it('lists, retires (with --yes) and unretires an installation', async () => {
    expect((await hub.json(['hub', 'admin', 'installations', 'list'])).map((i: any) => i.id)).toContain('inst-1');
    await expect(hub.run(['hub', 'admin', 'installations', 'retire', 'inst-1'])).rejects.toThrow(/exit 1/);
    await hub.run(['hub', 'admin', 'installations', 'retire', 'inst-1', '--yes']);
    expect((await hub.json(['hub', 'admin', 'installations', 'list'])).map((i: any) => i.id)).not.toContain('inst-1');
    const all = await hub.json(['hub', 'admin', 'installations', 'list', '--include-retired']);
    expect(all.find((i: any) => i.id === 'inst-1').retired).toBe(true);
    await hub.run(['hub', 'admin', 'installations', 'unretire', 'inst-1']);
    expect((await hub.json(['hub', 'admin', 'installations', 'list'])).map((i: any) => i.id)).toContain('inst-1');
  });
});

describe('sign-in', () => {
  it('shows the sign-in configuration without secrets', async () => {
    const cfg = await hub.json(['hub', 'admin', 'sign-in', 'show']);
    expect(cfg).toHaveProperty('passwordEnabled');
  });

  it('sets the allowlist and a Google client, the secret read from stdin and never echoed', async () => {
    await withStdin('s3cr3t-value\n', () => hub.run([
      'hub', 'admin', 'sign-in', 'set', '--google', 'on', '--google-client-id', 'cid.apps', '--google-client-secret-stdin',
      '--allowlist', 'x, y.com',
    ]));
    const cfg = (await board('get', '/v1/admin/auth-config')).body;
    expect(cfg.googleEnabled).toBe(true);
    expect(cfg.google.clientId).toBe('cid.apps');
    expect(cfg.emailAllowlist).toEqual(['x', 'y.com']);
    expect(cfg.google.clientSecretSet).toBe(true);
    expect(hub.out() + hub.err()).not.toContain('s3cr3t-value');
  });

  it('sets an Entra client with its secret from stdin', async () => {
    await withStdin('entra-secret', () => hub.run([
      'hub', 'admin', 'sign-in', 'set', '--entra-tenant-id', 'tid', '--entra-client-id', 'ecid', '--entra-client-secret-stdin',
    ]));
    const cfg = (await board('get', '/v1/admin/auth-config')).body;
    expect(cfg.entra).toEqual({ tenantId: 'tid', clientId: 'ecid', clientSecretSet: true });
  });

  it('refuses an empty secret on stdin, and changes nothing', async () => {
    await expect(withStdin('', () => hub.run(['hub', 'admin', 'sign-in', 'set', '--google-client-secret-stdin']))).rejects.toThrow(/exit 1/);
    expect((await board('get', '/v1/admin/auth-config')).body.google.clientSecretSet).toBe(false);
  });

  it('an allowlist that names no one is refused; --clear-allowlist is how to remove it', async () => {
    await hub.run(['hub', 'admin', 'sign-in', 'set', '--allowlist', 'a.com']);
    await expect(hub.run(['hub', 'admin', 'sign-in', 'set', '--allowlist', ' , '])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toContain('--clear-allowlist');
    expect((await board('get', '/v1/admin/auth-config')).body.emailAllowlist).toEqual(['a.com']);
    await hub.run(['hub', 'admin', 'sign-in', 'set', '--clear-allowlist']);
    expect((await board('get', '/v1/admin/auth-config')).body.emailAllowlist).toEqual([]);
  });

  it('refuses a set with nothing to change', async () => {
    await expect(hub.run(['hub', 'admin', 'sign-in', 'set'])).rejects.toThrow(/exit 1/);
  });

  it('passes the hub\'s lockout guard through (turning off the only sign-in method)', async () => {
    await expect(hub.run(['hub', 'admin', 'sign-in', 'set', '--password', 'off'])).rejects.toThrow(/exit 1/);
    expect((await board('get', '/v1/admin/auth-config')).body.passwordEnabled).toBe(true);
  });
});

describe('API keys, invites and CI tokens', () => {
  it('creates an API key (printed once, with the hub\'s warning), lists and revokes it', async () => {
    const created = await hub.json(['hub', 'admin', 'api-keys', 'create', '--label', 'ingest-bot']);
    expect(created.token).toMatch(/^agk_/);
    const keys = await hub.json(['hub', 'admin', 'api-keys', 'list']);
    const k = keys.find((x: any) => x.label === 'ingest-bot');
    expect(k).toBeTruthy();
    await expect(hub.run(['hub', 'admin', 'api-keys', 'revoke', k.tokenHashPreview])).rejects.toThrow(/exit 1/);
    await hub.run(['hub', 'admin', 'api-keys', 'revoke', k.tokenHashPreview, '--yes']);
    expect((await supertest(hub.server).get('/v1/ping').set('Authorization', `Bearer ${created.token}`)).status).toBe(401);
  });

  it('creates an installation invite and prints the join command', async () => {
    hub.clear();
    await hub.run(['hub', 'admin', 'invites', 'create']);
    expect(hub.out()).toMatch(/agenfk hub join \S+ \S+/);
  });

  it('creates, lists and revokes a CI token', async () => {
    const created = await hub.json(['hub', 'admin', 'ci-tokens', 'create', '--label', 'gha', '--scope', 'org']);
    expect(typeof created.token).toBe('string');
    const list = await hub.json(['hub', 'admin', 'ci-tokens', 'list']);
    const t = list.find((x: any) => x.label === 'gha');
    expect(t.scope).toBe('org');
    await hub.run(['hub', 'admin', 'ci-tokens', 'revoke', t.tokenHashPreview, '--yes']);
    const after = await hub.json(['hub', 'admin', 'ci-tokens', 'list']);
    expect(after.find((x: any) => x.label === 'gha').revokedAt).not.toBeNull();
  });

  it('revoking a CI token prefix that matches nothing says nothing was revoked', async () => {
    hub.clear();
    await hub.run(['hub', 'admin', 'ci-tokens', 'revoke', 'deadbeef', '--yes']);
    expect(hub.out()).toMatch(/nothing was revoked/i);
    expect(hub.out()).not.toMatch(/✓ Revoked/);
  });

  it('an installation key still works for the machine that has it (api-keys list does not disturb it)', async () => {
    const key = await issueApiKey(hub.ctx.db, 'org', 'machine');
    await hub.json(['hub', 'admin', 'api-keys', 'list']);
    expect((await supertest(hub.server).get('/v1/ping').set('Authorization', `Bearer ${key}`)).status).toBe(200);
  });
});
