/**
 * CGLAB-110 regression protection for the server-side workflow_gatekeeper
 * MCP handler.
 *
 * That handler carries a HAND-WRITTEN MIRROR of the core
 * decideGatekeeperAuthorization (packages/core/src/gatekeeper.ts) — and this
 * mirror is exactly where the STORY deadlock lived: it drifted from the core
 * and refused to authorize work directly on a STORY. The core is unit-tested
 * exhaustively; nothing exercised the mirror. These tests round-trip the real
 * MCP surface (in-memory client → live CallTool handler → self-REST via the
 * proxied axios mock) and pin the CGLAB-110 behaviour on both sides of the
 * type gate: a STORY in an active step authorizes, an EPIC still refuses.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { connectMcpClient, type ConnectedMcpClient } from './helpers/mcpClient';

// The MCP handler reaches the REST layer through an axios client
// (createApiClient). Other MCP test files mock axios as a no-op because the
// tools they exercise never self-REST. workflow_gatekeeper DOES — so this
// file's mock proxies every axios call to the real in-memory express app and
// answers in axios shape ({ data, status }). The dynamic imports run at call
// time, by which point the module graph is fully loaded.
vi.mock('axios', () => {
  const proxy = (method: 'get' | 'post' | 'put' | 'patch') => async (url: string, config?: any) => {
    const { default: supertest } = await import('supertest');
    const { app: liveApp } = await import('../server');
    const req = supertest(liveApp)[method](url);
    if (method !== 'get' && config?.data !== undefined) req.send(config.data);
    const r = await req;
    return { data: r.body, status: r.status, headers: r.headers };
  };
  const mockAxios: any = {
    get: proxy('get'),
    post: proxy('post'),
    put: proxy('put'),
    patch: proxy('patch'),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    create: vi.fn(() => mockAxios),
  };
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./mcp-gatekeeper-test-db.sqlite');
// The no-item-id path resolves the project by walking up from process.cwd()
// to the nearest .agenfk/project.json (findProjectId, re-read per call). Point
// the cwd at a scratch dir whose project.json names the TEST project, so the
// handler binds to the test DB instead of the repo's live project.
const SCRATCH_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gatekeeper-'));
const ORIGINAL_CWD = process.cwd();

const toolText = (result: any): string =>
  String(Array.isArray(result.content) ? (result.content as any[]).map(c => c.text).join('\n') : '');

describe('workflow_gatekeeper MCP handler: a STORY is directly actionable (CGLAB-110)', () => {
  let mcp: ConnectedMcpClient;
  let projectId: string;
  let storyId: string;
  let epicId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
    mcp = await connectMcpClient();

    const proj = await request(app).post('/projects').send({ name: 'gatekeeper-mirror' });
    projectId = proj.body.id;

    const story = await request(app).post('/items').send({ type: 'STORY', title: 'mirror story', projectId });
    storyId = story.body.id;
    await request(app).put(`/items/${storyId}`).send({ status: 'IN_PROGRESS' });

    const epic = await request(app).post('/items').send({ type: 'EPIC', title: 'mirror epic', projectId });
    epicId = epic.body.id;
    await request(app).put(`/items/${epicId}`).send({ status: 'IN_PROGRESS' });
  });

  afterAll(async () => {
    await mcp.close();
    process.chdir(ORIGINAL_CWD);
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    fs.rmSync(SCRATCH_CWD, { recursive: true, force: true });
  });

  it('authorizes a STORY in an active step when targeted by id', async () => {
    const result = await mcp.client.callTool({
      name: 'workflow_gatekeeper',
      arguments: { intent: 'mirror parity check', itemId: storyId },
    } as any);
    const text = toolText(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('AUTHORIZED');
    expect(text).toContain('STORY');
    expect(text).not.toContain('WORKFLOW BREACH');
  });

  it('still refuses an EPIC targeted by id, and names the child-item route', async () => {
    const result = await mcp.client.callTool({
      name: 'workflow_gatekeeper',
      arguments: { intent: 'mirror parity check', itemId: epicId },
    } as any);
    const text = toolText(result);
    expect(result.isError).toBe(true);
    expect(text).toContain('Cannot authorize work directly on an EPIC');
    expect(text).toContain('STORY, TASK or BUG');
  });

  it('lists the active STORY when no item id is given and no TASK/BUG exists', async () => {
    // With a STORY + EPIC both active and no TASK/BUG, the lone actionable
    // item is the STORY — the handler must pick it up, not report a breach.
    // findProjectRoot prefers AGENFK_DB_PATH over the cwd walk, so the env var
    // is unset for the duration of this call to make the handler bind to the
    // scratch cwd (storage is already initialised; nothing re-reads it).
    fs.mkdirSync(path.join(SCRATCH_CWD, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(SCRATCH_CWD, '.agenfk', 'project.json'), JSON.stringify({ projectId }));
    const savedDbPath = process.env.AGENFK_DB_PATH;
    const savedRoot = process.env.AGENFK_PROJECT_ROOT;
    delete process.env.AGENFK_DB_PATH;
    delete process.env.AGENFK_PROJECT_ROOT;
    process.chdir(SCRATCH_CWD);
    try {
      const result = await mcp.client.callTool({
        name: 'workflow_gatekeeper',
        arguments: { intent: 'mirror parity check' },
      } as any);
      const text = toolText(result);
      expect(result.isError).not.toBe(true);
      expect(text).toContain('AUTHORIZED');
      expect(text).toContain('mirror story');
    } finally {
      process.chdir(ORIGINAL_CWD);
      if (savedDbPath !== undefined) process.env.AGENFK_DB_PATH = savedDbPath;
      if (savedRoot !== undefined) process.env.AGENFK_PROJECT_ROOT = savedRoot;
    }
  });
});
