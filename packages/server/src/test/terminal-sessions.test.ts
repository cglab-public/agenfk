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

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call —
 * 29 of them here. The churn produced `Error: Parse Error: Expected HTTP/`,
 * a transport failure that hands the test an empty body, so the next call goes
 * to `/items/undefined` and one bad socket surfaces as a confident wrong
 * assertion in whichever test was running.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


const TEST_DB = path.resolve('./terminal-sessions-test-db.sqlite');

/**
 * Every assertion is scoped to the project the test created.
 *
 * The table is not truncated between tests — `initStorage()` reopens the
 * database, it does not empty it — so an unscoped read sees rows from every
 * test that ran before. Asserting on the global list made the outcome depend
 * on execution order, which is how a test reports a failure that belongs to a
 * different test.
 */
const open = (projectId: string) =>
  agent().get(`/terminal-sessions?projectId=${projectId}`);

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
    const p = await agent().post('/projects').send({ name: 'terms' });
    projectId = p.body.id;
    const i = await agent().post('/items').send({ title: 'Work', type: 'TASK', projectId });
    itemId = i.body.id;
  });

  it('has nothing to restore on a fresh install', async () => {
    const res = await open(projectId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('remembers a terminal that was opened', async () => {
    const res = await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: UUID_A });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const listed = await open(projectId);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      itemId, agentId: 'claude-code', agentSessionId: UUID_A,
    });
  });

  it('forgets one the user closed', async () => {
    // Closing a tab is the user saying they are done with it. Restoring it on
    // the next launch would be the app arguing.
    const created = await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: UUID_A });
    await agent().delete(`/terminal-sessions/${created.body.id}`);
    expect((await open(projectId)).body).toEqual([]);
  });

  it('keeps one that was still open when the app died', async () => {
    // The case this whole feature exists for. A killed process runs no
    // shutdown code, so "still open" is the state the row is left in, and it
    // must survive a restart intact.
    await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'pi', agentSessionId: UUID_B });
    await initStorage();
    const after = await open(projectId);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].agentSessionId).toBe(UUID_B);
  });

  it('keeps several terminals on the same card apart', async () => {
    // Two agents on one card is the normal case here, not an edge one.
    await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: UUID_A });
    await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'pi', agentSessionId: UUID_B });
    const listed = await open(projectId);
    expect(listed.body).toHaveLength(2);
    expect(listed.body.map((s: { agentId: string }) => s.agentId).sort()).toEqual(['claude-code', 'pi']);
  });

  it('can be narrowed to one project', async () => {
    const other = await agent().post('/projects').send({ name: 'other' });
    const otherItem = await agent().post('/items')
      .send({ title: 'Elsewhere', type: 'TASK', projectId: other.body.id });
    await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: UUID_A });
    await agent().post('/terminal-sessions')
      .send({ itemId: otherItem.body.id, projectId: other.body.id, agentId: 'pi', agentSessionId: UUID_B });

    const scoped = await agent().get(`/terminal-sessions?projectId=${projectId}`);
    expect(scoped.body).toHaveLength(1);
    expect(scoped.body[0].itemId).toBe(itemId);
  });
});

describe('the conversation id', () => {
  let projectId: string;
  let itemId: string;
  beforeEach(async () => {
    await initStorage();
    const p = await agent().post('/projects').send({ name: 'terms' });
    projectId = p.body.id;
    const i = await agent().post('/items').send({ title: 'Work', type: 'TASK', projectId });
    itemId = i.body.id;
  });

  it('is optional, because not every agent can be told its own id', async () => {
    // codex has no flag for it. The terminal is still worth remembering — the
    // tab comes back — but the conversation cannot, and null is how that is
    // said.
    const res = await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'codex' });
    expect(res.status).toBe(201);
    const listed = await open(projectId);
    expect(listed.body[0].agentSessionId ?? null).toBeNull();
  });

  it('is refused when it is not a uuid', async () => {
    // This value ends up in the argv of a spawned process. It is generated by
    // us, so a bad one means a bug rather than an attack — but argv is exactly
    // where "it is ours, it is fine" stops being a safe assumption, and the
    // posture here matches tmuxSessionName: refuse, never escape.
    for (const bad of ['; rm -rf /', '--resume', '../../etc/passwd', 'not-a-uuid', '']) {
      const res = await agent().post('/terminal-sessions')
        .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: bad });
      expect(res.status, `should have refused ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('is refused when it is not a string at all', async () => {
    for (const bad of [42, true, {}, ['a']]) {
      const res = await agent().post('/terminal-sessions')
        .send({ itemId, projectId, agentId: 'claude-code', agentSessionId: bad });
      expect(res.status).toBe(400);
    }
  });
});

describe('what it refuses to record', () => {
  let projectId: string;
  beforeEach(async () => {
    await initStorage();
    const p = await agent().post('/projects').send({ name: 'terms' });
    projectId = p.body.id;
  });

  it('a session for an item that does not exist', async () => {
    // Restoring would try to resolve a worktree for a card that is gone, and
    // fail at the least helpful moment: app startup.
    const res = await agent().post('/terminal-sessions')
      .send({ itemId: 'no-such-item', projectId, agentId: 'claude-code' });
    expect(res.status).toBe(404);
  });

  it('an agent id that is not one we can launch', async () => {
    // The set of agents is a closed list and a security boundary. A row naming
    // something outside it either fails at restore or, worse, becomes a way to
    // influence what gets spawned.
    const i = await agent().post('/items').send({ title: 'W', type: 'TASK', projectId });
    const res = await agent().post('/terminal-sessions')
      .send({ itemId: i.body.id, projectId, agentId: 'rm -rf /' });
    expect(res.status).toBe(400);
  });

  it('a missing agent id', async () => {
    const i = await agent().post('/items').send({ title: 'W', type: 'TASK', projectId });
    const res = await agent().post('/terminal-sessions').send({ itemId: i.body.id, projectId });
    expect(res.status).toBe(400);
  });
});

describe('cleaning up', () => {
  it('does not offer the sessions of a card that is gone', async () => {
    // Filtered on READ, not cascaded on delete, and that is the finding rather
    // than a shortcut: `DELETE /items/:id` does not delete, it TRASHES
    // (AUTO_TRASH), so a delete-time cascade never ran. Checking at read time
    // covers every route by which a card can stop being available, including
    // ones that do not exist yet.
    //
    // Otherwise restore trips over a card that is not there, at app startup,
    // on every launch from then on.
    await initStorage();
    const p = await agent().post('/projects').send({ name: 'terms' });
    const i = await agent().post('/items')
      .send({ title: 'Doomed', type: 'TASK', projectId: p.body.id });
    await agent().post('/terminal-sessions')
      .send({ itemId: i.body.id, projectId: p.body.id, agentId: 'claude-code' });
    await agent().delete(`/items/${i.body.id}`);
    expect((await open(p.body.id)).body).toEqual([]);
  });
});

/**
 * What identifies a session, and why it has to be written down (CGLAB-191).
 *
 * Restoring a terminal never re-entered tmux, and the reason was here: the
 * record kept the card, the project, the agent and the conversation id — and
 * neither of the two fields that decide WHICH session is being restored.
 *
 * `persist` decides whether the terminal lives inside tmux at all, and
 * `autoApprove` is baked into the tmux session NAME. Without them a restore
 * put every tab back outside tmux, orphaning the session still running and
 * starting a second agent beside it in the same worktree — and since the
 * replacement did not persist either, nothing survived the next close. Each
 * launch could leave another abandoned daemon.
 */
describe('the fields that identify a session', () => {
  let projectId: string;
  let itemId: string;
  beforeEach(async () => {
    await initStorage();
    const p = await agent().post('/projects').send({ name: 'ident' });
    projectId = p.body.id;
    const i = await agent().post('/items').send({ title: 'Work', type: 'TASK', projectId });
    itemId = i.body.id;
  });

  it('remembers that a session was persisted', async () => {
    const res = await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', persist: true, autoApprove: false });
    expect(res.status).toBe(201);
    const listed = await agent().get(`/terminal-sessions?projectId=${projectId}`);
    expect(listed.body[0].persist).toBe(true);
    expect(listed.body[0].autoApprove).toBe(false);
  });

  it('remembers what it was created with', async () => {
    // Not a preference. A restore that assumes prompts-on resolves to the
    // "ask" variant of the tmux name and misses the "auto" session that is
    // actually running.
    await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', persist: true, autoApprove: true });
    const listed = await agent().get(`/terminal-sessions?projectId=${projectId}`);
    expect(listed.body[0].autoApprove).toBe(true);
  });

  it('survives a restart, which is the whole point', async () => {
    await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', persist: true, autoApprove: true });
    await initStorage();
    const after = await agent().get(`/terminal-sessions?projectId=${projectId}`);
    expect(after.body[0].persist).toBe(true);
    expect(after.body[0].autoApprove).toBe(true);
  });

  it('defaults both to false when nothing said otherwise', async () => {
    // The conservative answer for a session whose identity was never written
    // down — not a guess dressed up as data.
    await agent().post('/terminal-sessions').send({ itemId, projectId, agentId: 'claude-code' });
    const listed = await agent().get(`/terminal-sessions?projectId=${projectId}`);
    expect(listed.body[0].persist).toBe(false);
    expect(listed.body[0].autoApprove).toBe(false);
  });

  it('is not fooled by a truthy string', async () => {
    // These reach a session NAME and a spawn decision, and "false" is truthy.
    await agent().post('/terminal-sessions')
      .send({ itemId, projectId, agentId: 'claude-code', persist: 'false', autoApprove: 'false' });
    const listed = await agent().get(`/terminal-sessions?projectId=${projectId}`);
    expect(listed.body[0].persist).toBe(false);
    expect(listed.body[0].autoApprove).toBe(false);
  });
});
