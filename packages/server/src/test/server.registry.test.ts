/**
 * Tests for POST /registry/flows/publish
 * Covers: owner direct-push path and non-owner fork+PR path.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as path from 'path';
import * as fs from 'fs';

// Hoist execSync mock so it's ready before server.ts is imported
const { mockExecSync } = vi.hoisted(() => ({ mockExecSync: vi.fn() }));
vi.mock('child_process', () => ({
  execSync: mockExecSync,
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('axios', () => {
  const m = vi.fn() as any;
  m.get = vi.fn();
  m.post = vi.fn();
  m.create = vi.fn(() => m);
  return { default: m };
});

import { app, initStorage } from '../server';

const TEST_DB = path.resolve('./server-registry-test-db.sqlite');

function makeExecMock(ghUser: string) {
  return (cmd: string) => {
    if (cmd.includes('gh --version')) return 'gh version 2.0.0';
    if (cmd.includes('gh api user')) return `${ghUser}\n`;
    if (cmd.includes('gh auth token')) return 'test-token\n';
    if (cmd.includes('gh pr create')) return 'https://github.com/cglab-public/agenfk-flows/pull/42\n';
    return '';
  };
}

describe('POST /registry/flows/publish', () => {
  let flowId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();

    const res = await request(app).post('/flows').send({
      name: 'Community Test Flow',
      description: 'A flow for testing publish',
      steps: [
        { name: 'in_progress', label: 'In Progress', order: 1, isSpecial: false },
      ],
    });
    expect(res.status).toBe(201);
    flowId = res.body.id;
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENFK_REGISTRY_OWNER;
    delete process.env.AGENFK_REGISTRY_REPO;
  });

  it('owner: pushes directly to main without forking, returns kind=direct', async () => {
    // ghUser 'cglab-public' matches the default REGISTRY_OWNER
    mockExecSync.mockImplementation(makeExecMock('cglab-public'));

    const res = await request(app).post('/registry/flows/publish').send({ flowId });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('direct');
    expect(res.body.url).toContain('cglab-public/agenfk-flows');

    const cmds = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    // No fork
    expect(cmds.some(c => c.includes('repo fork'))).toBe(false);
    // No PR
    expect(cmds.some(c => c.includes('gh pr create'))).toBe(false);
    // Pushed to main
    expect(cmds.some(c => c.includes('push origin main'))).toBe(true);
    // No branch switch
    expect(cmds.some(c => c.includes('checkout -b'))).toBe(false);
  });

  it('non-owner: forks and opens a PR, returns kind=pr', async () => {
    // ghUser 'external-user' does NOT match REGISTRY_OWNER 'cglab-public'
    mockExecSync.mockImplementation(makeExecMock('external-user'));

    const res = await request(app).post('/registry/flows/publish').send({ flowId });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('pr');
    expect(res.body.url).toContain('pull/42');

    const cmds = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    // Fork was called
    expect(cmds.some(c => c.includes('repo fork'))).toBe(true);
    // Remote switched to fork
    expect(cmds.some(c => c.includes('remote set-url'))).toBe(true);
    // Branch created
    expect(cmds.some(c => c.includes('checkout -b'))).toBe(true);
    // PR opened
    expect(cmds.some(c => c.includes('gh pr create'))).toBe(true);
  });

  it('returns 400 when flowId is missing', async () => {
    const res = await request(app).post('/registry/flows/publish').send({});
    expect(res.status).toBe(400);
  });

  it('returns 503 when gh CLI is not installed', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh --version')) throw new Error('not found');
      return '';
    });

    const res = await request(app).post('/registry/flows/publish').send({ flowId });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('gh CLI');
  });
});

// ── POST /registry/flows/install ─────────────────────────────────────────────

import axios from 'axios';

const INSTALL_DB = path.resolve('./server-registry-install-test-db.sqlite');

function makeRegistryFlowContent(steps: object[]) {
  return Buffer.from(JSON.stringify({
    name: 'Community Flow',
    description: 'A flow from the registry',
    steps,
  })).toString('base64');
}

describe('POST /registry/flows/install — anchor handling', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = INSTALL_DB;
    if (fs.existsSync(INSTALL_DB)) fs.unlinkSync(INSTALL_DB);
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(INSTALL_DB)) fs.unlinkSync(INSTALL_DB);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips TODO/DONE anchor steps from imported registry flow and adds fresh ones', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        content: makeRegistryFlowContent([
          { name: 'TODO', label: 'To Do', order: 0, isAnchor: true, exitCriteria: '' },
          { name: 'in_progress', label: 'In Progress', order: 1, exitCriteria: 'All tasks done' },
          { name: 'DONE', label: 'Done', order: 2, isAnchor: true, exitCriteria: '' },
        ]),
      },
    });

    const res = await request(app)
      .post('/registry/flows/install')
      .send({ filename: 'community-flow.json' });

    expect(res.status).toBe(200);
    const steps: any[] = res.body.steps;

    // Fresh TODO anchor must be present
    const todo = steps.find((s: any) => s.name === 'TODO');
    expect(todo).toBeDefined();
    expect(todo.isAnchor).toBe(true);

    // Fresh DONE anchor must be present
    const done = steps.find((s: any) => s.name === 'DONE');
    expect(done).toBeDefined();
    expect(done.isAnchor).toBe(true);

    // Middle step preserved
    const middle = steps.filter((s: any) => !s.isAnchor);
    expect(middle).toHaveLength(1);
    expect(middle[0].name).toBe('in_progress');
    expect(middle[0].exitCriteria).toBe('All tasks done');

    // TODO must be first, DONE must be last
    expect(steps[0].name).toBe('TODO');
    expect(steps[steps.length - 1].name).toBe('DONE');
  });

  it('adds TODO/DONE anchors when registry flow has none', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        content: makeRegistryFlowContent([
          { name: 'design', label: 'Design', order: 0, exitCriteria: 'Design approved' },
          { name: 'build', label: 'Build', order: 1, exitCriteria: 'Build passing' },
        ]),
      },
    });

    const res = await request(app)
      .post('/registry/flows/install')
      .send({ filename: 'design-flow.json' });

    expect(res.status).toBe(200);
    const steps: any[] = res.body.steps;

    expect(steps[0].name).toBe('TODO');
    expect(steps[0].isAnchor).toBe(true);
    expect(steps[steps.length - 1].name).toBe('DONE');
    expect(steps[steps.length - 1].isAnchor).toBe(true);

    const middle = steps.filter((s: any) => !s.isAnchor);
    expect(middle).toHaveLength(2);
    expect(middle[0].name).toBe('design');
    expect(middle[1].name).toBe('build');
  });
});
