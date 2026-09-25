/**
 * @file CGLAB-385 (S9-T1) — publishing to the community registry from this
 * machine (the gh path) keeps a flow's step roles and checks, and never
 * replaces a registry flow that has them with one that lacks them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as path from 'path';
import * as fs from 'fs';

const { mockExecSync, mockExecFileSync } = vi.hoisted(() => ({ mockExecSync: vi.fn(), mockExecFileSync: vi.fn() }));
vi.mock('child_process', () => ({ execSync: mockExecSync, execFileSync: mockExecFileSync, execFile: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

import { app, initStorage } from '../server';

const TEST_DB = path.resolve('./registry-publish-contracts-test-db.sqlite');
let __server: import('http').Server;
const agent = () => request(__server);
const rich = [
  { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { name: 'SPECS', label: 'Specs', order: 1, role: 'test-authoring' },
  { name: 'DONE', label: 'Done', order: 2, isAnchor: true },
];
let written: string | null = null;
/** What the registry clone holds for this flow before the publish (null = nothing). */
let onRegistry: string | null = null;

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
  __server = app.listen(0);
});
afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
});
beforeEach(() => {
  vi.clearAllMocks();
  written = null;
  onRegistry = null;
  mockExecSync.mockImplementation((cmd: string) => (cmd.includes('gh api user') ? 'cglab-public\n' : cmd.includes('gh auth token') ? 't\n' : ''));
  mockExecFileSync.mockImplementation((file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'clone' && onRegistry !== null) {
      const dir = args[args.length - 1];
      fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'flows', 'contract-flow.json'), onRegistry);
    }
    if (file === 'git' && args.includes('add')) {
      const dir = args[args.indexOf('-C') + 1];
      written = fs.readFileSync(path.join(dir, 'flows', 'contract-flow.json'), 'utf8');
    }
    return '';
  });
});

async function flowWith(steps: any[]) {
  const res = await agent().post('/flows').send({ name: 'Contract Flow', steps });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

describe('gh publish keeps the step contract', () => {
  it('writes role and checks into the registry file', async () => {
    const id = await flowWith(rich);
    const res = await agent().post('/registry/flows/publish').send({ flowId: id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.parse(written!).steps.find((s: any) => s.name === 'SPECS').role).toBe('test-authoring');
  });

  it('refuses to replace a registry flow that has roles/checks with one that has none', async () => {
    onRegistry = JSON.stringify({ name: 'Contract Flow', version: '1.0.0', steps: rich });
    const id = await flowWith(rich.map(({ role: _r, ...s }: any) => s));
    const res = await agent().post('/registry/flows/publish').send({ flowId: id });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/roles|checks/i);
    expect(written).toBeNull();
  });

  it('refuses a publish that drops one step\'s checks while another step keeps its role (step by step, S9 review)', async () => {
    const two = [...rich.slice(0, 2), { name: 'BUILD', label: 'Build', order: 2, role: 'coding', checks: [{ id: 'jira-key-valid' }] }, { ...rich[2], order: 3 }];
    onRegistry = JSON.stringify({ name: 'Contract Flow', version: '1.0.0', steps: two });
    const id = await flowWith(two.map(({ checks: _c, ...s }: any) => s));
    const res = await agent().post('/registry/flows/publish').send({ flowId: id });
    expect(res.status).toBe(409);
    expect(written).toBeNull();
  });

  it('publishes a deliberate removal when allowContractRemoval is true', async () => {
    onRegistry = JSON.stringify({ name: 'Contract Flow', version: '1.0.0', steps: rich });
    const id = await flowWith(rich.map(({ role: _r, ...s }: any) => s));
    const res = await agent().post('/registry/flows/publish').send({ flowId: id, allowContractRemoval: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.parse(written!).steps.find((s: any) => s.name === 'SPECS').role).toBeUndefined();
  });
});
