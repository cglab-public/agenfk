// Parent side of flow dispatch (CGLAB-182, task 1).
//
// A parent hub sends one of its flows to its child hubs. It records WHO it was
// sent to and WHAT happened per hub — serving a directive is not the same as
// the flow landing, so the target state starts pending and only a report from
// the child moves it (that report is task ef8c4cd1; here everything stays
// pending, which is the honest answer until a child speaks).
//
// The load-bearing decision, confirmed with the user: scope 'all' means every
// current AND FUTURE child hub. So a dispatch cannot be expanded into a fixed
// list of targets when it is created — a hub enrolling next month has to
// receive it on its first poll. Several tests below exist only to hold that.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-flowdispatch-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

describe('parent hub: dispatching a flow to child hubs', () => {
  let app: any; let ctx: any; let cookie: string; let flowId: string;

  const enroll = async (name: string) => {
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const r = await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name } });
    expect(r.status).toBe(200);
    return r.body as { token: string; childHubId: string };
  };
  /** What a child sees when it polls. 204 means "nothing to do". */
  const poll = (token: string) =>
    supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${token}`);
  const dispatch = (body: unknown) =>
    supertest(app).post('/v1/admin/flow-dispatches').set('Cookie', cookie).send(body);

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    const made = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
      .send({
        definition: {
          name: 'Group TDD',
          description: 'the org standard',
          steps: [
            { id: 'todo', name: 'TODO', order: 0 },
            { id: 'done', name: 'DONE', order: 1 },
          ],
        },
      });
    expect(made.status).toBeLessThan(300);
    flowId = made.body.id;
  });

  afterEach(async () => { ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close(); cleanup(); });

  describe('targeting', () => {
    it('reaches only the hubs named in a selected dispatch', async () => {
      const a = await enroll('alpha');
      const b = await enroll('beta');
      expect((await dispatch({ flowId, scope: 'selected', childHubIds: [a.childHubId] })).status).toBe(200);

      const forAlpha = await poll(a.token);
      expect(forAlpha.status).toBe(200);
      expect(forAlpha.body).toMatchObject({ kind: 'flow.dispatch' });

      expect((await poll(b.token)).status).toBe(204);
    });

    it("reaches a hub that enrolled AFTER an 'all' dispatch was created", async () => {
      // The whole reason 'all' cannot be frozen into a target list up front.
      expect((await dispatch({ flowId, scope: 'all' })).status).toBe(200);
      const late = await enroll('enrolled-later');
      const r = await poll(late.token);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ kind: 'flow.dispatch' });
    });

    it('carries the flow definition, so the child needs no second request', async () => {
      const a = await enroll('alpha');
      await dispatch({ flowId, scope: 'all' });
      const r = await poll(a.token);
      expect(r.body.flow).toMatchObject({ id: flowId, name: 'Group TDD' });
      expect(r.body.flow.definition.steps.map((s: any) => s.name)).toEqual(['TODO', 'DONE']);
      expect(typeof r.body.dispatchId).toBe('string');
      expect(typeof r.body.flowVersion).toBe('number');
    });
  });

  describe('what stops a dispatch being served', () => {
    it('a cancelled dispatch', async () => {
      const a = await enroll('alpha');
      const d = await dispatch({ flowId, scope: 'all' });
      expect((await poll(a.token)).status).toBe(200);
      const c = await supertest(app).post(`/v1/admin/flow-dispatches/${d.body.id}/cancel`).set('Cookie', cookie).send({});
      expect(c.status).toBe(200);
      expect((await poll(a.token)).status).toBe(204);
    });

    it('a detached hub, whose credential is dead anyway', async () => {
      const a = await enroll('alpha');
      await dispatch({ flowId, scope: 'all' });
      await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', cookie).send({});
      expect((await poll(a.token)).status).toBeGreaterThanOrEqual(400);
    });

    it('nothing at all, on a hub with no dispatches', async () => {
      const a = await enroll('alpha');
      expect((await poll(a.token)).status).toBe(204);
    });
  });

  describe('the admin view of what happened', () => {
    it('lists a dispatch with a pending target per hub, because nobody has reported yet', async () => {
      const a = await enroll('alpha');
      await enroll('beta');
      await dispatch({ flowId, scope: 'all' });
      await poll(a.token); // alpha has now SEEN it — still not installed

      const list = await supertest(app).get('/v1/admin/flow-dispatches').set('Cookie', cookie);
      expect(list.status).toBe(200);
      const d = list.body.dispatches[0];
      expect(d).toMatchObject({ flowId, scope: 'all' });
      // Serving is not landing: alpha polled, and is still pending.
      const alphaTarget = d.targets.find((t: any) => t.childHubId === a.childHubId);
      expect(alphaTarget.state).toBe('pending');
    });

    it('refuses a dispatch of a flow that does not exist', async () => {
      await enroll('alpha');
      const r = await dispatch({ flowId: 'no-such-flow', scope: 'all' });
      expect(r.status).toBeGreaterThanOrEqual(400);
    });

    it("refuses a dispatch of another org's flow, which DOES exist", async () => {
      // The id resolves, so only the ownership clause can refuse it — an
      // unknown-id test cannot tell the two apart and passes either way.
      await enroll('alpha');
      await ctx.db.run(
        `INSERT INTO flows (id, org_id, name, description, definition_json, source, version)
         VALUES (?, ?, ?, ?, ?, 'hub', 1)`,
        ['their-flow', 'other-org', 'Their Flow', null,
         JSON.stringify({ name: 'Their Flow', steps: [{ id: 'a', name: 'A', order: 0 }] })],
      );
      const r = await dispatch({ flowId: 'their-flow', scope: 'all' });
      expect(r.status).toBe(404);
    });

    it("never serves another org's dispatch to this org's child hub", async () => {
      // A real foreign dispatch, seeded alongside ours. Without the org clause
      // in the directive query the child is served the wrong group's flow —
      // the worst outcome this feature can produce.
      const a = await enroll('alpha');
      await ctx.db.run(
        `INSERT INTO flows (id, org_id, name, description, definition_json, source, version)
         VALUES (?, ?, ?, ?, ?, 'hub', 1)`,
        ['their-flow', 'other-org', 'Their Flow', null,
         JSON.stringify({ name: 'Their Flow', steps: [{ id: 'a', name: 'A', order: 0 }] })],
      );
      await ctx.db.run(
        `INSERT INTO flow_dispatches (id, org_id, flow_id, flow_version, scope_type, created_at)
         VALUES (?, ?, ?, 1, 'all', ?)`,
        ['their-dispatch', 'other-org', 'their-flow', '2020-01-01T00:00:00.000Z'],
      );
      // Ours is newer, so if org scoping were dropped the FOREIGN one would be
      // served first — ordered by created_at, and theirs is dated 2020.
      await dispatch({ flowId, scope: 'all' });

      const r = await poll(a.token);
      expect(r.status).toBe(200);
      expect(r.body.flow.id).toBe(flowId);
      expect(r.body.flow.name).toBe('Group TDD');
    });
  });
});
