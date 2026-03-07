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
  return { default: m };
});

import { app, initStorage } from '../server';

const TEST_DB = path.resolve('./server-registry-test-db.json');

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
