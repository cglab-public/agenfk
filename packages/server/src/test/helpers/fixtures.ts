/**
 * Fixtures that fail where they break (BUG 9de0c99c).
 *
 * The server suite has a rotating failure: a different test each run, always
 * green when re-run alone. Capturing the real assertions rather than the test
 * names showed what they have in common, and it is not timing.
 *
 * `expected 404 to be 400`, on a test about a workflow guard. The guard was
 * fine. The fixture above it did:
 *
 *     const item = (await request(app).post('/items').send({...})).body;
 *     await request(app).put(`/items/${item.id}`)...
 *
 * When the POST does not return 201, `body` is an error object, `item.id` is
 * `undefined`, and the PUT goes to `/items/undefined` — which 404s. The failure
 * then reads as a statement about the guard under test, several lines from the
 * request that actually broke. The same shape produced `expected 200 to be 202`
 * in the async-validate specs: a verify command that never got set means there
 * is nothing to run in the background, so the route answers synchronously.
 *
 * So a hiccup anywhere in setup surfaces as a confident, wrong claim about
 * behaviour — and WHICH test it lands on depends on which helper hiccuped,
 * which is exactly the "different test every run" shape.
 *
 * These helpers do not stop the hiccup. They stop it from lying about where it
 * happened, which is the part that cost eleven hypotheses.
 */
import { expect } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/** Create a project, or fail here rather than three assertions later. */
export async function makeProject(app: Express, name: string, token?: string) {
  let req = request(app).post('/projects').send({ name });
  if (token) req = req.set('x-agenfk-internal', token);
  const res = await req;
  expect(res.status, `fixture: could not create project "${name}" — ${res.status} ${JSON.stringify(res.body)}`).toBe(201);
  expect(res.body?.id, `fixture: project "${name}" came back without an id`).toBeTruthy();
  return res.body;
}

/**
 * Create an item, or fail here.
 *
 * Returning the body unchecked is what turns a failed create into
 * `/items/undefined`, and a 404 from that path is indistinguishable from the
 * route genuinely refusing.
 */
export async function makeItem(
  app: Express,
  fields: { title: string; type?: string; projectId: string; parentId?: string },
) {
  const res = await request(app).post('/items').send({ type: 'TASK', ...fields });
  expect(res.status, `fixture: could not create item "${fields.title}" — ${res.status} ${JSON.stringify(res.body)}`).toBe(201);
  expect(res.body?.id, `fixture: item "${fields.title}" came back without an id`).toBeTruthy();
  return res.body;
}

/**
 * Read an item back and assert it is on the step the test needs.
 *
 * The state a test depends on, checked rather than assumed. A validate only
 * goes asynchronous when there is a command AND the item is on the step that
 * runs it, so a silent failure to move the item makes the route answer
 * synchronously and the test blame the route.
 */
export async function expectOnStep(app: Express, itemId: string, step: string) {
  const res = await request(app).get(`/items/${itemId}`);
  expect(res.status, `fixture: item ${itemId} is not readable — ${res.status}`).toBe(200);
  expect(res.body.status, `fixture: item ${itemId} is on ${res.body.status}, not ${step}`).toBe(step);
  return res.body;
}
