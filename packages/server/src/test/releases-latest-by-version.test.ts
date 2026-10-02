/**
 * BUG 022b229a: the server's /releases/latest answered GitHub's latest-by-DATE.
 * It feeds the CLI's upgrade-tier gate, the MCP upgrade notice and the board's
 * update reminder, while `agenfk upgrade` picks the newest stable by VERSION
 * (3a261573). On 1.1.20 with 2.0.0 and then a 1.1.21 hotfix published, the gate
 * said "v1.1.21 required, run agenfk upgrade" and upgrade installed 2.0.0. Now
 * the route applies the CLI's rule: GitHub's latest is one candidate beside the
 * list, never a hub tag or a tag with a prerelease part, newest by version.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

import axios from 'axios';
import { app, initStorage, clearReleaseCache } from '../server';

const TEST_DB = path.resolve('./releases-latest-by-version-test-db.sqlite');
let server: import('http').Server;
const agent = () => request(server);
const get = vi.mocked((axios as any).get);

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
  server = app.listen(0);
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});
afterEach(() => { get.mockReset(); clearReleaseCache(); });

const rel = (tag_name: string, prerelease = false, published_at = '2026-10-01T00:00:00Z') =>
  ({ tag_name, prerelease, published_at, name: tag_name, body: `notes for ${tag_name}`, html_url: `https://example.test/${tag_name}` });

/** GitHub as the route sees it; `list: null` makes the list request fail. */
function github(latest: ReturnType<typeof rel>, list: ReturnType<typeof rel>[] | null, tiers: Record<string, string> = {}) {
  get.mockImplementation(async (url: string) => {
    if (url.endsWith('/releases/latest')) return { data: latest };
    if (url.includes('/releases?')) { if (!list) throw new Error('rate limited'); return { data: list }; }
    const raw = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\/packages\/cli\/package\.json/);
    if (raw) return { data: tiers[raw[1]] ? { agenfkUpgradeTier: tiers[raw[1]] } : {} };
    throw new Error(`unexpected GET ${url}`);
  });
}

describe('/releases/latest answers the newest framework stable by version (BUG 022b229a)', () => {
  it('a hotfix on an older line published last does not win', async () => {
    github(rel('v1.1.21', false, '2026-10-05T00:00:00Z'), [
      rel('v1.1.21', false, '2026-10-05T00:00:00Z'),
      rel('v2.0.0', false, '2026-10-01T00:00:00Z'),
    ]);
    const r = await agent().get('/releases/latest');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: '2.0.0', tagName: 'v2.0.0', body: 'notes for v2.0.0' });
  });

  // The tier is the strongest among stables NEWER than this install (user
  // decision, 022b229a review). This server runs 2.0.0-beta.x, so 9.x and 8.x
  // are newer and 1.1.21 is not.
  it('a mandatory hotfix on an older line still gates, when it is newer than the install', async () => {
    github(rel('v8.1.1', false, '2026-10-05T00:00:00Z'), [rel('v8.1.1'), rel('v9.0.0')], { 'v8.1.1': 'mandatory', 'v9.0.0': 'optional' });
    const r = await agent().get('/releases/latest');
    expect(r.body).toMatchObject({ version: '9.0.0', upgradeTier: 'mandatory' });
  });

  it('a mandatory release older than the install does not', async () => {
    github(rel('v1.1.21'), [rel('v1.1.21'), rel('v9.0.0')], { 'v1.1.21': 'mandatory' });
    expect((await agent().get('/releases/latest')).body).toMatchObject({ version: '9.0.0', upgradeTier: 'optional' });
  });

  it('never a draft (the token the server sends lets the list return drafts)', async () => {
    github(rel('v9.0.0'), [{ ...rel('v9.1.0'), draft: true } as any, rel('v9.0.0')], { 'v9.1.0': 'mandatory' });
    expect((await agent().get('/releases/latest')).body).toMatchObject({ version: '9.0.0', upgradeTier: 'optional' });
  });

  it('answers from the list when the latest request itself fails', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.endsWith('/releases/latest')) throw new Error('timeout');
      if (url.includes('/releases?')) return { data: [rel('v9.0.0')] };
      return { data: {} };
    });
    expect((await agent().get('/releases/latest')).body.version).toBe('9.0.0');
  });

  it('never a beta published without --prerelease', async () => {
    github(rel('v2.1.0-beta.1'), [rel('v2.1.0-beta.1'), rel('v2.0.1')]);
    expect((await agent().get('/releases/latest')).body.version).toBe('2.0.1');
  });

  it('never a hub tag, from either source', async () => {
    github(rel('hub-v3.0.0'), [rel('hub-v3.0.0'), rel('v2.0.0'), rel('v2.1.0-beta.2', true)]);
    expect((await agent().get('/releases/latest')).body.version).toBe('2.0.0');
  });

  it("keeps GitHub's latest when the list holds no stable (a long beta run)", async () => {
    github(rel('v1.1.20'), Array.from({ length: 23 }, (_, i) => rel(`v2.0.0-beta.${i + 1}`, true)));
    expect((await agent().get('/releases/latest')).body).toMatchObject({ version: '1.1.20', body: 'notes for v1.1.20' });
  });

  it('a failed list request keeps the good latest', async () => {
    github(rel('v2.0.0'), null);
    const r = await agent().get('/releases/latest');
    expect(r.status).toBe(200);
    expect(r.body.version).toBe('2.0.0');
  });

  it('asks for a page long enough to reach past a long beta run', async () => {
    github(rel('v2.0.0'), [rel('v2.0.0')]);
    await agent().get('/releases/latest');
    const listUrl = get.mock.calls.map(c => String(c[0])).find(u => u.includes('/releases?'));
    expect(listUrl).toMatch(/per_page=100/);
  });
});
