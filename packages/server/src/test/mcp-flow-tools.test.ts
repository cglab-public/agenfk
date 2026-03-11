/**
 * Tests for MCP flow management tools:
 *   list_flows, create_flow, update_flow, delete_flow, use_flow
 *
 * Two layers:
 *  1. Static registration checks — verify index.ts declares and handles each tool.
 *     These FAIL until the tools are added.
 *  2. REST API functional tests — verify the endpoints the MCP tools delegate to
 *     behave correctly end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  return { default: mockAxios };
});

const ROOT = path.resolve(__dirname, '../../../..');
const TEST_DB = path.resolve('./mcp-flow-tools-test-db.sqlite');

// ── Static registration tests ──────────────────────────────────────────────────
// These check that index.ts declares and handles each new MCP flow tool.
// They FAIL before the tools are added, driving implementation.

describe('MCP flow tool registration in index.ts', () => {
  let src: string;

  beforeAll(() => {
    const indexPath = path.join(ROOT, 'packages/server/src/index.ts');
    src = fs.readFileSync(indexPath, 'utf8');
  });

  const TOOLS = ['list_flows', 'create_flow', 'update_flow', 'delete_flow', 'use_flow'];

  for (const tool of TOOLS) {
    it(`declares "${tool}" in the tools list`, () => {
      // Tool definition: name: "tool_name"
      expect(src).toMatch(new RegExp(`name:\\s*["']${tool}["']`));
    });

    it(`handles "${tool}" in the call-tool switch`, () => {
      // Case handler: case "tool_name":
      expect(src).toMatch(new RegExp(`case\\s+["']${tool}["']`));
    });
  }
});

// ── REST API functional tests (backing the MCP tools) ─────────────────────────
// These test the actual behaviour the tools delegate to.
// They pass independently; keeping them ensures regressions are caught.

describe('Flow management REST API (list_flows backing)', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  beforeEach(async () => {
    await initStorage();
  });

  it('GET /flows returns an array', async () => {
    const res = await request(app).get('/flows');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('Flow management REST API (create_flow backing)', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('POST /flows creates a flow with steps', async () => {
    const res = await request(app).post('/flows').send({
      name: 'Shipping Flow',
      description: 'Custom flow for shipping features',
      steps: [
        { id: 's1', name: 'TODO', label: 'To Do', order: 1, isAnchor: true },
        { id: 's2', name: 'DEV', label: 'Development', order: 2, exitCriteria: 'All tests green' },
        { id: 's3', name: 'DONE', label: 'Done', order: 3, isAnchor: true },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Shipping Flow');
    expect(res.body.steps).toHaveLength(3);
    expect(res.body.steps[1].exitCriteria).toBe('All tests green');
  });

  it('POST /flows rejects missing name', async () => {
    const res = await request(app).post('/flows').send({ steps: [] });
    expect(res.status).toBe(400);
  });

  it('POST /flows + POST /projects/:id/flow activates flow for project (use_flow scenario)', async () => {
    const project = (await request(app).post('/projects').send({ name: 'FlowProject' })).body;
    const flow = (await request(app).post('/flows').send({
      name: 'TDD Flow',
      steps: [
        { id: 'a', name: 'TODO', order: 1, isAnchor: true },
        { id: 'b', name: 'IN_PROGRESS', order: 2 },
        { id: 'c', name: 'DONE', order: 3, isAnchor: true },
      ],
    })).body;

    const activate = await request(app)
      .post(`/projects/${project.id}/flow`)
      .send({ flowId: flow.id });
    expect(activate.status).toBe(200);

    const activeFlow = (await request(app).get(`/projects/${project.id}/flow`)).body;
    expect(activeFlow.id).toBe(flow.id);
    expect(activeFlow.name).toBe('TDD Flow');
  });
});

describe('Flow management REST API (update_flow backing)', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('PUT /flows/:id updates name and steps', async () => {
    const created = (await request(app).post('/flows').send({
      name: 'Old Name',
      steps: [],
    })).body;

    const res = await request(app).put(`/flows/${created.id}`).send({
      name: 'New Name',
      steps: [{ id: 'x', name: 'DONE', order: 1, isAnchor: true }],
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.steps).toHaveLength(1);
  });

  it('PUT /flows/:id returns 404 for unknown id', async () => {
    const res = await request(app).put('/flows/no-such-flow').send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('Flow management REST API (delete_flow backing)', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('DELETE /flows/:id removes the flow', async () => {
    const created = (await request(app).post('/flows').send({ name: 'ToDelete', steps: [] })).body;

    const del = await request(app).delete(`/flows/${created.id}`);
    expect(del.status).toBe(204);

    const get = await request(app).get(`/flows/${created.id}`);
    expect(get.status).toBe(404);
  });

  it('DELETE /flows/:id returns 404 for unknown flow', async () => {
    const res = await request(app).delete('/flows/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('Flow management REST API (use_flow backing)', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('POST /projects/:id/flow rejects missing flowId body', async () => {
    const project = (await request(app).post('/projects').send({ name: 'P1' })).body;
    const res = await request(app).post(`/projects/${project.id}/flow`).send({});
    expect(res.status).toBe(400);
  });

  it('POST /projects/:id/flow rejects unknown flowId', async () => {
    const project = (await request(app).post('/projects').send({ name: 'P2' })).body;
    const res = await request(app)
      .post(`/projects/${project.id}/flow`)
      .send({ flowId: 'no-such-flow' });
    expect(res.status).toBe(404);
  });
});
