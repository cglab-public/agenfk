/**
 * Hub events for a work item linked to a tracker carry the tracker's browse
 * URL next to its key (story ce9b0e8e), so the hub's user page can link the
 * key. The URL is the one stored on the item: the hub has no JIRA site of its
 * own to build it from.
 *
 * Behaviour-based: enable the outbox, link an item, trigger a real event for
 * it, and read what lands in hub_outbox.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.hoisted(() => {
  process.env.AGENFK_HUB_URL = process.env.AGENFK_HUB_URL || 'http://hub.test';
  process.env.AGENFK_HUB_TOKEN = process.env.AGENFK_HUB_TOKEN || 'test-token';
  process.env.AGENFK_HUB_ORG = process.env.AGENFK_HUB_ORG || 'test-org';
});

import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

let server: import('http').Server;
const agent = () => request(server);
beforeAll(() => { server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

const TEST_DB = path.resolve('./hub-external-url-test-db.sqlite');

async function waitForOutbox(predicate: (p: any) => boolean, timeoutMs = 5000): Promise<any> {
  const db: any = (await import('../server')).storage['database'];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = db.prepare('SELECT payload FROM hub_outbox').all() as { payload: string }[];
    const found = rows.map(r => JSON.parse(r.payload)).find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise(r => setTimeout(r, 25));
  }
}

describe('hub events carry the tracker URL of a linked item', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('sends the stored externalUrl beside externalId on a later event for the item', async () => {
    const project = (await agent().post('/projects').send({ name: 'ExtUrl' })).body;
    const item = (await agent().post('/items').send({ projectId: project.id, type: 'TASK', title: 'Linked' })).body;
    const linked = await agent().put(`/items/${item.id}`).send({ externalId: 'CGLAB-9', externalUrl: 'https://cg-lab.atlassian.net/browse/CGLAB-9' });
    expect(linked.status).toBe(200);

    // A later change to the item: its event carries the link read from the item.
    const renamed = await agent().put(`/items/${item.id}`).send({ title: 'Linked, renamed' });
    expect(renamed.status).toBe(200);

    const event = await waitForOutbox(p => p.itemId === item.id && p.type === 'item.updated' && p.payload?.changedFields?.includes?.('title'));
    expect(event).toBeDefined();
    expect(event.externalId).toBe('CGLAB-9');
    expect(event.externalUrl).toBe('https://cg-lab.atlassian.net/browse/CGLAB-9');
    expect(event.itemTitle).toBe('Linked, renamed');
  });
});
