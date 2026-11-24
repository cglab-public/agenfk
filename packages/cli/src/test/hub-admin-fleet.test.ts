/**
 * CGLAB-702 S3: the board's Flows, Upgrades and Address change pages from the
 * command line, against a real hub. Release lookups are stubbed in the hub's
 * own config (releaseExists) so nothing reaches GitHub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import supertest from 'supertest';
import { startAdminHub, AdminHub } from './helpers/adminHub';
import { upsertInstallation } from '../../../hub/src/services/installations';
import { ORG_REPO, COMMUNITY_FLOWS, githubFake } from '../../../hub/src/test/helpers/githubFake';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-admin-fleet-')) };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});

let hub: AdminHub;
beforeEach(async () => {
  hub = await startAdminHub(sandboxHome, 'fleet', { releaseExists: async (v: string) => v === '9.9.9' });
});
afterEach(async () => { vi.unstubAllGlobals(); await hub.close(); });

const board = (method: 'get' | 'post' | 'put' | 'delete', p: string) => (supertest(hub.server) as any)[method](p).set('Cookie', hub.cookie);
const definition = (name = 'CLI Flow') => ({
  name, description: 'made from the CLI',
  steps: [
    { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
    { id: 's1', name: 'work', label: 'Working', order: 1, exitCriteria: 'Code compiles' },
    { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
  ],
});
function defFile(def: unknown): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-flowdef-')), 'flow.json');
  fs.writeFileSync(f, JSON.stringify(def));
  return f;
}
async function withStdin(text: string, fn: () => Promise<void>): Promise<void> {
  const real = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: Readable.from([text]), configurable: true });
  try { await fn(); } finally { Object.defineProperty(process, 'stdin', real); }
}

describe('flows', () => {
  it('creates a flow from a JSON file, lists it, gets its definition, and deletes it with --yes', async () => {
    const created = await hub.json(['hub', 'admin', 'flows', 'create', '--file', defFile(definition())]);
    expect(created.name).toBe('CLI Flow');
    const list = await hub.json(['hub', 'admin', 'flows', 'list']);
    expect(list.map((f: any) => f.id)).toContain(created.id);
    const got = await hub.json(['hub', 'admin', 'flows', 'get', created.id]);
    expect(got.definition.steps).toHaveLength(3);

    await expect(hub.run(['hub', 'admin', 'flows', 'delete', created.id])).rejects.toThrow(/exit 1/);
    await hub.run(['hub', 'admin', 'flows', 'delete', created.id, '--yes']);
    expect((await board('get', `/v1/admin/flows/${created.id}`)).status).toBe(404);
  });

  it('accepts a file that is the definition itself or an exported flow wrapping it', async () => {
    const a = await hub.json(['hub', 'admin', 'flows', 'create', '--file', defFile({ definition: definition('Wrapped') })]);
    expect(a.name).toBe('Wrapped');
  });

  it('`get` can write the definition to a file that `update` reads back', async () => {
    const created = await hub.json(['hub', 'admin', 'flows', 'create', '--file', defFile(definition())]);
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-flowget-')), 'f.json');
    await hub.run(['hub', 'admin', 'flows', 'get', created.id, '--out', out]);
    const def = JSON.parse(fs.readFileSync(out, 'utf8'));
    def.description = 'edited';
    fs.writeFileSync(out, JSON.stringify(def));
    // Replacing a definition changes every scope that runs the flow: confirmation first.
    await expect(hub.run(['hub', 'admin', 'flows', 'update', created.id, '--file', out])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toContain('--yes');
    expect((await board('get', `/v1/admin/flows/${created.id}`)).body.definition.description).toBe('made from the CLI');
    await hub.run(['hub', 'admin', 'flows', 'update', created.id, '--file', out, '--yes']);
    expect((await board('get', `/v1/admin/flows/${created.id}`)).body.definition.description).toBe('edited');
  });

  it('reports the hub\'s validation error for a bad definition, and a missing file clearly', async () => {
    await expect(hub.run(['hub', 'admin', 'flows', 'create', '--file', defFile({ name: 'Bad', steps: [] })])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/hub answered 400/i);
    hub.clear();
    await expect(hub.run(['hub', 'admin', 'flows', 'create', '--file', '/nope/flow.json'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/flow\.json/);
  });

  it('makes a flow available to the org and back', async () => {
    const created = await hub.json(['hub', 'admin', 'flows', 'create', '--file', defFile(definition())]);
    await hub.run(['hub', 'admin', 'flows', 'available', created.id, 'on']);
    expect((await board('get', `/v1/admin/flows/${created.id}`)).body.orgAvailable).toBe(true);
    await hub.run(['hub', 'admin', 'flows', 'available', created.id, 'off']);
    expect((await board('get', `/v1/admin/flows/${created.id}`)).body.orgAvailable).toBe(false);
  });

  it('shows the default flow and describes a contract', async () => {
    const def = await hub.json(['hub', 'admin', 'flows', 'default']);
    expect(Array.isArray(def.steps ?? def.definition?.steps)).toBe(true);
    const contract = await hub.json(['hub', 'admin', 'flows', 'contract', '--file', defFile(definition())]);
    expect(contract).toBeTruthy();
  });

  it('assigns a flow to the org and clears the assignment', async () => {
    const created = await hub.json(['hub', 'admin', 'flows', 'create', '--file', defFile(definition())]);
    await expect(hub.run(['hub', 'admin', 'flows', 'assign', '--scope', 'org', '--flow', created.id])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toContain('--yes');
    expect((await board('get', '/v1/admin/flow-assignments')).body).toEqual([]);
    await hub.run(['hub', 'admin', 'flows', 'assign', '--scope', 'org', '--flow', created.id, '--yes']);
    let rows = await hub.json(['hub', 'admin', 'flows', 'assignments']);
    expect(rows.find((r: any) => r.scope === 'org').flowId).toBe(created.id);
    await hub.run(['hub', 'admin', 'flows', 'assign', '--scope', 'org', '--flow', 'none', '--yes']);
    rows = await hub.json(['hub', 'admin', 'flows', 'assignments']);
    expect(rows.find((r: any) => r.scope === 'org' && r.flowId)).toBeUndefined();
  });

  it('a non-org assignment without --target is refused before reaching the hub', async () => {
    await expect(hub.run(['hub', 'admin', 'flows', 'assign', '--scope', 'repo', '--flow', 'x'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toContain('--target');
  });

  it('shows the registry configuration and lists dispatches (none yet)', async () => {
    const cfg = await hub.json(['hub', 'admin', 'flows', 'registry', 'show']);
    expect(cfg).toHaveProperty('repo');
    expect(cfg).toHaveProperty('isPublic');
    const d = await hub.json(['hub', 'admin', 'flows', 'dispatches']);
    expect(d).toEqual([]);
  });

  it('refuses a registry token on the command line: it is read from stdin only', async () => {
    await expect(hub.run(['hub', 'admin', 'flows', 'registry', 'set', '--repo', 'acme/flows', '--token', 'ghp_x'])).rejects.toThrow();
  });

  it('points the registry at an org repo with the token from stdin (only with --yes), reports the copy, then syncs and installs', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    await expect(withStdin('ghp_tok', () => hub.run(['hub', 'admin', 'flows', 'registry', 'set', '--repo', ORG_REPO, '--token-stdin']))).rejects.toThrow(/exit 1/);
    expect((await board('get', '/v1/admin/registry-config')).body.isPublic).toBe(true);
    expect(gh.calls).toHaveLength(0);

    hub.clear();
    await withStdin('ghp_tok\n', () => hub.run(['hub', 'admin', 'flows', 'registry', 'set', '--repo', ORG_REPO, '--token-stdin', '--yes']));
    const cfg = (await board('get', '/v1/admin/registry-config')).body;
    expect(cfg.repo).toBe(ORG_REPO);
    expect(cfg.hasToken).toBe(true);
    // The token from stdin is what the hub used on GitHub.
    expect(gh.calls.some(c => c.url.includes(ORG_REPO) && String(c.auth).includes('ghp_tok'))).toBe(true);
    expect(hub.out()).toContain(`Copied ${COMMUNITY_FLOWS.length} community flow`);
    expect(hub.out() + hub.err()).not.toContain('ghp_tok');

    hub.clear();
    await hub.run(['hub', 'admin', 'flows', 'registry', 'sync']);
    expect(hub.out()).toMatch(/Copied 0 community flow.*already there/);

    const listed = await hub.json(['hub', 'admin', 'flows', 'registry', 'list']);
    expect(listed.map((f: any) => f.filename)).toContain('tdd-flow.json');
    await hub.run(['hub', 'admin', 'flows', 'registry', 'install', 'tdd-flow.json']);
    expect((await board('get', '/v1/admin/flows')).body.map((f: any) => f.name)).toContain('TDD Flow');
  });

  it('a registry copy that fails part-way is reported, with the way to finish it', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    const flaky = vi.fn(async (url: string, init?: any) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'PUT' && url.includes('lean-flow')) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
      return gh.fn(url, init);
    });
    vi.stubGlobal('fetch', flaky);
    hub.clear();
    await withStdin('ghp_tok', () => hub.run(['hub', 'admin', 'flows', 'registry', 'set', '--repo', ORG_REPO, '--token-stdin', '--yes']));
    expect(hub.out()).toMatch(/could not be copied: .*lean-flow/);
    expect(hub.out()).toContain('registry sync');
  });

  it('dispatches a flow to selected child hubs, or to all of them (said to include future hubs), and cancels with --yes', async () => {
    const now = new Date().toISOString();
    await hub.ctx.db.run('INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)', ['child-1', 'org', 'Child One', now, now]);
    const created = await hub.json(['hub', 'admin', 'flows', 'create', '--file', defFile(definition())]);

    await expect(hub.run(['hub', 'admin', 'flows', 'dispatch', created.id])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/future child hub/);
    expect(await hub.json(['hub', 'admin', 'flows', 'dispatches'])).toEqual([]);

    const sel = await hub.json(['hub', 'admin', 'flows', 'dispatch', created.id, '--child', 'child-1', '--yes']);
    expect(sel.scope).toBe('selected');
    hub.clear();
    await hub.run(['hub', 'admin', 'flows', 'dispatch', created.id, '--yes']);
    expect(hub.out()).toMatch(/future child hub/);
    const list = await hub.json(['hub', 'admin', 'flows', 'dispatches']);
    expect(list.map((d: any) => d.scope).sort()).toEqual(['all', 'selected']);

    await expect(hub.run(['hub', 'admin', 'flows', 'dispatch-cancel', sel.id])).rejects.toThrow(/exit 1/);
    await hub.run(['hub', 'admin', 'flows', 'dispatch-cancel', sel.id, '--yes']);
    const after = await hub.json(['hub', 'admin', 'flows', 'dispatches']);
    expect(after.find((d: any) => d.id === sel.id).cancelledAt).not.toBeNull();
  });

  it('a flow dispatch to selected hubs that are not in the group passes the hub\'s refusal through', async () => {
    const created = await hub.json(['hub', 'admin', 'flows', 'create', '--file', defFile(definition())]);
    await expect(hub.run(['hub', 'admin', 'flows', 'dispatch', created.id, '--child', 'nope', '--yes'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/not in this group|detached/);
  });
});

describe('upgrades', () => {
  beforeEach(async () => {
    await upsertInstallation(hub.ctx.db, 'org', { installationId: 'inst-1', osUser: 'dev', gitName: 'Dev', gitEmail: 'dev@x' });
    await upsertInstallation(hub.ctx.db, 'org', { installationId: 'inst-2', osUser: 'dev2', gitName: 'Dev2', gitEmail: 'dev2@x' });
  });

  it('starts an upgrade for selected installations only with --yes, lists it, and cancels it', async () => {
    await expect(hub.run(['hub', 'admin', 'upgrades', 'start', '9.9.9', '--installation', 'inst-1'])).rejects.toThrow(/exit 1/);
    expect((await board('get', '/v1/admin/upgrade')).body.directives).toHaveLength(0);

    const started = await hub.json(['hub', 'admin', 'upgrades', 'start', '9.9.9', '--installation', 'inst-1', '--yes']);
    const directiveId = started.directiveId ?? started.id;
    const list = await hub.json(['hub', 'admin', 'upgrades', 'list']);
    expect(list).toHaveLength(1);
    expect(list[0].targetVersion).toBe('9.9.9');
    expect(list[0].targets.map((t: any) => t.installationId)).toEqual(['inst-1']);

    await hub.run(['hub', 'admin', 'upgrades', 'cancel', directiveId, '--yes']);
    const after = (await board('get', '/v1/admin/upgrade')).body.directives[0];
    expect(after.targets.every((t: any) => t.state === 'cancelled')).toBe(true);
  });

  it('--installation given twice targets both (and not the rest of the fleet); none targets the whole fleet', async () => {
    await upsertInstallation(hub.ctx.db, 'org', { installationId: 'inst-3', osUser: 'dev3', gitName: 'Dev3', gitEmail: 'dev3@x' });
    await hub.json(['hub', 'admin', 'upgrades', 'start', '9.9.9', '--installation', 'inst-1', '--installation', 'inst-2', '--yes']);
    let d = (await board('get', '/v1/admin/upgrade')).body.directives[0];
    expect(d.scope.type).toBe('installations');
    expect(d.targets.map((t: any) => t.installationId).sort()).toEqual(['inst-1', 'inst-2']);
    await hub.run(['hub', 'admin', 'upgrades', 'cancel', d.directiveId, '--yes']);
    await hub.json(['hub', 'admin', 'upgrades', 'start', '9.9.9', '--yes']);
    d = (await board('get', '/v1/admin/upgrade')).body.directives.find((x: any) => x.scope.type === 'all');
    expect(d).toBeTruthy();
  });

  it('a release that does not exist is the hub\'s refusal, verbatim', async () => {
    await expect(hub.run(['hub', 'admin', 'upgrades', 'start', '1.2.3', '--yes'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/1\.2\.3 not found/);
  });

  it('cancelling says how many installations are still upgrading and were left alone', async () => {
    const started = await hub.json(['hub', 'admin', 'upgrades', 'start', '9.9.9', '--installation', 'inst-1', '--installation', 'inst-2', '--yes']);
    await hub.ctx.db.run("UPDATE upgrade_directive_targets SET state = 'in_progress' WHERE installation_id = 'inst-2'");
    hub.clear();
    await hub.run(['hub', 'admin', 'upgrades', 'cancel', started.directiveId, '--yes']);
    expect(hub.out()).toMatch(/Cancelled 1 pending/);
    expect(hub.out()).toMatch(/1 installation\(s\) are still upgrading/);
    expect(hub.out()).not.toContain('[object Object]');
  });

  it('a forced cancel counts each installation once', async () => {
    const started = await hub.json(['hub', 'admin', 'upgrades', 'start', '9.9.9', '--installation', 'inst-1', '--installation', 'inst-2', '--yes']);
    await hub.ctx.db.run("UPDATE upgrade_directive_targets SET state = 'in_progress' WHERE installation_id = 'inst-2'");
    hub.clear();
    await hub.run(['hub', 'admin', 'upgrades', 'cancel', started.directiveId, '--force', '--yes']);
    expect(hub.out()).toMatch(/Cancelled 1 pending target\(s\), and force-cancelled 1 in progress/);
  });

  it('dispatches a group upgrade to a child hub, carrying --confirm-downgrade, and cancels it with --yes', async () => {
    const now = new Date().toISOString();
    await hub.ctx.db.run('INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)', ['child-1', 'org', 'Child One', now, now]);
    await expect(hub.run(['hub', 'admin', 'upgrades', 'dispatch', '9.9.9', '--child', 'child-1'])).rejects.toThrow(/exit 1/);
    const d = await hub.json(['hub', 'admin', 'upgrades', 'dispatch', '9.9.9', '--child', 'child-1', '--confirm-downgrade', '--yes']);
    expect(d).toMatchObject({ targetVersion: '9.9.9', scope: 'selected', confirmDowngrade: true });
    await expect(hub.run(['hub', 'admin', 'upgrades', 'dispatch-cancel', d.id])).rejects.toThrow(/exit 1/);
    await hub.run(['hub', 'admin', 'upgrades', 'dispatch-cancel', d.id, '--yes']);
    const list = await hub.json(['hub', 'admin', 'upgrades', 'dispatches']);
    expect(list.find((x: any) => x.id === d.id).cancelledAt).not.toBeNull();
  });

  it('lists group upgrade dispatches (none yet)', async () => {
    expect(await hub.json(['hub', 'admin', 'upgrades', 'dispatches'])).toEqual([]);
  });
});

describe('address change (repoint)', () => {
  it('shows no campaign, starts one with --yes, shows it, and closes it with --yes', async () => {
    await upsertInstallation(hub.ctx.db, 'org', { installationId: 'inst-1', osUser: 'dev', gitName: 'Dev', gitEmail: 'dev@x' });
    expect((await hub.json(['hub', 'admin', 'repoint', 'status'])).campaign).toBeNull();
    await expect(hub.run(['hub', 'admin', 'repoint', 'start', 'https://new-hub.example.com'])).rejects.toThrow(/exit 1/);
    await hub.run(['hub', 'admin', 'repoint', 'start', 'https://new-hub.example.com', '--yes']);
    const st = await hub.json(['hub', 'admin', 'repoint', 'status']);
    expect(st.campaign.targetUrl).toBe('https://new-hub.example.com');
    expect(st.targets.map((t: any) => t.installationId)).toEqual(['inst-1']);
    await hub.run(['hub', 'admin', 'repoint', 'close', st.campaign.id, '--yes']);
    expect((await hub.json(['hub', 'admin', 'repoint', 'status'])).campaign).toBeNull();
  });

  it('passes the hub\'s refusal of a non-https target through', async () => {
    await expect(hub.run(['hub', 'admin', 'repoint', 'start', 'http://new-hub.example.com', '--yes'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/https/);
  });
});
