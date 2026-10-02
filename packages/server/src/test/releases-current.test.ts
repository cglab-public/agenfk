/**
 * 4aac7076 (CGLAB-164): GET /releases/current - the notes of the release that
 * is INSTALLED.
 *
 * What's New (the board's version chip) read /releases/latest, which is
 * GitHub's latest STABLE: on 2.0.0-beta.12 it showed 1.1.20's notes.
 * /releases/latest stays as it is (the CLI's upgrade tier gate and the update
 * reminder rely on it); What's New reads this instead.
 */
import { testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, clearReleaseCache } from '../server';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

let __server: import('http').Server;
const agent = () => request(__server);
const TEST_DB = testDbPath('releases-current-test-db.sqlite');
const INSTALLED = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version as string;

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
  __server = app.listen(0);
});
afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});
afterEach(() => { vi.clearAllMocks(); clearReleaseCache(); });

async function mockedAxios() { return (await import('axios')).default as any; }

describe('GET /releases/current', () => {
  it("answers with the installed version's own release, asked for by its tag", async () => {
    const axios = await mockedAxios();
    axios.get.mockImplementation(async (url: string) => {
      if (url.endsWith(`/releases/tags/v${INSTALLED}`)) {
        return { data: {
          tag_name: `v${INSTALLED}`, name: `v${INSTALLED}`, body: 'Notes for the installed one',
          published_at: '2026-09-29T12:00:00Z', html_url: `https://github.com/x/y/releases/tag/v${INSTALLED}`,
        } };
      }
      return { data: { tag_name: 'v1.1.20', name: 'v1.1.20', body: 'Notes for the latest stable' } };
    });
    const res = await agent().get('/releases/current');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: INSTALLED,
      published: true,
      body: 'Notes for the installed one',
      url: `https://github.com/x/y/releases/tag/v${INSTALLED}`,
      publishedAt: '2026-09-29T12:00:00Z',
      currentVersion: INSTALLED,
    });
    // Never the latest-stable feed.
    expect(axios.get.mock.calls.map(([u]: [string]) => u).filter((u: string) => /\/releases\/latest$/.test(u))).toEqual([]);
  });

  it('says when the installed version has no published release, and points at the releases page', async () => {
    const axios = await mockedAxios();
    axios.get.mockRejectedValue(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
    const res = await agent().get('/releases/current');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: INSTALLED, published: false, body: '', currentVersion: INSTALLED });
    expect(res.body.url).toMatch(/\/releases$/);
  });

  it('is cached: a second read does not ask GitHub again', async () => {
    const axios = await mockedAxios();
    axios.get.mockResolvedValue({ data: { tag_name: `v${INSTALLED}`, name: '', body: 'x', published_at: '', html_url: 'u' } });
    await agent().get('/releases/current');
    const calls = axios.get.mock.calls.length;
    await agent().get('/releases/current');
    expect(axios.get.mock.calls.length).toBe(calls);
  });

  it('keeps "unpublished" only briefly: the release may appear any minute', async () => {
    const axios = await mockedAxios();
    axios.get.mockRejectedValue(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      await agent().get('/releases/current');
      const calls = axios.get.mock.calls.length;
      now.mockReturnValue(t0 + 30_000);
      await agent().get('/releases/current');
      expect(axios.get.mock.calls.length).toBe(calls); // still cached
      now.mockReturnValue(t0 + 61_000);
      await agent().get('/releases/current');
      expect(axios.get.mock.calls.length).toBeGreaterThan(calls); // asked again
    } finally { now.mockRestore(); }
  });

  it('a failed read is not retried on every open while GitHub refuses (cached for a minute)', async () => {
    const axios = await mockedAxios();
    axios.get.mockRejectedValue(Object.assign(new Error('rate limited'), { response: { status: 403 } }));
    await agent().get('/releases/current');
    const calls = axios.get.mock.calls.length;
    const again = await agent().get('/releases/current');
    expect(again.status).toBe(502);
    expect(axios.get.mock.calls.length).toBe(calls);
  });

  it('a release published with no title is named by its tag', async () => {
    const axios = await mockedAxios();
    axios.get.mockResolvedValue({ data: { tag_name: `v${INSTALLED}`, name: '', body: 'x', published_at: '2026-09-29T12:00:00Z', html_url: 'u' } });
    const res = await agent().get('/releases/current');
    expect(res.body.name).toBe(`v${INSTALLED}`);
  });

  it('a failure other than "not found" is an error, not "unpublished"', async () => {
    const axios = await mockedAxios();
    axios.get.mockRejectedValue(Object.assign(new Error('rate limited'), { response: { status: 403 } }));
    const res = await agent().get('/releases/current');
    expect(res.status).toBe(502);
  });
});
