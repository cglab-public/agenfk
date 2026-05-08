/**
 * Regression: GET /setup must serve the SPA (React Setup page), not 404.
 * The /setup/initial-admin API endpoint sits under the same prefix, but
 * the SPA fallback used to skip the entire /setup tree, leaving operators
 * with "Cannot GET /setup" when they followed the bootstrap banner.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';

const tmpDir = (label: string) =>
  path.join(os.tmpdir(), `agenfk-hub-spa-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe('hub SPA fallback — /setup', () => {
  let dbPath: string;
  let uiDir: string;
  let prevUiDir: string | undefined;

  beforeEach(() => {
    const sandbox = tmpDir('spa');
    fs.mkdirSync(sandbox, { recursive: true });
    dbPath = path.join(sandbox, 'hub.sqlite');
    uiDir = path.join(sandbox, 'ui-dist');
    fs.mkdirSync(uiDir, { recursive: true });
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
    prevUiDir = process.env.AGENFK_HUB_UI_DIR;
    process.env.AGENFK_HUB_UI_DIR = uiDir;
  });

  afterEach(() => {
    if (prevUiDir === undefined) delete process.env.AGENFK_HUB_UI_DIR;
    else process.env.AGENFK_HUB_UI_DIR = prevUiDir;
    try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET /setup returns the SPA index.html so the React route can render', async () => {
    const out = await createHubApp({
      dbPath,
      secretKey: '0'.repeat(64),
      sessionSecret: 'test-session-secret-min-32-bytes-please',
      defaultOrgId: 'org',
    });
    try {
      const r = await supertest(out.app).get('/setup');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/html/i);
      expect(r.text).toContain('<div id="root"></div>');
    } finally {
      await out.ctx.db.close();
    }
  });

  it('POST /setup/initial-admin still hits the API (not the SPA)', async () => {
    const out = await createHubApp({
      dbPath,
      secretKey: '0'.repeat(64),
      sessionSecret: 'test-session-secret-min-32-bytes-please',
      defaultOrgId: 'org',
    });
    try {
      // Without a token this returns 401 (token gate), proving the request
      // reached the API route rather than being handed an HTML body.
      const r = await supertest(out.app)
        .post('/setup/initial-admin')
        .send({ email: 'a@b', password: 'longenough1' });
      expect(r.status).toBe(401);
      expect(r.headers['content-type']).toMatch(/json/i);
    } finally {
      await out.ctx.db.close();
    }
  });
});
