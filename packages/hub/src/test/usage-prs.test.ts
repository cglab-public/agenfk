/**
 * GH-396: GET /v1/usage/prs, the By PR table of the hub's /usage page served
 * one page at a time. The board filters pick the PRs exactly as they picked
 * the overview's old byPr; the table's own filters (repository, text, status),
 * its sort (every column, either direction) and its paging run on the hub, so
 * a response carries one page and the total, never the whole list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);
const ALICE = { osUser: 'alice', gitName: 'Zoe Alice', gitEmail: 'alice@acme.com' };
const BOB = { osUser: 'bob', gitName: 'Adam Bob', gitEmail: 'bob@acme.com' };

interface Spend { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; costUsd?: number; estimatedCostUsd?: number; unpricedTurns?: number }
const totals = (s: Spend) => ({
  turns: 1, input: s.input ?? 0, cacheRead: s.cacheRead ?? 0, cacheWrite: s.cacheWrite ?? 0, output: s.output ?? 0,
  reasoning: 0, costUsd: s.costUsd ?? 0, unpricedTurns: s.unpricedTurns ?? 0,
  ...(s.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: s.estimatedCostUsd }),
});
const usageOf = (s: Spend) => ({ byModel: [{ client: 'claude-code', model: 'claude-opus-5-5', ...totals(s) }], total: totals(s), byStep: [], cards: 1, complete: true });

let n = 0;
const event = (over: any) => ({
  eventId: `pr-${++n}`,
  installationId: 'inst-a',
  orgId: 'org',
  occurredAt: '2026-11-19T10:00:00.000Z',
  actor: ALICE,
  projectId: 'p1',
  remoteUrl: 'git@github.com:acme/api.git',
  itemType: 'STORY',
  ...over,
});
const pr = (itemId: string, prNumber: number, over: any = {}, repo = 'acme/api', type = 'pr.opened') =>
  event({ type, itemId, itemTitle: `Story ${itemId}`, payload: { prNumber, repo }, ...over });
const closed = (itemId: string, spend: Spend, over: any = {}) =>
  event({ type: 'item.closed', itemId, occurredAt: '2026-11-19T09:00:00.000Z', payload: { toStatus: 'DONE', usage: usageOf(spend) }, ...over });
/** "2026-11-19T10:MM:00.000Z": a minute per index, so opening order is the index. */
const at = (i: number) => `2026-11-19T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`;

describe('GET /v1/usage/prs', () => {
  let app: any;
  let db: HubDb;
  let cookie: string;
  let token: string;
  const post = async (events: any[]) => {
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
    expect(r.status).toBe(200);
  };
  const prs = async (q = '') => {
    const r = await supertest(app).get(`/v1/usage/prs${q}`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    return r.body;
  };
  const nums = async (q = '') => (await prs(q)).rows.map((r: any) => r.pr_number);

  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({ dbPath: ':memory:', secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org', db });
    app = out.app;
    await createPasswordUser(out.ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';
    token = await issueApiKey(out.ctx.db, 'org', 'test');
  });
  afterEach(async () => { await drainApp(app); await db.close(); });

  it('needs a signed-in board user', async () => {
    expect((await supertest(app).get('/v1/usage/prs')).status).toBe(401);
  });

  it('the overview no longer carries the PR list', async () => {
    await post([pr('s1', 1)]);
    const r = await supertest(app).get('/v1/usage/overview').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('byPr');
    expect(r.body).not.toHaveProperty('prsTruncated');
  });

  describe('paging', () => {
    beforeEach(async () => {
      await post(Array.from({ length: 60 }, (_, i) => pr(`c${i}`, i + 1, { occurredAt: at(i) })));
    });

    it('serves 25 rows a page by default, newest PR first, with the total', async () => {
      const body = await prs();
      expect(body.total).toBe(60);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(25);
      expect(body.rows).toHaveLength(25);
      expect(body.rows[0].pr_number).toBe(60);
      expect(body.rows[24].pr_number).toBe(36);
    });

    it('pages follow on from each other with no row missing or repeated', async () => {
      const seen = [...await nums('?page=1'), ...await nums('?page=2'), ...await nums('?page=3')];
      expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => 60 - i));
    });

    it('takes a page size, capped at 100', async () => {
      expect((await prs('?pageSize=10&page=2')).rows.map((r: any) => r.pr_number)).toEqual([50, 49, 48, 47, 46, 45, 44, 43, 42, 41]);
      expect((await prs('?pageSize=500')).pageSize).toBe(100);
    });

    it('a page past the end is the last page', async () => {
      const body = await prs('?page=9');
      expect(body.page).toBe(3);
      expect(body.rows.map((r: any) => r.pr_number)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });

    it('reads the closes of the page\'s PRs only, unless a status filter or a usage sort needs them all', async () => {
      const all = vi.spyOn(db, 'all');
      const closeReads = () => all.mock.calls
        .filter(c => /item\.closed', 'step\.transitioned'\) AND item_id IN/.test(String(c[0])))
        .reduce((n, c) => n + (c[1] as unknown[]).length - 1, 0);
      await prs();
      expect(closeReads()).toBe(25);
      all.mockClear();
      await prs('?sort=tokens');
      expect(closeReads()).toBe(60);
      all.mockClear();
      await prs('?status=open');
      expect(closeReads()).toBe(60);
      all.mockRestore();
    });

    it('refuses a page or page size that is not a positive whole number', async () => {
      for (const q of ['?page=0', '?page=abc', '?pageSize=-1', '?page=1.5', '?page=1&page=2']) {
        expect((await supertest(app).get(`/v1/usage/prs${q}`).set('Cookie', cookie)).status, q).toBe(400);
      }
    });
  });

  it('PRs opened at the same instant keep one order on every page: repo, then number', async () => {
    await post([
      pr('a', 2, { occurredAt: at(0) }), pr('b', 1, { occurredAt: at(0) }),
      pr('c', 1, { occurredAt: at(0) }, 'acme/web'), pr('d', 3, { occurredAt: at(0) }),
    ]);
    const rows = (await prs()).rows.map((r: any) => `${r.repo}#${r.pr_number}`);
    expect(rows).toEqual(['acme/api#1', 'acme/api#2', 'acme/api#3', 'acme/web#1']);
    const paged = [...(await prs('?pageSize=1&page=1')).rows, ...(await prs('?pageSize=1&page=2')).rows,
      ...(await prs('?pageSize=1&page=3')).rows, ...(await prs('?pageSize=1&page=4')).rows].map((r: any) => `${r.repo}#${r.pr_number}`);
    expect(paged).toEqual(rows);
  });

  describe('the board filters apply as they did to byPr', () => {
    it('time window, people, projects and item types', async () => {
      await post([
        pr('old', 1, { occurredAt: '2026-10-01T10:00:00.000Z' }),
        pr('bobs', 2, { actor: BOB, installationId: 'inst-b' }),
        pr('web', 3, { remoteUrl: 'git@github.com:acme/web.git' }, 'acme/web'),
        pr('bug', 4, { itemType: 'BUG' }),
      ]);
      expect((await nums('?from=2026-11-01')).sort()).toEqual([2, 3, 4]);
      expect((await nums('?from=2026-11-01&users=alice%40acme.com')).sort()).toEqual([3, 4]);
      expect(await nums(`?projects=${encodeURIComponent('git@github.com:acme/web.git')}`)).toEqual([3]);
      expect(await nums('?itemTypes=BUG')).toEqual([4]);
    });
  });

  describe('table filters', () => {
    beforeEach(async () => {
      await post([
        closed('s1', { input: 10 }), closed('s3', { input: 30 }),
        pr('s1', 11, { occurredAt: at(1), itemTitle: 'Fix the login' }),
        pr('s2', 12, { occurredAt: at(2), itemTitle: 'Usage paging' }, 'acme/web'),
        pr('s3', 13, { occurredAt: at(3), itemTitle: '100% coverage_of things' }, 'Acme/Docs'),
        pr('s4', 112, { occurredAt: at(4), itemTitle: 'Another' }, 'acme/web'),
      ]);
    });

    it('lists the repositories of the PRs the board filters pick, for the repository filter', async () => {
      expect((await prs()).repos).toEqual(['acme/api', 'Acme/Docs', 'acme/web']);
      // The table's own filters do not narrow the choices they are picked from.
      expect((await prs('?repos=acme%2Fapi&status=open')).repos).toEqual(['acme/api', 'Acme/Docs', 'acme/web']);
    });

    it('repository: one or more, whatever their case', async () => {
      expect(await nums('?repos=acme%2Fweb')).toEqual([112, 12]);
      expect(await nums('?repos=acme%2Fapi,acme%2Fdocs')).toEqual([13, 11]);
      expect((await prs('?repos=acme%2Fnone')).total).toBe(0);
    });

    it('text: the PR number, with or without #, or part of the card title, any case', async () => {
      expect(await nums('?q=12')).toEqual([12]);
      // A number is the PR's number, never part of a longer one.
      expect(await nums('?q=11')).toEqual([11]);
      expect(await nums('?q=%2312')).toEqual([12]);
      expect(await nums('?q=LOGIN')).toEqual([11]);
      expect(await nums('?q=pag')).toEqual([12]);
      expect((await prs('?q=12')).total).toBe(1);
    });

    it('text is matched literally: % and _ are not wildcards, and quotes are just text', async () => {
      expect(await nums('?q=%25')).toEqual([13]);
      expect(await nums('?q=e_of')).toEqual([13]);
      expect(await nums('?q=_')).toEqual([13]);
      expect(await nums(`?q=${encodeURIComponent("' OR 1=1 --")}`)).toEqual([]);
    });

    it('status: closed (usage counted) or not closed yet', async () => {
      expect(await nums('?status=closed')).toEqual([13, 11]);
      expect(await nums('?status=open')).toEqual([112, 12]);
      expect((await supertest(app).get('/v1/usage/prs?status=merged').set('Cookie', cookie)).status).toBe(400);
    });

    it('filters combine, and the total counts the filtered rows', async () => {
      const body = await prs('?repos=acme%2Fweb&status=open&q=another');
      expect(body.rows.map((r: any) => r.pr_number)).toEqual([112]);
      expect(body.total).toBe(1);
    });
  });

  describe('sorting', () => {
    beforeEach(async () => {
      await post([
        closed('a', { input: 100, cacheRead: 1, cacheWrite: 30, output: 7, costUsd: 0.1, estimatedCostUsd: 2 }),
        closed('b', { input: 10, cacheRead: 300, cacheWrite: 2, output: 50, costUsd: 1 }),
        closed('c', { input: 50, cacheRead: 20, cacheWrite: 1, output: 900, costUsd: 0, estimatedCostUsd: 0.5 }),
        pr('a', 3, { occurredAt: at(1), itemTitle: 'beta card' }),
        pr('b', 20, { occurredAt: at(2), itemTitle: 'Alpha card', actor: BOB, installationId: 'inst-b' }, 'acme/web'),
        pr('c', 100, { occurredAt: at(3), itemTitle: 'gamma card' }),
        pr('d', 4, { occurredAt: at(4), itemTitle: 'delta card (open)' }),
      ]);
    });
    const order = async (sort: string, dir?: string) => (await prs(`?sort=${sort}${dir ? `&dir=${dir}` : ''}`)).rows.map((r: any) => r.item_id);

    it('by opening date, newest first by default, oldest first ascending', async () => {
      expect(await order('opened')).toEqual(['d', 'c', 'b', 'a']);
      expect(await order('opened', 'asc')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('by PR: repository, then the number as a number', async () => {
      expect(await order('pr', 'asc')).toEqual(['a', 'd', 'c', 'b']);
      expect(await order('pr', 'desc')).toEqual(['b', 'c', 'd', 'a']);
    });

    it('by card title, ignoring case', async () => {
      expect(await order('card', 'asc')).toEqual(['b', 'a', 'd', 'c']);
      expect(await order('card', 'desc')).toEqual(['c', 'd', 'a', 'b']);
    });

    it('by who opened the PR, by their known name', async () => {
      // Adam Bob before Zoe Alice, though bob@ sorts after alice@.
      expect((await order('createdBy', 'asc'))[0]).toBe('b');
      expect((await order('createdBy', 'desc'))[3]).toBe('b');
    });

    it('by tokens and by each token type, a PR not closed yet last either way', async () => {
      expect(await order('tokens', 'desc')).toEqual(['c', 'b', 'a', 'd']);
      expect(await order('tokens', 'asc')).toEqual(['a', 'b', 'c', 'd']);
      expect(await order('input', 'desc')).toEqual(['a', 'c', 'b', 'd']);
      expect(await order('cacheRead', 'desc')).toEqual(['b', 'c', 'a', 'd']);
      expect(await order('cacheWrite', 'desc')).toEqual(['a', 'b', 'c', 'd']);
      expect(await order('output', 'desc')).toEqual(['c', 'b', 'a', 'd']);
      expect(await order('output', 'asc')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('by cost: reported plus the estimate stored with the usage, not reported alone', async () => {
      // a: 0.1 + 2 = 2.1; b: 1 reported, no estimate; c: 0 + 0.5.
      expect(await order('cost', 'desc')).toEqual(['a', 'b', 'c', 'd']);
      expect(await order('cost', 'asc')).toEqual(['c', 'b', 'a', 'd']);
    });

    it('sorting happens before paging: page 2 continues the sorted order', async () => {
      const two = async (page: number) => (await prs(`?sort=cost&dir=desc&pageSize=2&page=${page}`)).rows.map((r: any) => r.item_id);
      expect([...await two(1), ...await two(2)]).toEqual(['a', 'b', 'c', 'd']);
    });

    it('echoes the sort it applied, and refuses one it does not know', async () => {
      const body = await prs('?sort=tokens&dir=asc');
      expect([body.sort, body.dir]).toEqual(['tokens', 'asc']);
      expect([(await prs()).sort, (await prs()).dir]).toEqual(['opened', 'desc']);
      for (const q of ['?sort=payload', '?dir=up', '?sort=cost&sort=pr']) {
        expect((await supertest(app).get(`/v1/usage/prs${q}`).set('Cookie', cookie)).status, q).toBe(400);
      }
    });
  });

  it('under a cost sort, says how many priced-by-estimate PRs have no stored estimate, which it counts at reported cost', async () => {
    await post([
      closed('old', { input: 5, unpricedTurns: 1 }),
      closed('new', { input: 5, unpricedTurns: 0, estimatedCostUsd: 0.3 }),
      closed('pi', { input: 5, costUsd: 0.2 }),
      pr('old', 1), pr('new', 2), pr('pi', 3), pr('open', 4),
    ]);
    expect((await prs('?sort=cost')).costWithoutEstimate).toBe(1);
    // Only the cost sort is affected, so only it says.
    expect((await prs()).costWithoutEstimate).toBeNull();
  });

  describe('Created by', () => {
    it('is the person who opened the PR, not whoever updated it later', async () => {
      await post([
        pr('s1', 5, { occurredAt: at(1), actor: BOB, installationId: 'inst-b' }),
        pr('s1', 5, { occurredAt: at(2) }, 'acme/api', 'pr.updated'),
      ]);
      expect((await prs()).rows).toEqual([expect.objectContaining({ pr_number: 5, created_by: 'bob@acme.com' })]);
    });

    it('is the opener even when the people filter picked the PR by a later update', async () => {
      await post([
        pr('s1', 5, { occurredAt: at(1), actor: BOB, installationId: 'inst-b' }),
        pr('s1', 5, { occurredAt: at(2) }, 'acme/api', 'pr.updated'),
      ]);
      expect((await prs('?users=alice%40acme.com')).rows[0].created_by).toBe('bob@acme.com');
    });

    it('a PR the hub only saw updated is credited to its earliest update', async () => {
      await post([
        pr('s1', 6, { occurredAt: at(1), actor: BOB, installationId: 'inst-b' }, 'acme/api', 'pr.updated'),
        pr('s1', 6, { occurredAt: at(2) }, 'acme/api', 'pr.updated'),
      ]);
      expect((await prs()).rows[0].created_by).toBe('bob@acme.com');
    });
  });

  describe('the link to the PR', () => {
    it('is the PR on GitHub, from the PR\'s own repository even when it was registered from a fork', async () => {
      await post([pr('s1', 77, { remoteUrl: 'git@github.com:alice/api.git' })]);
      expect((await prs()).rows[0].url).toBe('https://github.com/acme/api/pull/77');
    });

    it('is none when the project is on a host whose PR links cannot be derived', async () => {
      await post([pr('s1', 8, { remoteUrl: 'git@gitlab.example.com:acme/api.git' })]);
      expect((await prs()).rows[0].url).toBeNull();
    });

    it('is none when the repository is not an owner/repo slug', async () => {
      await post([pr('s1', 9, { remoteUrl: undefined }, 'not a slug')]);
      expect((await prs()).rows[0].url).toBeNull();
    });
  });
});
