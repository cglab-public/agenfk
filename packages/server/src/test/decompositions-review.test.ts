/**
 * The route exists so the UI can show a proposal before anything is written.
 *
 * The rules themselves are tested in core (reviewProposal.test.ts); what is
 * tested here is the part only a route can get wrong — the status code, the
 * shape of the body, and the promise the whole feature rests on: THAT IT
 * WRITES NOTHING.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./decompositions-review-test-db.sqlite');

let server: import('http').Server;
beforeAll(async () => {
  // The database is chosen by env, as every other server spec here does it —
  // initStorage takes no path.
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
  server = app.listen(0);
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

const GOOD = {
  objective: 'port the admin API',
  items: [
    { ref: 'e1', type: 'EPIC', title: 'Port the admin API', parentRef: null },
    { ref: 's1', type: 'STORY', title: 'Move services private', parentRef: 'e1' },
  ],
};

describe('POST /decompositions/review', () => {
  it('answers 200 with the tree and no issues', async () => {
    const res = await request(server).post('/decompositions/review').send(GOOD);
    expect(res.status).toBe(200);
    expect(res.body.issues).toEqual([]);
    expect(res.body.items.map((i: any) => i.ref)).toEqual(['e1', 's1']);
  });

  /*
   * 200, NOT 400, and this is the decision the route exists to make. The
   * issues are the answer the screen draws beside each row; a 4xx would render
   * a reviewable proposal as a failed request and leave the UI nothing to show
   * except an error toast.
   */
  it('answers 200 with issues when the tree is wrong', async () => {
    const res = await request(server)
      .post('/decompositions/review')
      .send({ objective: 'x', items: [{ ref: 'a', type: 'SPIKE', title: '', parentRef: 'ghost' }] });
    expect(res.status).toBe(200);
    expect(res.body.issues.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(res.body.issues)).toMatch(/SPIKE/);
  });

  // THE PROMISE. Everything else here is detail; if this ever fails, the
  // approval gate has become a confirmation dialog.
  it('creates nothing', async () => {
    // Seeded first, on purpose: the original version compared 0 with 0 on a
    // virgin database and would have passed just as happily if GET /items had
    // started answering 500 (undefined === undefined).
    const project = await request(server).post('/projects').send({ name: 'seed' });
    expect(project.status).toBe(201);
    await request(server).post('/items')
      .send({ projectId: project.body.id, type: 'TASK', title: 'seeded' });

    const before = await request(server).get('/items');
    expect(before.status).toBe(200);
    expect(before.body.length).toBeGreaterThan(0);

    await request(server).post('/decompositions/review').send(GOOD);

    const after = await request(server).get('/items');
    expect(after.body.length).toBe(before.body.length);
    // Projects too: the tree names none, but "writes nothing" is about the
    // whole database, not one table.
    const projects = await request(server).get('/projects');
    expect(projects.body.length).toBe(1);
  });

  it('survives a body that is not a proposal at all', async () => {
    // It is fed by a model's output, through a UI. Both can hand it anything.
    // An array and a bare JSON string: both are valid JSON bodies and neither
    // is a proposal.
    for (const raw of ['[]', '"nope"']) {
      const res = await request(server)
        .post('/decompositions/review')
        .set('Content-Type', 'application/json')
        .send(raw);
      expect(res.status).toBe(400);
    }
  });

  it('treats a missing items array as an empty proposal, not a crash', async () => {
    const res = await request(server).post('/decompositions/review').send({ objective: 'x' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.issues)).toMatch(/no items/i);
  });
});
