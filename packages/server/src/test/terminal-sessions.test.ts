/**
 * @vitest-environment node
 *
 * Remembering which terminals were open, and which conversation each one held.
 *
 * Two different things are stored here and conflating them is the whole risk:
 *
 *  - WHICH CARD had a terminal, with which agent. Enough to put the tabs back.
 *  - The AGENT'S OWN conversation id, so the restored terminal resumes the
 *    conversation instead of starting a fresh one.
 *
 * The second is the one that matters. Without it, "restore" puts empty shells
 * on screen that look like the sessions the user left and are not — which is
 * worse than restoring nothing, because it takes a while to notice.
 *
 * The id is one WE generate and hand to the agent (`--session-id` on a fresh
 * spawn), rather than one we discover afterwards. That is why it can be stored
 * at open time and why it works on the first terminal, with no hook installed.
 * Agents that cannot be told their id — codex has no such flag — store null,
 * and null has to mean "cannot resume this one" everywhere rather than being
 * quietly treated as a missing row.
 *
 * A session that is still open when the app dies stays open in the table. That
 * is deliberate: quitting is exactly the case this exists for, and the process
 * never gets to run any shutdown code when it is killed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage } from '../server';

const TEST_DB = path.resolve('./terminal-sessions-test-db.sqlite');
const UUID_A = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const UUID_B = '9c858901-8a57-4791-81fe-4c455b099bc9';

describe('terminal sessions', () => {
  let projectId: string;
  let itemId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => {
    await initStorage();
    const p = await request(app).post('/projects').send({ name: 'terms' });
    projectId = p.body.id;
    const i = await request(app).post('/items').send({ title: 'Work', type: 'TASK', projectId });
    itemId = i.body.id;
  });

  it('has nothing to restore on a fresh install', async () => {
    const res = await request(app).get('/terminal-sessions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('remembers a terminal that was opened', async () => {
    const res = await request(app).post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: UUID_A });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const open = await request(app).get('/terminal-sessions');
    expect(open.body).toHaveLength(1);
    expect(open.body[0]).toMatchObject({
      itemId, agentId: 'claude-code', agentSessionId: UUID_A,
    });
  });

  it('forgets one the user closed', async () => {
    // Closing a tab is the user saying they are done with it. Restoring it on
    // the next launch would be the app arguing.
    const created = await request(app).post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: UUID_A });
    await request(app).delete(`/terminal-sessions/${created.body.id}`);
    expect((await request(app).get('/terminal-sessions')).body).toEqual([]);
  });

  it('keeps one that was still open when the app died', async () => {
    // The case this whole feature exists for. A killed process runs no
    // shutdown code, so "still open" is the state the row is left in, and it
    // must survive a restart intact.
    await request(app).post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'pi', agentSessionId: UUID_B });
    await initStorage();
    const after = await request(app).get('/terminal-sessions');
    expect(after.body).toHaveLength(1);
    expect(after.body[0].agentSessionId).toBe(UUID_B);
  });

  it('keeps several terminals on the same card apart', async () => {
    // Two agents on one card is the normal case here, not an edge one.
    await request(app).post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: UUID_A });
    await request(app).post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'pi', agentSessionId: UUID_B });
    const open = await request(app).get('/terminal-sessions');
    expect(open.body).toHaveLength(2);
    expect(open.body.map((s: { agentId: string }) => s.agentId).sort()).toEqual(['claude-code', 'pi']);
  });

  it('can be narrowed to one project', async () => {
    const other = await request(app).post('/projects').send({ name: 'other' });
    const otherItem = await request(app).post('/items')
      .send({ title: 'Elsewhere', type: 'TASK', projectId: other.body.id });
    await request(app).post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: UUID_A });
    await request(app).post('/terminal-sessions')
      .send({ itemId: otherItem.body.id, projectId: other.body.id, agentId: 'pi', agentSessionId: UUID_B });

    const scoped = await request(app).get(`/terminal-sessions?projectId=${projectId}`);
    expect(scoped.body).toHaveLength(1);
    expect(scoped.body[0].itemId).toBe(itemId);
  });
});

describe('the conversation id', () => {
  let projectId: string;
  let itemId: string;
  beforeEach(async () => {
    await initStorage();
    const p = await request(app).post('/projects').send({ name: 'terms' });
    projectId = p.body.id;
    const i = await request(app).post('/items').send({ title: 'Work', type: 'TASK', projectId });
    itemId = i.body.id;
  });

  it('is optional, because not every agent can be told its own id', async () => {
    // codex has no flag for it. The terminal is still worth remembering — the
    // tab comes back — but the conversation cannot, and null is how that is
    // said.
    const res = await request(app).post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'codex' });
    expect(res.status).toBe(201);
    const open = await request(app).get('/terminal-sessions');
    expect(open.body[0].agentSessionId ?? null).toBeNull();
  });

  it('is refused when it is not a uuid', async () => {
    // This value ends up in the argv of a spawned process. It is generated by
    // us, so a bad one means a bug rather than an attack — but argv is exactly
    // where "it is ours, it is fine" stops being a safe assumption, and the
    // posture here matches tmuxSessionName: refuse, never escape.
    for (const bad of ['; rm -rf /', '--resume', '../../etc/passwd', 'not-a-uuid', '']) {
      const res = await request(app).post('/terminal-sessions')
        .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: bad });
      expect(res.status, `should have refused ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('is refused when it is not a string at all', async () => {
    for (const bad of [42, true, {}, ['a']]) {
      const res = await request(app).post('/terminal-sessions')
        .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: bad });
      expect(res.status).toBe(400);
    }
  });
});

describe('what it refuses to record', () => {
  let projectId: string;
  beforeEach(async () => {
    await initStorage();
    const p = await request(app).post('/projects').send({ name: 'terms' });
    projectId = p.body.id;
  });

  it('a session for an item that does not exist', async () => {
    // Restoring would try to resolve a worktree for a card that is gone, and
    // fail at the least helpful moment: app startup.
    const res = await request(app).post('/terminal-sessions')
      .send({ itemId: 'no-such-item', projectId, agentId: 'claude-code' });
    expect(res.status).toBe(404);
  });

  it('an agent id that is not one we can launch', async () => {
    // The set of agents is a closed list and a security boundary. A row naming
    // something outside it either fails at restore or, worse, becomes a way to
    // influence what gets spawned.
    const i = await request(app).post('/items').send({ title: 'W', type: 'TASK', projectId });
    const res = await request(app).post('/terminal-sessions')
      .send({ itemId: i.body.id, projectId, agentId: 'rm -rf /' });
    expect(res.status).toBe(400);
  });

  it('a missing agent id', async () => {
    const i = await request(app).post('/items').send({ title: 'W', type: 'TASK', projectId });
    const res = await request(app).post('/terminal-sessions').send({ itemId: i.body.id, projectId });
    expect(res.status).toBe(400);
  });
});

describe('cleaning up', () => {
  it('drops the sessions of a deleted item rather than orphaning them', async () => {
    // Otherwise restore trips over a card that no longer exists, on every
    // launch, forever.
    await initStorage();
    const p = await request(app).post('/projects').send({ name: 'terms' });
    const i = await request(app).post('/items')
      .send({ title: 'Doomed', type: 'TASK', projectId: p.body.id });
    await request(app).post('/terminal-sessions')
      .send({ itemId: i.body.id, projectId: p.body.id, agentId: 'claude-code' });
    await request(app).delete(`/items/${i.body.id}`);
    expect((await request(app).get('/terminal-sessions')).body).toEqual([]);
  });
});
