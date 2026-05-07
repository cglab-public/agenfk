/**
 * Regression tests for: MCP tool schemas hardcode default-flow status enum.
 *
 * Bug: list_items / update_item / create_item declared `status` with a fixed
 * enum (TODO|IN_PROGRESS|TEST|REVIEW|DONE|BLOCKED|PAUSED) in both the JSON
 * Schema (tool definition) and the Zod parser. Items in custom-flow steps
 * (e.g. DISCOVERY, CREATE_UNIT_TESTS) were rejected. list_items also required
 * `status`, so there was no "everything in flight" sweep.
 *
 * Two layers:
 *  1. Static source checks — verify index.ts no longer hardcodes the enum and
 *     no longer requires status on list_items.
 *  2. REST functional tests — verify the underlying GET /items endpoint
 *     accepts custom statuses and returns items regardless of step name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const TEST_DB = path.resolve('./mcp-status-enum-custom-flows-test-db.sqlite');

const DEFAULT_FLOW_ENUM = `["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED", "PAUSED"]`;

// ── Static source checks ──────────────────────────────────────────────────────

describe('MCP tool schemas no longer hardcode default-flow status enum', () => {
  let src: string;

  beforeAll(() => {
    const indexPath = path.join(ROOT, 'packages/server/src/index.ts');
    src = fs.readFileSync(indexPath, 'utf8');
  });

  it('index.ts contains no occurrences of the hardcoded default-flow status enum', () => {
    // The exact literal `["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED", "PAUSED"]`
    // must not appear anywhere — neither in JSON Schema enums nor in Zod z.enum() calls.
    // After the fix, status is just a string (validated against the project's flow at the
    // storage/REST layer, not at the MCP schema layer).
    expect(src.includes(DEFAULT_FLOW_ENUM)).toBe(false);
  });

  it('list_items tool no longer requires status', () => {
    // Locate the list_items tool block and check its `required` array.
    const block = src.match(/name:\s*["']list_items["'][\s\S]{0,800}?required:\s*(\[[^\]]*\])/);
    expect(block, 'list_items tool definition not found').toBeTruthy();
    const required = block![1];
    expect(required).toContain('projectId');
    expect(required).not.toMatch(/["']status["']/);
  });

  it('ListItemsSchema makes status optional (Zod)', () => {
    // The Zod schema for list_items must declare status as optional and accept any string.
    const schemaBlock = src.match(/const\s+ListItemsSchema\s*=\s*z\.object\(\{[\s\S]*?\}\);/);
    expect(schemaBlock, 'ListItemsSchema not found').toBeTruthy();
    const body = schemaBlock![0];
    expect(body).toMatch(/status:\s*z\.string\(\)\.optional\(\)/);
    expect(body).not.toMatch(/status:\s*z\.enum/);
  });

  it('CreateItemSchema accepts any status string (Zod)', () => {
    const schemaBlock = src.match(/const\s+CreateItemSchema\s*=\s*z\.object\(\{[\s\S]*?\}\);/);
    expect(schemaBlock, 'CreateItemSchema not found').toBeTruthy();
    const body = schemaBlock![0];
    // status should be present, optional, and NOT a z.enum
    expect(body).toMatch(/status:/);
    expect(body).not.toMatch(/status:\s*z\.enum/);
  });

  it('UpdateItemSchema accepts any status string (Zod)', () => {
    const schemaBlock = src.match(/const\s+UpdateItemSchema\s*=\s*z\.object\(\{[\s\S]*?\}\);/);
    expect(schemaBlock, 'UpdateItemSchema not found').toBeTruthy();
    const body = schemaBlock![0];
    expect(body).toMatch(/status:/);
    expect(body).not.toMatch(/status:\s*z\.enum/);
  });

  it('list_items tool description points callers at get_flow for valid step names', () => {
    // Description should mention get_flow as the source of truth for valid statuses,
    // so callers know how to discover custom-flow step names.
    const block = src.match(/name:\s*["']list_items["'][\s\S]{0,800}?description:\s*["']([^"']+)["']/);
    expect(block, 'list_items description not found').toBeTruthy();
    const description = block![1];
    expect(description).toMatch(/get_flow/i);
  });
});

// ── REST functional tests ─────────────────────────────────────────────────────
// These verify the underlying API behaviour the MCP tools delegate to.

describe('GET /items supports custom-flow statuses', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('returns items parked in custom-flow steps (e.g. DISCOVERY)', async () => {
    // Set up: project + custom flow with DISCOVERY step + item parked there.
    const project = (await request(app).post('/projects').send({ name: 'CustomFlowProj' })).body;
    const flow = (await request(app).post('/flows').send({
      name: 'TDD',
      steps: [
        { id: 'a', name: 'TODO', order: 1, isAnchor: true },
        { id: 'b', name: 'DISCOVERY', order: 2, exitCriteria: 'Scope clear' },
        { id: 'c', name: 'DONE', order: 3, isAnchor: true },
      ],
    })).body;
    await request(app).post(`/projects/${project.id}/flow`).send({ flowId: flow.id });

    const item = (await request(app).post('/items').send({
      projectId: project.id,
      type: 'TASK',
      title: 'In discovery',
      status: 'DISCOVERY',
    })).body;
    expect(item.status).toBe('DISCOVERY');

    // The "no status filter" sweep returns all in-flight items including custom statuses.
    const allRes = await request(app).get(`/items`).query({ projectId: project.id });
    expect(allRes.status).toBe(200);
    expect(allRes.body.find((i: any) => i.id === item.id)).toBeTruthy();

    // Filtering by the custom status should also return it.
    const filteredRes = await request(app).get(`/items`).query({ projectId: project.id, status: 'DISCOVERY' });
    expect(filteredRes.status).toBe(200);
    expect(filteredRes.body.some((i: any) => i.id === item.id)).toBe(true);
  });
});
