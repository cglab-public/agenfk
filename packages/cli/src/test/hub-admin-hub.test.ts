/**
 * CGLAB-702 S5: the board's Organization, Federation (parent and child hubs)
 * and JIRA integration pages from the command line, against a real hub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import supertest from 'supertest';
import { startAdminHub, AdminHub } from './helpers/adminHub';
import { signInviteToken } from '../../../hub/src/auth/inviteToken';
import { readParentBinding, writeParentBinding } from '../../../hub/src/services/federation/parentBinding';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-admin-hub-')) };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});

let hub: AdminHub;
beforeEach(async () => { hub = await startAdminHub(sandboxHome, 'hubsettings'); });
afterEach(async () => { await hub.close(); });

const board = (method: 'get' | 'post' | 'put' | 'delete', p: string) => (supertest(hub.server) as any)[method](p).set('Cookie', hub.cookie);
const creds = () => JSON.parse(fs.readFileSync(path.join(sandboxHome, '.agenfk', 'hub-admin.json'), 'utf8'));
async function withStdin(text: string, fn: () => Promise<void>): Promise<void> {
  const real = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: Readable.from([text]), configurable: true });
  try { await fn(); } finally { Object.defineProperty(process, 'stdin', real); }
}
async function seedJiraConnection(keyHash: string) {
  await hub.ctx.db.run('INSERT INTO jira_connections (key_hash, org_id, updated_at) VALUES (?, ?, ?)', [keyHash, 'org', new Date().toISOString()]);
}
const jiraConnections = async () => Number((await hub.ctx.db.get("SELECT COUNT(*) AS n FROM jira_connections WHERE org_id = 'org'")).n);
async function addChild(id: string, name: string) {
  const now = new Date().toISOString();
  await hub.ctx.db.run('INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)', [id, 'org', name, now, now]);
}

describe('organization', () => {
  it('renames the org only with --yes, keeps the CLI signed in, and records it in the local credential', async () => {
    await expect(hub.run(['hub', 'admin', 'org', 'rename', 'acme'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toContain('--yes');
    await hub.run(['hub', 'admin', 'org', 'rename', 'acme', '--yes']);
    expect(creds().orgId).toBe('acme');
    const me = await hub.json(['hub', 'admin', 'whoami']);
    expect(me.orgId).toBe('acme');
    // The rename leaves a notice for the operator (the env var to change), which the CLI shows and acknowledges.
    const pending = await hub.json(['hub', 'admin', 'org', 'pending']);
    expect(pending.pendingEnvOrgId).toBe('acme');
    await hub.run(['hub', 'admin', 'org', 'pending-ack']);
    expect((await hub.json(['hub', 'admin', 'org', 'pending'])).pendingEnvOrgId).toBeNull();
  });

  it('refuses an invalid org id with the hub\'s words', async () => {
    await expect(hub.run(['hub', 'admin', 'org', 'rename', 'Not Valid!', '--yes'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/must match/);
  });
});

describe('federation: this hub as a child', () => {
  it('shows that the hub has no parent', async () => {
    expect(await hub.json(['hub', 'admin', 'federation', 'status'])).toMatchObject({ bound: false });
  });

  it('join takes the token from stdin only: a token given as an argument is refused, not ignored', async () => {
    await expect(withStdin('from-stdin', () => hub.run(['hub', 'admin', 'federation', 'join', 'typed-token', '--token-stdin', '--yes']))).rejects.toThrow(/too many arguments/);
    expect(await hub.json(['hub', 'admin', 'federation', 'status'])).toMatchObject({ bound: false });
  });

  it('join needs --yes, reads the token from stdin, and passes the hub\'s refusal of a bad token through', async () => {
    await expect(withStdin('not-a-token', () => hub.run(['hub', 'admin', 'federation', 'join', '--token-stdin']))).rejects.toThrow(/exit 1/);
    expect(hub.err()).toContain('--yes');
    hub.clear();
    await expect(withStdin('not-a-token', () => hub.run(['hub', 'admin', 'federation', 'join', '--token-stdin', '--yes']))).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/hub answered 400/i);
  });

  it('release-request and leave are refused by the hub when there is no parent', async () => {
    await expect(hub.run(['hub', 'admin', 'federation', 'release-request', '--reason', 'moving on'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/no parent/);
    await expect(hub.run(['hub', 'admin', 'federation', 'leave'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toContain('--yes');
  });
});

describe('federation: child hubs of this hub', () => {
  it('creates a child-hub invite and prints its token', async () => {
    const inv = await hub.json(['hub', 'admin', 'child-hubs', 'invite']);
    expect(typeof inv.inviteToken).toBe('string');
    expect(inv.parentUrl).toBe(hub.url);
    hub.clear();
    await hub.run(['hub', 'admin', 'child-hubs', 'invite']);
    expect(hub.out()).toContain('agenfk hub admin federation join');
  });

  it('lists, renames and detaches (with --yes) a child hub', async () => {
    await addChild('child-1', 'Old Name');
    expect((await hub.json(['hub', 'admin', 'child-hubs', 'list'])).map((c: any) => c.id)).toEqual(['child-1']);
    await hub.run(['hub', 'admin', 'child-hubs', 'rename', 'child-1', 'New Name']);
    expect((await hub.json(['hub', 'admin', 'child-hubs', 'list']))[0].name).toBe('New Name');
    await expect(hub.run(['hub', 'admin', 'child-hubs', 'detach', 'child-1'])).rejects.toThrow(/exit 1/);
    await hub.run(['hub', 'admin', 'child-hubs', 'detach', 'child-1', '--yes']);
    expect(await hub.json(['hub', 'admin', 'child-hubs', 'list'])).toEqual([]);
    expect((await hub.json(['hub', 'admin', 'child-hubs', 'list', '--include-detached'])).map((c: any) => c.id)).toEqual(['child-1']);
  });

  it('sets the group identity policy and a child\'s own, and clears the child\'s back to the group\'s', async () => {
    await addChild('child-1', 'One');
    await hub.run(['hub', 'admin', 'federation', 'identity-policy', 'set', 'pseudonymize']);
    // keep (and inherit) can send real identities: confirmation first, nothing changed without it.
    await expect(hub.run(['hub', 'admin', 'child-hubs', 'identity-policy', 'child-1', 'keep'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/cannot be taken back/);
    expect((await hub.json(['hub', 'admin', 'federation', 'identity-policy', 'show'])).childHubs[0].policy).toBeNull();
    await hub.run(['hub', 'admin', 'child-hubs', 'identity-policy', 'child-1', 'keep', '--yes']);
    let p = await hub.json(['hub', 'admin', 'federation', 'identity-policy', 'show']);
    expect(p.groupPolicy).toBe('pseudonymize');
    expect(p.childHubs[0]).toMatchObject({ id: 'child-1', policy: 'keep', effective: 'keep' });
    await expect(hub.run(['hub', 'admin', 'child-hubs', 'identity-policy', 'child-1', 'inherit'])).rejects.toThrow(/exit 1/);
    await hub.run(['hub', 'admin', 'child-hubs', 'identity-policy', 'child-1', 'inherit', '--yes']);
    p = await hub.json(['hub', 'admin', 'federation', 'identity-policy', 'show']);
    expect(p.childHubs[0]).toMatchObject({ policy: null, effective: 'pseudonymize' });
  });

  it('the group policy keep needs --yes; pseudonymize does not', async () => {
    await hub.run(['hub', 'admin', 'federation', 'identity-policy', 'set', 'pseudonymize']);
    await expect(hub.run(['hub', 'admin', 'federation', 'identity-policy', 'set', 'keep'])).rejects.toThrow(/exit 1/);
    expect((await hub.json(['hub', 'admin', 'federation', 'identity-policy', 'show'])).groupPolicy).toBe('pseudonymize');
    await hub.run(['hub', 'admin', 'federation', 'identity-policy', 'set', 'keep', '--yes']);
    expect((await hub.json(['hub', 'admin', 'federation', 'identity-policy', 'show'])).groupPolicy).toBe('keep');
  });

  it('refuses an unknown identity policy before reaching the hub', async () => {
    await expect(hub.run(['hub', 'admin', 'federation', 'identity-policy', 'set', 'erase'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/keep or pseudonymize/);
  });
});

describe('JIRA integration', () => {
  it('shows it unconfigured, sets the app with the secret from stdin, and disconnects everyone with --yes', async () => {
    expect((await hub.json(['hub', 'admin', 'jira', 'show'])).configured).toBe(false);
    await withStdin('jira-secret', () => hub.run(['hub', 'admin', 'jira', 'set', '--client-id', 'cid-1', '--client-secret-stdin']));
    const v = (await board('get', '/v1/admin/jira')).body;
    expect(v).toMatchObject({ configured: true, clientId: 'cid-1' });
    expect(JSON.stringify(v)).not.toContain('jira-secret');
    expect(hub.out() + hub.err()).not.toContain('jira-secret');
    await seedJiraConnection('k1');
    await expect(hub.run(['hub', 'admin', 'jira', 'disconnect-all'])).rejects.toThrow(/exit 1/);
    expect(await jiraConnections()).toBe(1);
    await hub.run(['hub', 'admin', 'jira', 'disconnect-all', '--yes']);
    expect(await jiraConnections()).toBe(0);
  });

  it('replacing a configured app needs --yes, because it disconnects everyone', async () => {
    await withStdin('s1', () => hub.run(['hub', 'admin', 'jira', 'set', '--client-id', 'cid-1', '--client-secret-stdin']));
    await seedJiraConnection('k1');
    await expect(withStdin('s2', () => hub.run(['hub', 'admin', 'jira', 'set', '--client-id', 'cid-2', '--client-secret-stdin']))).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/reconnect/);
    expect((await board('get', '/v1/admin/jira')).body.clientId).toBe('cid-1');
    expect(await jiraConnections()).toBe(1);
    // Re-saving the same app (e.g. a new secret) is not a replacement.
    await withStdin('s1b', () => hub.run(['hub', 'admin', 'jira', 'set', '--client-id', 'cid-1', '--client-secret-stdin']));
    expect(await jiraConnections()).toBe(1);
    await withStdin('s2', () => hub.run(['hub', 'admin', 'jira', 'set', '--client-id', 'cid-2', '--client-secret-stdin', '--yes']));
    expect((await board('get', '/v1/admin/jira')).body.clientId).toBe('cid-2');
    expect(await jiraConnections()).toBe(0);
  });

  it('a new app without a secret is the hub\'s refusal', async () => {
    await expect(hub.run(['hub', 'admin', 'jira', 'set', '--client-id', 'cid-2'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/clientSecret is required/);
  });
});

describe('federation: a whole join, release and leave', () => {
  const PARENT = 'https://parent.example.com';
  let calls: any[];
  let fed: AdminHub;
  beforeEach(async () => {
    await hub.close();
    calls = [];
    // The parent is played by an injected client, as the hub's own federation tests do.
    fed = await startAdminHub(sandboxHome, 'hubfed', {
      federationClient: {
        async enroll(args: any) { calls.push({ enroll: args }); return { token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1', orgId: 'group', parentUrl: args.parentUrl }; },
        async requestRelease(args: any) { calls.push({ release: args }); return { ok: true }; },
      },
    });
    hub = fed;
  });

  it('joins with the token from stdin, requests release with a reason, and leaves once released', async () => {
    const token = signInviteToken({ orgId: 'group', nonce: 'n1', exp: Date.now() + 60_000, kind: 'child-hub', parentUrl: PARENT }, 'parents-own-secret');
    await withStdin(token + '\n', () => fed.run(['hub', 'admin', 'federation', 'join', '--token-stdin', '--yes']));
    expect(calls[0].enroll.parentUrl).toBe(PARENT);
    expect(calls[0].enroll.inviteToken).toBe(token);
    expect(await fed.json(['hub', 'admin', 'federation', 'status'])).toMatchObject({ bound: true, parentUrl: PARENT, childHubId: 'ch-1', canLeave: false });

    await fed.run(['hub', 'admin', 'federation', 'release-request', '--reason', 'moving on']);
    expect(calls.some(c => c.release && JSON.stringify(c.release).includes('moving on'))).toBe(true);
    expect((await fed.json(['hub', 'admin', 'federation', 'status'])).releaseRequested).toBeTruthy();

    // Leaving is the parent's to grant: refused while still a member.
    await expect(fed.run(['hub', 'admin', 'federation', 'leave', '--yes'])).rejects.toThrow(/exit 1/);
    expect((await fed.json(['hub', 'admin', 'federation', 'status'])).bound).toBe(true);
    const current = (await readParentBinding(fed.ctx.db, 'a'.repeat(64)))!;
    await writeParentBinding(fed.ctx.db, 'a'.repeat(64), { ...current, state: 'revoked' });
    await fed.run(['hub', 'admin', 'federation', 'leave', '--yes']);
    expect(await fed.json(['hub', 'admin', 'federation', 'status'])).toMatchObject({ bound: false });
  });
});
