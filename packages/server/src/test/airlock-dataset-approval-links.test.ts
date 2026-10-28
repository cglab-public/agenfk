/**
 * A person's approve or deny labels the dataset rows that asked for it, even when
 * the server restarted in between (BUG 9ff092e9, epic review: the link lived in
 * memory only, so a restart - or 1000 newer approvals - lost it for good).
 *
 * The link is kept in the store, under the hub it was sent to: a label never joins
 * a row another hub holds, and answering takes the links (a second answer, or a
 * later request under the same key, is not labelled again from them).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { airlockDataset } from '../airlock/dataset';
import { AIRLOCK_APPROVAL_LINK_MAX_TOTAL } from '@agenfk/storage-sqlite';

let storage: SQLiteStorageProvider;
let tmp: string;
let sent: Array<{ type: string; payload: any }>;
let hub: string | null;
let failSend: boolean;

const make = () => airlockDataset({
  enabled: () => true,
  send: (e) => { if (failSend && e.type === 'airlock.dataset-label') throw new Error('outbox write failed'); sent.push(e); },
  redactCommand: (s) => s,
  redactText: (s) => s,
  approvalLinks: {
    add: (key, rowId) => hub ? storage.airlockDatasetLinkApproval(key, hub, rowId) : undefined,
    rows: async (key) => (hub ? storage.airlockDatasetApprovalRows(key, hub) : []),
    drop: (key) => (hub ? storage.airlockDatasetDropApprovalLinks(key, hub) : undefined),
    mark: (key, decision) => (hub ? storage.airlockDatasetMarkApprovalAnswered(key, hub, decision) : undefined),
    answered: async () => (hub ? storage.airlockDatasetAnsweredApprovalLinks(hub) : []),
  },
});

const call = (approvalKey: string) => ({
  client: 'pi', model: 'qwen', sessionId: 's1', tool: 'bash', args: { command: 'gh gist create notes.md' },
  capabilities: [], verdict: { decision: 'needs-human-approval' }, mode: 'enforce', revision: 1, card: null, approvalKey,
});
const labels = () => sent.filter(e => e.type === 'airlock.dataset-label').map(e => e.payload);

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-links-'));
  storage = new SQLiteStorageProvider();
  await storage.init({ path: path.join(tmp, 'db.sqlite') });
  sent = [];
  failSend = false;
  hub = 'https://hub.example org-a';
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('approval labels across a restart (BUG 9ff092e9)', () => {
  it('rows asked before a restart are labelled by an answer after it', async () => {
    const before = make();
    const a = before.tool(call('k1#1'))!;
    const b = before.tool(call('k1#1'))!;
    await new Promise(r => setTimeout(r, 0));
    // the server restarts: a new dataset over the same store
    const after = make();
    await after.answered('k1#1', 'deny');
    expect(labels()).toEqual([
      { rowId: a, label: { kind: 'approval', decision: 'deny' } },
      { rowId: b, label: { kind: 'approval', decision: 'deny' } },
    ]);
  });

  it('an answer takes the links: answering again labels nothing more', async () => {
    const d = make();
    d.tool(call('k2#1'));
    await new Promise(r => setTimeout(r, 0));
    await d.answered('k2#1', 'grant');
    await make().answered('k2#1', 'grant');
    expect(labels()).toHaveLength(1);
  });

  it('a link made under one hub is not used under another', async () => {
    make().tool(call('k3#1'));
    await new Promise(r => setTimeout(r, 0));
    hub = 'https://other-hub.example org-b';
    await make().answered('k3#1', 'grant');
    expect(labels()).toEqual([]);
  });

  it('more approvals than the in-memory map ever held are all still labelled', async () => {
    const d = make();
    const rows: string[] = [];
    for (let i = 0; i < 1100; i++) rows.push(d.tool(call(`many-${i}#1`))!);
    await new Promise(r => setTimeout(r, 0));
    await make().answered('many-0#1', 'grant');
    expect(labels().map(l => l.rowId)).toEqual([rows[0]]);
  });

  it('review: links stay bounded in all, however many approvals are asked for', async () => {
    const t0 = performance.now();
    for (let i = 0; i < AIRLOCK_APPROVAL_LINK_MAX_TOTAL + 50; i++) await storage.airlockDatasetLinkApproval(`k-${i}#1`, hub!, `r-${i}`);
    // incremental, not a re-sort of the table per insert (Windows CI timed out at 60s on that)
    expect(performance.now() - t0).toBeLessThan(15_000);
    const n = (storage as any).database.prepare('SELECT COUNT(*) AS n FROM airlock_dataset_approval_rows').get().n;
    expect(n).toBe(AIRLOCK_APPROVAL_LINK_MAX_TOTAL);
    // the oldest went
    expect(await storage.airlockDatasetApprovalRows('k-0#1', hub!)).toEqual([]);
    expect(await storage.airlockDatasetApprovalRows(`k-${AIRLOCK_APPROVAL_LINK_MAX_TOTAL + 49}#1`, hub!)).toEqual([`r-${AIRLOCK_APPROVAL_LINK_MAX_TOTAL + 49}`]);
  }, 60_000);

  it('review: a label that could not be sent keeps its link, so a later answer still labels the row', async () => {
    const d = make();
    const a = d.tool(call('k9#1'))!;
    await new Promise(r => setTimeout(r, 0));
    failSend = true;
    await expect(make().answered('k9#1', 'grant')).rejects.toThrow('outbox write failed');
    failSend = false;
    await make().answered('k9#1', 'grant');
    expect(labels()).toEqual([{ rowId: a, label: { kind: 'approval', decision: 'grant' } }]);
  });
});
