/**
 * CGLAB-702 S6: the read side - the audit log, the fleet's events and the
 * board's charts as data - plus the rollup repair, against a real hub. Each
 * query is checked against what the board itself gets for the same filters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { startAdminHub, AdminHub } from './helpers/adminHub';
import { issueApiKey } from '../../../hub/src/auth/apiKey';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-admin-data-')) };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});

let hub: AdminHub;
const board = (p: string) => supertest(hub.server).get(p).set('Cookie', hub.cookie);

const pr = (n: number, email: string, model: string, at: string) => ({
  eventId: `e-${n}-${email}`,
  installationId: 'inst-1',
  orgId: 'org',
  occurredAt: at,
  actor: { osUser: 'dev', gitName: 'Dev', gitEmail: email },
  type: 'pr.opened',
  remoteUrl: 'git@github.com:acme/api.git',
  payload: { prNumber: n, repo: 'acme/api', model, harness: 'pi', sizing: { epic: 0, story: 0, task: 1, bug: 0 }, sizingShadow: { epic: 0, story: 0, task: 1, bug: 0 }, leafStory: 0 },
});

beforeEach(async () => {
  hub = await startAdminHub(sandboxHome, 'data');
  const key = await issueApiKey(hub.ctx.db, 'org', 'machine', { installationId: 'inst-1' });
  const r = await supertest(hub.server).post('/v1/events').set('Authorization', `Bearer ${key}`).send({ events: [
    pr(1, 'alice@acme.com', 'model-a', '2026-10-01T10:00:00Z'),
    pr(2, 'alice@acme.com', 'model-b', '2026-10-02T10:00:00Z'),
    pr(3, 'bob@acme.com', 'model-a', '2026-10-03T10:00:00Z'),
  ] });
  expect(r.status).toBeLessThan(300);
});
afterEach(async () => { await hub.close(); });

describe('events and fleet data', () => {
  it('`events` lists the timeline, filtered by user and time, the same as the board', async () => {
    const all = await hub.json(['hub', 'admin', 'events']);
    expect(all.events).toHaveLength(3);
    const alice = await hub.json(['hub', 'admin', 'events', '--users', 'alice@acme.com', '--from', '2026-10-02']);
    const boardAlice = (await board('/v1/timeline?users=alice%40acme.com&from=2026-10-02')).body;
    expect(alice).toEqual(boardAlice);
    expect(alice.events).toHaveLength(1);
  });

  it('`data <query>` returns each board query with the same filters', async () => {
    for (const [cmd, route] of [
      ['metrics', '/v1/metrics'], ['adherence', '/v1/adherence'], ['item-types', '/v1/item-types'], ['users', '/v1/users'],
      ['child-hubs', '/v1/child-hubs'], ['prs', '/v1/prs/overview'], ['histogram', '/v1/histogram'],
      ['timeline', '/v1/timeline'],
    ] as const) {
      const fromCli = await hub.json(['hub', 'admin', 'data', cmd, '--from', '2026-10-02']);
      expect(fromCli, cmd).toEqual((await board(`${route}?from=2026-10-02`)).body);
    }
    for (const [cmd, route] of [['people', '/v1/people/names'], ['projects', '/v1/projects'], ['event-types', '/v1/event-types']]) {
      expect(await hub.json(['hub', 'admin', 'data', cmd]), cmd).toEqual((await board(route)).body);
    }
  });

  it('a filter the route parses but does not apply is refused too', async () => {
    for (const args of [
      ['projects', '--users', 'nobody'], ['event-types', '--types', 'x'], ['item-types', '--item-types', 'TASK'],
      ['child-hubs', '--users', 'nobody'], ['users', '--users', 'nobody'], ['prs', '--types', 'pr.opened'],
    ]) {
      hub.clear();
      await expect(hub.run(['hub', 'admin', 'data', ...args]), args.join(' ')).rejects.toThrow(/exit 1/);
      expect(hub.err(), args.join(' ')).toMatch(new RegExp(`${args[0]} does not read ${args[1]}`));
    }
    // ...and what they do apply still goes through.
    expect(await hub.json(['hub', 'admin', 'data', 'projects', '--child-hub', 'x'])).toEqual((await board('/v1/projects?childHubId=x')).body);
    // A selected child hub with no events in the window is still listed, as on the board.
    const now = new Date().toISOString();
    await hub.ctx.db.run('INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)', ['quiet-1', 'org', 'Quiet', now, now]);
    const picked = await hub.json(['hub', 'admin', 'data', 'child-hubs', '--child-hub', 'quiet-1']);
    expect(picked).toEqual((await board('/v1/child-hubs?childHubId=quiet-1')).body);
    expect(picked.childHubs.map((c: any) => c.id)).toContain('quiet-1');
  });

  it('a filter the query does not read is refused, never silently dropped', async () => {
    await expect(hub.run(['hub', 'admin', 'data', 'histogram', '--model', 'model-a'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/histogram does not read --model/);
    hub.clear();
    await expect(hub.run(['hub', 'admin', 'data', 'people', '--limit', '1'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/people does not read --limit; it takes no filters/);
  });

  it('every filter reaches the hub under the board\'s own name (each would change the answer if dropped)', async () => {
    const cases: Array<[string[], string, number]> = [
      [['--users', 'nobody@x'], 'users=nobody%40x', 0],
      [['--types', 'nope.type'], 'types=nope.type', 0],
      [['--projects', 'git@github.com:no/such.git'], 'projects=git%40github.com%3Ano%2Fsuch.git', 0],
      [['--item-types', 'NOPE'], 'itemTypes=NOPE', 0],
      [['--child-hub', 'no-such-hub'], 'childHubId=no-such-hub', 0],
      [['--from', '2026-10-03'], 'from=2026-10-03', 1],
      [['--to', '2026-10-02'], 'to=2026-10-02', 1],
      [['--limit', '1'], 'limit=1', 1],
      [['--offset', '2'], 'offset=2', 1],
    ];
    for (const [flags, qs, expected] of cases) {
      const fromCli = await hub.json(['hub', 'admin', 'events', ...flags]);
      const fromBoard = (await board(`/v1/timeline?${qs}`)).body;
      expect(fromCli, flags.join(' ')).toEqual(fromBoard);
      expect(fromCli.events, flags.join(' ')).toHaveLength(expected);
    }
  });

  it('repeats list filters and passes model filters on the PR overview', async () => {
    const both = await hub.json(['hub', 'admin', 'data', 'prs', '--model', 'model-a']);
    expect(both).toEqual((await board('/v1/prs/overview?model=model-a')).body);
  });

  it('--csv prints the rows of a list result as CSV', async () => {
    hub.clear();
    await hub.run(['hub', 'admin', 'events', '--csv']);
    const lines = hub.out().trim().split('\n');
    expect(lines[0]).toMatch(/(^|,)type(,|$)/);
    expect(lines).toHaveLength(4);
    expect(lines.slice(1).every(l => l.includes('pr.opened'))).toBe(true);
  });

  it('--csv neutralizes cells a spreadsheet would run as a formula, and keeps numbers as numbers', async () => {
    const key = await issueApiKey(hub.ctx.db, 'org', 'evil', { installationId: 'inst-evil' });
    const evil = { ...pr(9, 'evil@acme.com', 'model-a', '2026-10-04T10:00:00Z'), installationId: 'inst-evil', itemTitle: '=HYPERLINK("http://x","y")' };
    expect((await supertest(hub.server).post('/v1/events').set('Authorization', `Bearer ${key}`).send({ events: [evil] })).status).toBeLessThan(300);
    hub.clear();
    await hub.run(['hub', 'admin', 'events', '--csv', '--users', 'evil@acme.com']);
    const out = hub.out();
    expect(out).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(out).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('an unknown query is refused, naming the ones there are', async () => {
    await expect(hub.run(['hub', 'admin', 'data', 'nope'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/metrics/);
  });

  it('a bad filter is the hub\'s refusal, verbatim', async () => {
    await expect(hub.run(['hub', 'admin', 'data', 'histogram', '--bucket', 'fortnight'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/hub answered 400/i);
  });
});

describe('rollups', () => {
  it('recomputes from a day without asking, and the whole history only with --yes', async () => {
    const r = await hub.json(['hub', 'admin', 'rollups', 'recompute', '--since', '2026-10-01']);
    expect(r).toMatchObject({ since: '2026-10-01', full: false });
    await expect(hub.run(['hub', 'admin', 'rollups', 'recompute', '--full'])).rejects.toThrow(/exit 1/);
    expect((await hub.json(['hub', 'admin', 'rollups', 'recompute', '--full', '--yes'])).full).toBe(true);
  });

  it('needs --since or --full', async () => {
    await expect(hub.run(['hub', 'admin', 'rollups', 'recompute'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/--since|--full/);
  });
});

describe('audit log', () => {
  beforeEach(async () => {
    // Two changes to audit: an invite, made from the CLI.
    await hub.run(['hub', 'admin', 'users', 'invite', 'v1@x', '--role', 'viewer']);
    await hub.run(['hub', 'admin', 'users', 'invite', 'v2@x', '--role', 'viewer']);
  });

  it('lists audit rows, filtered, the same as the board, and pages with --cursor', async () => {
    const cli = await hub.json(['hub', 'admin', 'audit', 'list', '--area', 'users']);
    expect(cli).toEqual((await board('/v1/admin/audit?area=users')).body);
    expect(cli.rows.length).toBeGreaterThanOrEqual(2);
    expect(cli.rows.every((r: any) => r.source === 'cli' && r.actorEmail === 'admin@x')).toBe(true);

    const page1 = await hub.json(['hub', 'admin', 'audit', 'list', '--area', 'users', '--limit', '1']);
    expect(page1.rows).toHaveLength(1);
    expect(page1.next).toBeTruthy();
    const page2 = await hub.json(['hub', 'admin', 'audit', 'list', '--area', 'users', '--limit', '1', '--cursor', page1.next]);
    expect(page2.rows[0].id).not.toBe(page1.rows[0].id);
  });

  it('exports the audit log as CSV to a file, byte for byte what the board downloads', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-audit-')), 'audit.csv');
    await hub.run(['hub', 'admin', 'audit', 'export', '--area', 'users', '--out', out]);
    const fromBoard = (await board('/v1/admin/audit.csv?area=users').buffer(true).parse((res: any, cb: any) => {
      let d = ''; res.on('data', (c: any) => { d += c; }); res.on('end', () => cb(null, d));
    })).body as string;
    expect(fs.readFileSync(out, 'utf8')).toBe(fromBoard);
    expect(fromBoard.split('\n')[0]).toMatch(/^at,actor,source/);
  });

  it('an export the hub refuses reports the hub\'s words, and writes nothing', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-audit-')), 'audit.csv');
    await expect(hub.run(['hub', 'admin', 'audit', 'export', '--from', 'yesterday', '--out', out])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/dates/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('a bad date is the hub\'s refusal', async () => {
    await expect(hub.run(['hub', 'admin', 'audit', 'list', '--from', 'yesterday'])).rejects.toThrow(/exit 1/);
    expect(hub.err()).toMatch(/dates/);
  });
});

describe('downloads that stall', () => {
  it('give up when the hub does not answer, and when it stops mid-file, saying the file is incomplete', async () => {
    const http = await import('http');
    const { adminDownload, writeAdminCreds } = await import('../hubAdmin/client');
    const silent = http.createServer(() => { /* never answers */ });
    const stalling = http.createServer((_q, res) => { res.writeHead(200); res.write('first,'); /* then nothing */ });
    for (const s of [silent, stalling]) { s.listen(0, '127.0.0.1'); await new Promise(r => s.once('listening', r)); }
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-stall-')), 'x.csv');
    try {
      writeAdminCreds({ url: `http://127.0.0.1:${(silent.address() as any).port}`, token: 'agka_x', orgId: 'org', email: null, role: null, expiresAt: '' });
      await expect(adminDownload('/v1/admin/audit.csv', {}, out, { headersMs: 200, idleMs: 200 })).rejects.toThrow(/no answer within/);
      writeAdminCreds({ url: `http://127.0.0.1:${(stalling.address() as any).port}`, token: 'agka_x', orgId: 'org', email: null, role: null, expiresAt: '' });
      await expect(adminDownload('/v1/admin/audit.csv', {}, out, { headersMs: 1000, idleMs: 200 })).rejects.toThrow(/nothing received for .*incomplete/);
    } finally {
      for (const s of [silent, stalling]) { s.closeAllConnections?.(); await new Promise(r => s.close(r)); }
    }
  });

  it('a slow reader on stdout is not mistaken for a stalled hub', async () => {
    const http = await import('http');
    const { adminDownload, writeAdminCreds } = await import('../hubAdmin/client');
    // Two chunks, so the download is still open while stdout is draining.
    const server = http.createServer((_q, res) => { res.writeHead(200); res.write('a,b\n'); setTimeout(() => res.end('1,2\n'), 700); });
    server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    writeAdminCreds({ url: `http://127.0.0.1:${(server.address() as any).port}`, token: 'agka_x', orgId: 'org', email: null, role: null, expiresAt: '' });
    const got: string[] = [];
    // stdout is full: the reader takes longer than the idle deadline to drain it.
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((c: any) => {
      got.push(String(c));
      setTimeout(() => process.stdout.emit('drain'), 600);
      return false;
    }) as any);
    try {
      await adminDownload('/x', {}, undefined, { headersMs: 1000, idleMs: 300 });
      expect(got.join('')).toBe('a,b\n1,2\n');
    } finally {
      write.mockRestore();
      server.closeAllConnections?.(); await new Promise(r => server.close(r));
    }
  });
});
