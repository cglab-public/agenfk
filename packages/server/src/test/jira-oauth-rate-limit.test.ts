/**
 * The JIRA OAuth routes are rate limited (CodeQL #135, js/missing-rate-limiting).
 *
 * /jira/oauth/authorize reads the stored client config and mints OAuth state on
 * every call, and /jira/oauth/callback exchanges a code with Atlassian. Nothing
 * bounded either, so a loop in a local client could spin them without limit.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { EXPENSIVE_ROUTE_LIMIT } from '@agenfk/core';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./jira-oauth-rate-limit-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage } from '../server';

let server: import('http').Server;
const agent = () => request(server);
beforeAll(async () => { await initStorage(); server = app.listen(0); });
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
});

describe('JIRA OAuth routes are rate limited', () => {
  for (const route of ['/jira/oauth/authorize', '/jira/oauth/callback']) {
    it(`answers 429 on ${route} once the per-minute budget is spent`, async () => {
      for (let i = 0; i < EXPENSIVE_ROUTE_LIMIT; i++) {
        const r = await agent().get(route);
        expect(r.status, `request ${i + 1} was limited early`).not.toBe(429);
      }
      const over = await agent().get(route);
      expect(over.status).toBe(429);
      expect(over.body.error).toMatch(/Too many requests/);
    });
  }
});
