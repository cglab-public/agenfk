/**
 * Unit tests for the client-side flowSync reconciler.
 *
 * The reconciler periodically pulls the org's hub-managed flow from the corp
 * Hub's `/v1/flows/active` endpoint and reconciles it into local storage with
 * `source = 'hub'`. We drive it with a fake fetch + a real SQLiteStorageProvider
 * (file-backed, isolated per test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { removeTestDb } from './helpers/testDb';
import { reconcileProjectFlow } from '../hub/flowSync';

const baseSteps = [
  { id: 's0', name: 'todo',  label: 'Todo',   order: 0, isAnchor: true },
  { id: 's1', name: 'work',  label: 'Work',   order: 1 },
  { id: 's2', name: 'done',  label: 'Done',   order: 2, isAnchor: true },
];

const HUB_URL = 'http://hub.example.test';
const HUB_TOKEN = 'agk_test';
const HUB_ORG = 'org-a';

function makeFetchSequence(seq: Array<{ status: number; body?: any; etag?: string }>) {
  let i = 0;
  return vi.fn(async (_url: string, _opts: any) => {
    const r = seq[Math.min(i, seq.length - 1)];
    i++;
    const headers: Record<string, string> = {};
    if (r.etag) headers['etag'] = r.etag;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => r.body ?? {},
    } as any;
  });
}

describe('flowSync.reconcileProjectFlow (org scope, no project)', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;
  let emit: ReturnType<typeof vi.fn>;
  const hubConfig = { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG };
  const reconcile = (fetchImpl: any, lastEtag: string | null = null) =>
    reconcileProjectFlow({ storage, hubConfig, projectId: null, lastEtag, fetchImpl, emit });

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `flow-sync-proj-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    emit = vi.fn();
  });

  afterEach(async () => {
    await removeTestDb(dbPath, () => storage.shutdown());
  });

  it("keeps a hub flow's verifyAt (281adef0)", async () => {
    await reconcile(makeFetchSequence([{ status: 200, etag: 'W/"9"', body: { flow: { id: 'remote-va', name: 'VA Flow', description: '', verifyAt: 'parent', steps: baseSteps }, hubVersion: 9 } }]));
    const f = (await storage.listFlows()).find(x => x.hubFlowId === 'remote-va');
    expect((f as any)?.verifyAt).toBe('parent');
  });

  it('turns verifyAt back off when the hub does (281adef0 review): updateFlow merges, so the key is always written', async () => {
    await reconcile(makeFetchSequence([{ status: 200, etag: 'W/"10"', body: { flow: { id: 'remote-off', name: 'Off Flow', description: '', verifyAt: 'parent', steps: baseSteps }, hubVersion: 10 } }]));
    await reconcile(makeFetchSequence([{ status: 200, etag: 'W/"11"', body: { flow: { id: 'remote-off', name: 'Off Flow', description: '', steps: baseSteps }, hubVersion: 11 } }]), 'W/"10"');
    const f = (await storage.listFlows()).find(x => x.hubFlowId === 'remote-off');
    expect((f as any)?.verifyAt).toBe('leaf');
  });

  it("keeps a hub flow's verifyAtScope, and drops it when the hub does (7ddeaf7c)", async () => {
    await reconcile(makeFetchSequence([{ status: 200, etag: 'W/"12"', body: { flow: { id: 'remote-scope', name: 'Scope Flow', description: '', verifyAt: 'parent', verifyAtScope: 'project', steps: baseSteps }, hubVersion: 12 } }]));
    expect(((await storage.listFlows()).find(x => x.hubFlowId === 'remote-scope') as any)?.verifyAtScope).toBe('project');
    await reconcile(makeFetchSequence([{ status: 200, etag: 'W/"13"', body: { flow: { id: 'remote-scope', name: 'Scope Flow', description: '', verifyAt: 'parent', steps: baseSteps }, hubVersion: 13 } }]), 'W/"12"');
    expect(((await storage.listFlows()).find(x => x.hubFlowId === 'remote-scope') as any)?.verifyAtScope).toBe('worktree');
  });

  it('a bumped hub version updates the existing row and keeps its local id', async () => {
    const r1 = await reconcile(makeFetchSequence([{ status: 200, etag: 'W/"1"', body: { flow: { id: 'remote-x', name: 'V1', description: '', steps: baseSteps }, hubVersion: 1 } }]));
    expect(r1.outcome).toBe('updated');
    const localId = (await storage.listFlows())[0].id;
    await reconcile(makeFetchSequence([{ status: 200, etag: 'W/"2"', body: { flow: { id: 'remote-x', name: 'V2', description: '', steps: baseSteps }, hubVersion: 2 } }]), 'W/"1"');
    const flows = await storage.listFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0].id).toBe(localId);
    expect(flows[0].hubVersion).toBe(2);
    expect(flows[0].name).toBe('V2');
  });

  it('sends the hub token as a bearer Authorization header, and the last ETag as If-None-Match', async () => {
    const fetchImpl = makeFetchSequence([{ status: 304 }]);
    await reconcile(fetchImpl, 'W/"7"');
    const [url, opts] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe(`${HUB_URL}/v1/flows/active`);
    expect(opts.headers['Authorization']).toBe(`Bearer ${HUB_TOKEN}`);
    expect(opts.headers['If-None-Match']).toBe('W/"7"');
  });
});
