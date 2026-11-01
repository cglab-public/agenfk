/**
 * CGLAB-702 S4: the board's Airlock, Repositories and Models pages from the
 * command line, against a real hub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { startAdminHub, AdminHub } from './helpers/adminHub';
import { issueApiKey } from '../../../hub/src/auth/apiKey';
import { upsertInstallation } from '../../../hub/src/services/installations';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-admin-policies-')) };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});

let hub: AdminHub;
beforeEach(async () => { hub = await startAdminHub(sandboxHome, 'policies'); });
afterEach(async () => { await hub.close(); });

const board = (method: 'get' | 'post' | 'put' | 'delete', p: string) => (supertest(hub.server) as any)[method](p).set('Cookie', hub.cookie);
const tmpFile = (name: string, content: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pol-')), name);
  fs.writeFileSync(f, content);
  return f;
};
const POLICY = {
  schemaVersion: 1,
  mode: 'enforce',
  models: [{ client: 'pi', provider: 'cloudflare-workers-ai' }],
  appliesWhenModelUnknown: true,
  hosts: { allow: ['github.com'], deny: ['evil.example'] },
};

describe('airlock policy', () => {
  it('sets a policy from a file (with --yes), shows it, and round-trips it through --out', async () => {
    await expect(hub.run(['hub', 'admin', 'airlock', 'policy', 'set', '--file', tmpFile('p.json', JSON.stringify(POLICY)), '--expected-revision', '0'])).rejects.toThrow(/exit 1/);
    expect((await board('get', '/v1/admin/airlock')).body.revision).toBe(0);

    await hub.run(['hub', 'admin', 'airlock', 'policy', 'set', '--file', tmpFile('p.json', JSON.stringify(POLICY)), '--expected-revision', '0', '--yes']);
    const shown = await hub.json(['hub', 'admin', 'airlock', 'policy', 'show']);
    expect(shown.revision).toBe(1);
    expect(shown.policy.hosts.allow).toEqual(['github.com']);

    // --out writes { revision, policy }; set reads the revision from the file.
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pol-out-')), 'policy.json');
    await hub.run(['hub', 'admin', 'airlock', 'policy', 'show', '--out', out]);
    const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(saved.revision).toBe(1);
    saved.policy.hosts.allow.push('npmjs.org');
    fs.writeFileSync(out, JSON.stringify(saved));
    await hub.run(['hub', 'admin', 'airlock', 'policy', 'set', '--file', out, '--yes']);
    expect((await board('get', '/v1/admin/airlock')).body.policy.hosts.allow).toEqual(['github.com', 'npmjs.org']);
  });

  it('a stale revision is the hub\'s conflict, not an overwrite', async () => {
    await board('put', '/v1/admin/airlock').send({ policy: POLICY, expectedRevision: 0 });
    await board('put', '/v1/admin/airlock').send({ policy: { ...POLICY, mode: 'observe' }, expectedRevision: 1 });
    await expect(hub.run(['hub', 'admin', 'airlock', 'policy', 'set', '--file', tmpFile('p.json', JSON.stringify(POLICY)), '--expected-revision', '1', '--yes'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/409|revision/i);
    expect((await board('get', '/v1/admin/airlock')).body.policy.mode).toBe('observe');
  });

  it('a set with neither --expected-revision nor a revision in the file is refused before reaching the hub', async () => {
    await expect(hub.run(['hub', 'admin', 'airlock', 'policy', 'set', '--file', tmpFile('p.json', JSON.stringify(POLICY)), '--yes'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toContain('--expected-revision');
  });

  it('sets the IOC host list from a file of one host per line', async () => {
    await board('put', '/v1/admin/airlock').send({ policy: POLICY, expectedRevision: 0 });
    await hub.run(['hub', 'admin', 'airlock', 'ioc', 'set', '--file', tmpFile('ioc.txt', 'bad.example\n# a comment\n\nworse.example\n'), '--yes']);
    expect((await board('get', '/v1/admin/airlock')).body.policy.iocHosts.hosts).toEqual(['bad.example', 'worse.example']);
  });

  it('lists installations, history and decisions, and refuses an unknown filter value as the hub does', async () => {
    await board('put', '/v1/admin/airlock').send({ policy: POLICY, expectedRevision: 0 });
    expect(await hub.json(['hub', 'admin', 'airlock', 'installations'])).toBeTruthy();
    const history = await hub.json(['hub', 'admin', 'airlock', 'history', '--limit', '5']);
    expect(history.entries.length).toBeGreaterThan(0);
    expect(history).toHaveProperty('next');
    const decisions = await hub.json(['hub', 'admin', 'airlock', 'decisions', '--mode', 'enforce']);
    expect(decisions).toEqual({ decisions: [], next: null });
    await expect(hub.run(['hub', 'admin', 'airlock', 'decisions', '--mode', 'bogus'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/known values/);
  });

  it('turns the dataset on and off (off needs --yes) and exports it to a file', async () => {
    await hub.run(['hub', 'admin', 'airlock', 'dataset', 'on']);
    expect((await board('get', '/v1/admin/airlock/dataset')).body.enabled).toBe(true);
    await expect(hub.run(['hub', 'admin', 'airlock', 'dataset', 'off'])).rejects.toThrow(/exit 1/);
    await hub.run(['hub', 'admin', 'airlock', 'dataset', 'off', '--yes']);
    expect((await board('get', '/v1/admin/airlock/dataset')).body.enabled).toBe(false);
    const now = new Date().toISOString();
    for (const [id, kind] of [['e1', 'row'], ['e2', 'label']]) {
      await hub.ctx.db.run(
        `INSERT INTO airlock_dataset (org_id, event_id, kind, row_id, installation_id, user_key, occurred_at, received_at, imported, payload_json)
         VALUES ('org', ?, ?, 'r1', 'i', 'u', ?, ?, 0, '{"host":"github.com"}')`, [id, kind, now, now]);
    }
    const fromHub = (await board('get', '/v1/admin/airlock/dataset/export').buffer(true).parse((res: any, cb: any) => {
      let d = ''; res.on('data', (c: any) => { d += c; }); res.on('end', () => cb(null, d));
    })).body as string;
    expect(fromHub).toContain('github.com');
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ds-')), 'ds.jsonl');
    await hub.run(['hub', 'admin', 'airlock', 'dataset', 'export', '--out', out]);
    expect(fs.readFileSync(out, 'utf8')).toBe(fromHub);
    const written: string[] = [];
    (process.stdout.write as any).mockImplementation((c: any) => { written.push(String(c)); return true; });
    await hub.run(['hub', 'admin', 'airlock', 'dataset', 'export']);
    expect(written.join('')).toBe(fromHub);
  });

  it('lists learning proposals and passes the hub\'s refusal of a host it did not propose', async () => {
    await board('put', '/v1/admin/airlock').send({ policy: POLICY, expectedRevision: 0 });
    const learning = await hub.json(['hub', 'admin', 'airlock', 'learning', 'list']);
    expect(learning).toMatchObject({ revision: 1, hosts: [] });
    await expect(hub.run(['hub', 'admin', 'airlock', 'learning', 'accept', 'nope.example', '--expected-revision', '1', '--yes'])).rejects.toThrow(/exit 1/);
  });

  it('accepting proposals needs the revision they were reviewed at; it is never re-read behind the admin\'s back', async () => {
    await board('put', '/v1/admin/airlock').send({ policy: POLICY, expectedRevision: 0 });
    // An installation proposes npmjs.org, as the board's Learning list would show it.
    const key = await issueApiKey(hub.ctx.db, 'org', 'laptop', { installationId: 'inst-l' });
    const sent = await supertest(hub.server).post('/v1/events').set('Authorization', `Bearer ${key}`).send({ events: [{
      eventId: 'ev-learn-1', installationId: 'inst-l', orgId: 'org', occurredAt: new Date(Date.now() - 60_000).toISOString(),
      actor: { osUser: 't', gitName: null, gitEmail: 'inst-l@x' }, type: 'airlock.learning-proposal',
      payload: { hosts: [{ host: 'npmjs.org', hits: 3, sources: { tool: 3, proxy: 0, import: 0 }, evidence: 'agent-reported',
        clients: ['pi'], firstSeen: '2026-10-20T10:00:00.000Z', lastSeen: '2026-10-27T10:00:00.000Z', cardCount: 1 }] },
    }] });
    expect(sent.status).toBeLessThan(300);
    const listed = await hub.json(['hub', 'admin', 'airlock', 'learning', 'list']);
    expect(listed.hosts.map((h: any) => h.host)).toContain('npmjs.org');
    const reviewedAt = String(listed.revision);

    await expect(hub.run(['hub', 'admin', 'airlock', 'learning', 'accept', 'npmjs.org', '--yes'])).rejects.toThrow();
    // The policy moves on after the review: accepting at the reviewed revision is the hub's 409, not a silent re-read.
    await board('put', '/v1/admin/airlock').send({ policy: { ...POLICY, mode: 'observe' }, expectedRevision: Number(reviewedAt) });
    hub.clear();
    await expect(hub.run(['hub', 'admin', 'airlock', 'learning', 'accept', 'npmjs.org', '--expected-revision', reviewedAt, '--yes'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/409/);
    const after = (await board('get', '/v1/admin/airlock')).body;
    expect(after.revision).toBe(Number(reviewedAt) + 1);
    expect(after.policy.hosts.allow).not.toContain('npmjs.org');
    // At the current revision it goes through.
    await hub.run(['hub', 'admin', 'airlock', 'learning', 'accept', 'npmjs.org', '--expected-revision', String(after.revision), '--yes']);
    expect((await board('get', '/v1/admin/airlock')).body.policy.hosts.allow).toContain('npmjs.org');
  });
});

describe('repositories', () => {
  const REPO = 'https://github.com/acme/app.git';
  beforeEach(async () => {
    await upsertInstallation(hub.ctx.db, 'org', { installationId: 'inst-a', osUser: 'a', gitName: 'A', gitEmail: 'a@x' });
    const key = await issueApiKey(hub.ctx.db, 'org', 'a', { installationId: 'inst-a' });
    const init = await supertest(hub.server).post('/v1/repo-settings/init').set('Authorization', `Bearer ${key}`).send({ repo: REPO, verifyCommand: 'npm test' });
    expect(init.status).toBeLessThan(300);
  });

  it('lists repositories and their revisions', async () => {
    const repos = await hub.json(['hub', 'admin', 'repos', 'list']);
    expect(repos).toHaveLength(1);
    expect(repos[0].verifyCommand).toBe('npm test');
    const revs = await hub.json(['hub', 'admin', 'repos', 'revisions', '--repo', REPO]);
    expect(revs.length).toBeGreaterThan(0);
    expect(Array.isArray(await hub.json(['hub', 'admin', 'repos', 'receipts', '--repo', REPO]))).toBe(true);
  });

  it('changes the verify command (with --yes), the receipts mode and the producer rules', async () => {
    await expect(hub.run(['hub', 'admin', 'repos', 'set-command', '--repo', REPO, '--command', 'npm run ci'])).rejects.toThrow(/exit 1/);
    await hub.run(['hub', 'admin', 'repos', 'set-command', '--repo', REPO, '--command', 'npm run ci', '--yes']);
    await hub.run(['hub', 'admin', 'repos', 'set-mode', '--repo', REPO, '--mode', 'shadow', '--shadow-threshold', '3']);
    await hub.run(['hub', 'admin', 'repos', 'producer-mode', '--repo', REPO, '--mode', 'listed']);
    await expect(hub.run(['hub', 'admin', 'repos', 'producer-mode', '--repo', REPO, '--mode', 'all'])).rejects.toThrow(/exit 1/);
    expect((await hub.json(['hub', 'admin', 'repos', 'list']))[0].producerMode).toBe('listed');
    await hub.run(['hub', 'admin', 'repos', 'producer', 'allow', '--repo', REPO, '--installation', 'inst-a']);
    let r = (await hub.json(['hub', 'admin', 'repos', 'list']))[0];
    expect(r).toMatchObject({ verifyCommand: 'npm run ci', receiptsMode: 'shadow', shadowThreshold: 3, producerMode: 'listed', producers: ['inst-a'] });
    await hub.run(['hub', 'admin', 'repos', 'producer', 'deny', '--repo', REPO, '--installation', 'inst-a']);
    r = (await hub.json(['hub', 'admin', 'repos', 'list']))[0];
    expect(r.producers).toEqual([]);
  });

  it('under producer mode all, deny says the installation is still trusted instead of claiming a revocation', async () => {
    await hub.run(['hub', 'admin', 'repos', 'producer-mode', '--repo', REPO, '--mode', 'all', '--yes']);
    hub.clear();
    await hub.run(['hub', 'admin', 'repos', 'producer', 'deny', '--repo', REPO, '--installation', 'inst-a']);
    expect(hub.out()).toMatch(/trusts EVERY live installation/);
    expect(hub.out()).not.toMatch(/may no longer/);
  });

  it('enforce mode needs --yes (it can block merges)', async () => {
    await expect(hub.run(['hub', 'admin', 'repos', 'set-mode', '--repo', REPO, '--mode', 'enforce', '--shadow-threshold', '2'])).rejects.toThrow(/exit 1/);
    expect((await hub.json(['hub', 'admin', 'repos', 'list']))[0].receiptsMode).not.toBe('enforce');
    await hub.run(['hub', 'admin', 'repos', 'set-mode', '--repo', REPO, '--mode', 'enforce', '--shadow-threshold', '2', '--yes']);
    expect((await hub.json(['hub', 'admin', 'repos', 'list']))[0].receiptsMode).toBe('enforce');
  });
});

describe('models', () => {
  it('maps an alias to a canonical model and unmaps it', async () => {
    await hub.run(['hub', 'admin', 'models', 'map', 'opus-latest', 'claude-opus-5-5']);
    let m = await hub.json(['hub', 'admin', 'models', 'list']);
    expect(m.mappings.map((x: any) => [x.aliasModel, x.canonicalModel])).toEqual([['opus-latest', 'claude-opus-5-5']]);
    await hub.run(['hub', 'admin', 'models', 'unmap', 'opus-latest']);
    m = await hub.json(['hub', 'admin', 'models', 'list']);
    expect(m.mappings).toEqual([]);
  });

  it('sets and deletes model metadata', async () => {
    await hub.run(['hub', 'admin', 'models', 'meta', 'set', 'my-model', '--provider', 'acme', '--license-class', 'open_weights', '--license', 'Apache-2.0']);
    let m = await hub.json(['hub', 'admin', 'models', 'list']);
    expect(m.meta.find((x: any) => x.model === 'my-model')).toMatchObject({ provider: 'acme', licenseClass: 'open_weights', license: 'Apache-2.0' });
    await hub.run(['hub', 'admin', 'models', 'meta', 'delete', 'my-model']);
    m = await hub.json(['hub', 'admin', 'models', 'list']);
    expect(m.meta.find((x: any) => x.model === 'my-model' && x.source === 'admin')).toBeUndefined();
  });

  it('a model id holding % is unmapped exactly (no second decoding on the hub)', async () => {
    await board('post', '/v1/admin/models/mappings').send({ aliasModel: 'a%41', canonicalModel: 'x' });
    await board('post', '/v1/admin/models/mappings').send({ aliasModel: 'aA', canonicalModel: 'y' });
    await hub.run(['hub', 'admin', 'models', 'unmap', 'a%41']);
    const m = await hub.json(['hub', 'admin', 'models', 'list']);
    expect(m.mappings.map((x: any) => x.aliasModel)).toEqual(['aA']);
  });
});
