/**
 * @vitest-environment node
 *
 * Which agent works a card is state, not a browser preference (CGLAB-169).
 *
 * It began life in `localStorage` under one global key, which was wrong twice
 * over: opening card B inherited card A's agent, and the choice did not survive
 * a machine change or reach any other client. It is also the same fact AgEnFK
 * already treats as real — `pr-register` REQUIRES `--model` and `--harness`
 * precisely so the hub can record which runtime did the work.
 *
 * The items table stores the whole item in a `data` column, so this needed no
 * migration. What it does need is a deliberate line in the update allowlist,
 * which is what these tests pin.
 *
 * Note what is deliberately NOT stored: the auto-approve flag. Persisting a
 * decision to disable an agent's own safety prompts would let a choice made
 * once silently apply to every later run on that card.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN } from '../server';

const TEST_DB = path.resolve('./item-agent-id-test-db.sqlite');

const internal = (req: request.Test) => req.set('x-agenfk-internal', VERIFY_TOKEN!);

describe('the agent a card is worked with', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => {
    await initStorage();
    const p = await internal(request(app).post('/projects')).send({ name: 'agent-id' });
    projectId = p.body.id;
  });

  const makeItem = async () => {
    const res = await internal(request(app).post('/items'))
      .send({ type: 'TASK', title: 'probe', projectId });
    return res.body.id as string;
  };

  it('is stored on the item and comes back on read', async () => {
    const id = await makeItem();
    await internal(request(app).put(`/items/${id}`)).send({ agentId: 'codex' });
    const after = await request(app).get(`/items/${id}`);
    expect(after.body.agentId).toBe('codex');
  });

  it('is remembered per card, not globally', async () => {
    // The exact bug the move fixes: one machine-wide key meant opening a second
    // card silently launched whatever the first card used.
    const a = await makeItem();
    const b = await makeItem();
    await internal(request(app).put(`/items/${a}`)).send({ agentId: 'codex' });
    await internal(request(app).put(`/items/${b}`)).send({ agentId: 'claude' });

    expect((await request(app).get(`/items/${a}`)).body.agentId).toBe('codex');
    expect((await request(app).get(`/items/${b}`)).body.agentId).toBe('claude');
  });

  it('survives an unrelated update', async () => {
    const id = await makeItem();
    await internal(request(app).put(`/items/${id}`)).send({ agentId: 'codex' });
    await internal(request(app).put(`/items/${id}`)).send({ title: 'renamed' });
    const after = await request(app).get(`/items/${id}`);
    expect(after.body.agentId).toBe('codex');
    expect(after.body.title).toBe('renamed');
  });

  it('is absent until something sets it, rather than defaulting server-side', async () => {
    // The server has no agent registry and must not grow one. Which agent is
    // the sensible default is a client question.
    const id = await makeItem();
    expect((await request(app).get(`/items/${id}`)).body.agentId).toBeUndefined();
  });

  it('ignores a non-string, so a bad client cannot corrupt the field', async () => {
    const id = await makeItem();
    await internal(request(app).put(`/items/${id}`)).send({ agentId: { evil: true } });
    expect((await request(app).get(`/items/${id}`)).body.agentId).toBeUndefined();
  });

  it('refuses an absurdly long value', async () => {
    // It is an opaque id, not a payload. A bound keeps a hostile client from
    // growing the row without limit.
    const id = await makeItem();
    await internal(request(app).put(`/items/${id}`)).send({ agentId: 'x'.repeat(5000) });
    expect((await request(app).get(`/items/${id}`)).body.agentId).toBeUndefined();
  });

  it('stores an unknown id verbatim rather than validating it here', async () => {
    // Deliberate. The server does not know the agent list; the desktop main
    // process resolves the id by exact match against a closed set at spawn
    // time, so an unknown value is refused THERE rather than executed. Adding a
    // second, drifting copy of the list here would be worse than useless.
    const id = await makeItem();
    await internal(request(app).put(`/items/${id}`)).send({ agentId: 'not-a-real-agent' });
    expect((await request(app).get(`/items/${id}`)).body.agentId).toBe('not-a-real-agent');
  });

  it('does not persist a decision to skip permissions', async () => {
    // A stored auto-approve would let one choice silently disable the agent's
    // own safety prompts on every later run of this card. It is a per-run
    // decision and stays one.
    const id = await makeItem();
    await internal(request(app).put(`/items/${id}`)).send({ agentId: 'claude', autoApprove: true });
    const after = await request(app).get(`/items/${id}`);
    expect(after.body.autoApprove).toBeUndefined();
  });
});
