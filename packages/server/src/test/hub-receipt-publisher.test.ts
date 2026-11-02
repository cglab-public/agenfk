/**
 * @file RFC-002 (task 0334a5e6) — the client publishes a verification receipt
 * to the hub ONCE, and only records it as delivered when the hub actually said
 * so.
 *
 * A receipt is a claim another machine has to honour, so the delivery state
 * written back onto the card is a promise about the hub's answer, not about our
 * own effort:
 *
 *  - `acked` only when the hub answered a receipt id. An acknowledgement that
 *    never arrived — a 5xx, a socket closed mid-request, a 200 whose body says
 *    nothing — leaves the receipt `pending` with the error, so the next tick
 *    tries again. Recording a delivery that did not happen is how a receipt
 *    would go missing forever.
 *  - `rejected` only when the hub refused the receipt itself (409, or any other
 *    4xx). Retrying a refusal cannot make it a receipt, so it is not retried —
 *    and because the loss is otherwise silent, the card is told in a comment.
 *  - `attempts` counts what we spent, so a receipt stuck in pending says how
 *    long the hub has been refusing to answer it.
 *
 * The report is the run's own log, gzipped beside the receipt. When the gzip
 * would be bigger than the agreed cap the client sends NO data and says so
 * (`{ omitted: 'over_cap', bytes }`): the hub then stores the receipt without a
 * report and marks it not reusable, which is honest, rather than truncating a
 * log that a reader would take for the whole thing. No log path, no `report`
 * key at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { removeTestDb } from './helpers/testDb';
import { publishPendingReceipts } from '../hub/receiptPublisher';
import type { FetchLike } from '../hub/flowSync';

const HUB_URL = 'http://hub.example.test';
const HUB_TOKEN = 'agk_test';
const HUB_ORG = 'org-a';

interface Call { url: string; method: string; headers: any; body: any }

/**
 * A fetch that answers what the test tells it to and records everything it was
 * asked, so a spec can assert both the request the hub saw and the requests
 * that were never made.
 */
function makeHubFetch(answer: (call: Call) => { status: number; body?: any } | Error) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, opts: any) => {
    const call: Call = {
      url,
      method: opts?.method ?? 'GET',
      headers: opts?.headers ?? {},
      body: typeof opts?.body === 'string' ? JSON.parse(opts.body) : opts?.body,
    };
    calls.push(call);
    const res = answer(call);
    if (res instanceof Error) throw res;
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      headers: { get: () => null },
      json: async () => res.body ?? {},
    } as any;
  });
  return { fetchImpl: fetchImpl as unknown as FetchLike, calls };
}

/** The log a real verify run leaves behind, at a path the receipt points at. */
const LOG_TEXT = 'log line\n'.repeat(50);

let logDir: string;
let logPath: string;

/** A receipt as the close path writes it (task f918a42c), minus its own id. */
const receipt = (over: Record<string, any> = {}): any => ({
  id: 'rcpt-1',
  kind: 'verification',
  version: 1,
  repo: 'git@github.com:acme/app.git',
  receiptsMode: 'shadow',
  card: {
    id: 'card-1',
    title: 'Publish the receipt',
    type: 'TASK',
    closedAt: '2026-06-01T10:00:00.000Z',
    owner: null,
    closedBy: { name: 'Dev', email: 'dev@acme.test' },
    link: null,
  },
  execution: {
    id: 'test-1',
    command: 'npm test',
    commandRevision: 1,
    exitCode: 0,
    startedAt: '2026-06-01T09:59:00.000Z',
    finishedAt: '2026-06-01T10:00:00.000Z',
    logPath,
  },
  content: { commit: 'b'.repeat(40), gitTree: 'a'.repeat(40), treeState: null, treeStateVersion: 1 },
  reusable: true,
  ...over,
});

describe('hub receiptPublisher.publishPendingReceipts', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `hub-receipt-publisher-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-receipt-log-'));
    logPath = path.join(logDir, 'test-1.log');
    fs.writeFileSync(logPath, LOG_TEXT);
  });

  afterEach(async () => {
    await removeTestDb(dbPath, () => storage.shutdown());
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  /** A review receipt as the record path writes it (task 95ba0ec5), minus its id. */
  const reviewReceipt = (over: Record<string, any> = {}): any => ({
    id: 'rev-1',
    kind: 'review',
    version: 1,
    repo: 'git@github.com:acme/app.git',
    receiptsMode: 'shadow',
    card: {
      id: 'card-1', title: 'Publish the receipt', type: 'TASK', owner: null,
      recordedBy: { name: 'Dev', email: 'dev@acme.test' }, link: null,
    },
    review: {
      recordId: 'rec-1',
      recordedAt: '2026-06-01T10:00:00.000Z',
      reviewer: { client: 'claude-code', sessionId: 'reviewer-session', agentId: 'agent1' },
      authors: [{ client: 'claude-code', sessionId: 'author-session', agentId: null }],
      independence: { outcome: 'pass', detail: 'reviewed by an independent session' },
      range: { from: 'c'.repeat(40), to: 'b'.repeat(40) },
      lenses: ['general'],
      findings: [],
      fixesAfterReview: null,
      transcriptSha256: 'd'.repeat(64),
    },
    humanGates: [],
    content: { commit: 'b'.repeat(40), gitTree: 'a'.repeat(40) },
    reusable: true,
    notReusableReason: null,
    ...over,
  });

  /** A project and a card, and `receipts` written onto the card. */
  async function seed(receipts: any[], into: 'verificationReceipts' | 'reviewReceipts' = 'verificationReceipts'): Promise<string> {
    await storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    await storage.createItem({
      id: 'card-1', projectId: 'p1', type: 'TASK', title: 'Publish the receipt',
      status: 'DONE', createdAt: new Date(), updatedAt: new Date(),
    } as any);
    const updated = await storage.updateItem('card-1', { [into]: receipts } as any);
    return updated.id;
  }

  const item = () => storage.getItem('card-1') as Promise<any>;
  const published = async (): Promise<any[]> => (await item())?.verificationReceipts ?? [];
  const publishedReviews = async (): Promise<any[]> => (await item())?.reviewReceipts ?? [];
  const args = (fetchImpl: FetchLike, over: Record<string, any> = {}) => ({
    storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, fetchImpl, ...over,
  } as any);

  it('the hub says new → the receipt is acked, and the hub saw the log gzipped', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const { fetchImpl, calls } = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: true, reason: null } }));

    const result = await publishPendingReceipts(args(fetchImpl));

    expect(result).toMatchObject({ acked: 1, rejected: 0, pending: 0 });
    expect(await published()).toHaveLength(1);
    expect((await published())[0].publication).toEqual({
      state: 'acked', attempts: 1, lastError: null, ackedAt: expect.any(String), reusable: true, reason: null,
    });
    expect(new Date((await published())[0].publication.ackedAt).getTime()).not.toBeNaN();

    // One call, to the receipts route, with the machine's own credentials.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${HUB_URL}/v1/receipts`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${HUB_TOKEN}`);
    expect(calls[0].headers['Content-Type']).toBe('application/json');

    // The receipt itself, and its report as a gzip stream the hub can open.
    expect(calls[0].body.receipt.id).toBe(rcpt.id);
    // The whole receipt as the card holds it, minus the delivery state, which
    // is ours and never leaves the machine.
    // The one exception: the log's path on this machine is sent as null.
    const { publication: _publication, ...stored } = (await published())[0];
    expect(calls[0].body.receipt).toEqual({ ...stored, execution: { ...stored.execution, logPath: null } });
    expect(calls[0].body.report.encoding).toBe('gzip+base64');
    expect(calls[0].body.report.bytes).toBe(Buffer.byteLength(LOG_TEXT));
    expect(zlib.gunzipSync(Buffer.from(calls[0].body.report.data, 'base64')).toString()).toBe(LOG_TEXT);
  });

  // Codex review of RFC-002: an answer naming ANOTHER receipt acknowledges nothing.
  it('a 2xx naming a different receipt id is NOT an acknowledgement of this one', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const { fetchImpl } = makeHubFetch(() => ({ status: 201, body: { id: 'someone-else', stored: 'new', reusable: true, reason: null } }));
    const result = await publishPendingReceipts(args(fetchImpl));
    expect(result).toMatchObject({ acked: 0, pending: 1 });
    expect((await published())[0].publication.state).toBe('pending');
  });

  // Codex review of RFC-002: the close path and the polling tick both publish.
  // Overlapping, an older 500 landing after a newer ack must not undo the ack.
  it('two publishes at once never overlap, and an ack is never undone by a later failure', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    let inFlight = 0;
    let maxInFlight = 0;
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      const mine = call;
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      // The first request is slow and fails; any later one succeeds at once.
      if (mine === 1) await new Promise(r => setTimeout(r, 60));
      inFlight -= 1;
      const status = mine === 1 ? 500 : 201;
      return { status, ok: status < 300, headers: { get: () => null }, json: async () => (status === 201 ? { id: rcpt.id, reusable: true, reason: null } : {}) } as any;
    }) as unknown as FetchLike;
    await Promise.all([publishPendingReceipts(args(fetchImpl)), publishPendingReceipts(args(fetchImpl))]);
    expect(maxInFlight, 'the two passes ran one after the other').toBe(1);
    expect((await published())[0].publication.state).toBe('acked');
  });

  // Codex second pass: one stalled hub must not hold every later publish.
  it('a hub that never finishes answering times out as pending, and the next pass still runs', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const stalled = vi.fn(() => new Promise<never>(() => { /* never answers */ })) as unknown as FetchLike;
    const started = Date.now();
    const first = await publishPendingReceipts(args(stalled, { timeoutMs: 50 }));
    expect(first).toMatchObject({ acked: 0, pending: 1 });
    expect((await published())[0].publication.lastError).toMatch(/did not answer/);
    const { fetchImpl } = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, reusable: true, reason: null } }));
    expect(await publishPendingReceipts(args(fetchImpl))).toMatchObject({ acked: 1 });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('a body that never finishes arriving times out too', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const trickle = vi.fn(async () => ({ status: 201, ok: true, headers: { get: () => null }, json: () => new Promise(() => { /* never ends */ }) })) as unknown as FetchLike;
    expect(await publishPendingReceipts(args(trickle, { timeoutMs: 50 }))).toMatchObject({ pending: 1 });
  });

  // Codex second pass: the size is read from the file system, never by reading the file.
  it.skipIf(process.platform === 'win32')('a log over the cap is refused on its size without being read', async () => {
    const huge = path.join(logDir, 'huge.log');
    const fd = fs.openSync(huge, 'w');
    fs.ftruncateSync(fd, 3 * 1024 * 1024 * 1024); // sparse 3 GiB: reading it whole would throw
    fs.closeSync(fd);
    const rcpt = receipt({ execution: { ...receipt().execution, logPath: huge } });
    await seed([rcpt]);
    const { fetchImpl, calls } = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, reusable: false, reason: 'report_over_cap' } }));
    await publishPendingReceipts(args(fetchImpl, { maxReportBytes: 100 }));
    expect(calls[0].body.report).toEqual({ omitted: 'over_cap', bytes: 3 * 1024 * 1024 * 1024 });
  });

  // Codex second pass: another process may settle the receipt while this pass waits on the hub.
  it('a receipt settled meanwhile stays settled when this pass hears a failure', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const fetchImpl = vi.fn(async () => {
      const cur: any = await storage.getItem('card-1');
      await storage.updateItem('card-1', { verificationReceipts: cur.verificationReceipts.map((r: any) => ({ ...r, publication: { state: 'acked', attempts: 1, lastError: null, ackedAt: '2026-06-01T00:00:00.000Z' } })) } as any);
      return { status: 500, ok: false, headers: { get: () => null }, json: async () => ({}) } as any;
    }) as unknown as FetchLike;
    await publishPendingReceipts(args(fetchImpl));
    expect((await published())[0].publication.state).toBe('acked');
  });

  // RFC-002: the log is redacted before it leaves the machine; the file on disk is not touched.
  it('uploads the log redacted, says how many redactions, and leaves the local file as it was', async () => {
    const secret = `agk_${'f'.repeat(64)}`;
    const text = `PASS a\nusing ${secret}\nDB_PASSWORD=hunter22\n`;
    fs.writeFileSync(logPath, text);
    const rcpt = receipt();
    await seed([rcpt]);
    const { fetchImpl, calls } = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, reusable: true, reason: null } }));
    await publishPendingReceipts(args(fetchImpl));
    const sent = zlib.gunzipSync(Buffer.from(calls[0].body.report.data, 'base64')).toString();
    expect(sent).not.toContain(secret);
    expect(sent).not.toContain('hunter22');
    expect(sent).toContain('PASS a');
    expect(calls[0].body.report.redactions).toBe(2);
    expect(calls[0].body.report.bytes).toBe(Buffer.byteLength(sent));
    expect(fs.readFileSync(logPath, 'utf8')).toBe(text);
  });

  it('does not send the log\'s path on this machine', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const { fetchImpl, calls } = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, reusable: true, reason: null } }));
    await publishPendingReceipts(args(fetchImpl));
    expect(calls[0].body.receipt.execution.logPath).toBeNull();
    expect(JSON.stringify(calls[0].body.receipt)).not.toContain(logPath);
    // The card keeps it: it is how this machine finds its own log.
    expect((await published())[0].execution.logPath).toBe(logPath);
  });

  it('an acked receipt is never published again', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const first = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: true, reason: null } }));
    expect((await publishPendingReceipts(args(first.fetchImpl))).acked).toBe(1);

    const second = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: true, reason: null } }));
    const again = await publishPendingReceipts(args(second.fetchImpl));

    expect(again).toMatchObject({ acked: 0, rejected: 0, pending: 0 });
    expect(second.calls).toHaveLength(0);
    // And it stays acked, with the attempt count of the one call that happened.
    expect((await published())[0].publication).toMatchObject({ state: 'acked', attempts: 1 });
  });

  it('a hub that answers 500 keeps the receipt pending, and the next tick acks it', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const down = makeHubFetch(() => ({ status: 500, body: { error: 'boom' } }));
    const afterDown = await publishPendingReceipts(args(down.fetchImpl));

    expect(afterDown).toMatchObject({ acked: 0, rejected: 0, pending: 1 });
    const afterFirst = (await published())[0].publication;
    expect(afterFirst.state).toBe('pending');
    expect(afterFirst.attempts).toBe(1);
    expect(String(afterFirst.lastError)).toContain('500');

    const back = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: true, reason: null } }));
    const afterUp = await publishPendingReceipts(args(back.fetchImpl));

    expect(afterUp).toMatchObject({ acked: 1, rejected: 0, pending: 0 });
    const pub = (await published())[0].publication;
    expect(pub.state).toBe('acked');
    expect(pub.attempts).toBe(2);
    expect(pub.lastError).toBeNull();
    expect(pub.ackedAt).toBeTruthy();
  });

  it('a network throw keeps it pending with the error, and is tried again', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const boom = makeHubFetch(() => new Error('ECONNREFUSED'));
    const out = await publishPendingReceipts(args(boom.fetchImpl));

    expect(out).toMatchObject({ pending: 1 });
    const pub = (await published())[0].publication;
    expect(pub.state).toBe('pending');
    expect(pub.attempts).toBe(1);
    expect(String(pub.lastError)).toContain('ECONNREFUSED');

    const back = makeHubFetch(() => ({ status: 200, body: { id: rcpt.id, stored: 'duplicate', reusable: true, reason: null } }));
    expect((await publishPendingReceipts(args(back.fetchImpl))).acked).toBe(1);
    expect((await published())[0].publication).toMatchObject({ state: 'acked', attempts: 2 });
  });

  it('a 200 whose body carries no id is NOT an acknowledgement', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const empty = makeHubFetch(() => ({ status: 200, body: {} }));
    const out = await publishPendingReceipts(args(empty.fetchImpl));

    expect(out).toMatchObject({ acked: 0, rejected: 0, pending: 1 });
    const pub = (await published())[0].publication;
    // The state the hub never confirmed is not recorded as delivered.
    expect(pub.state).toBe('pending');
    expect(pub.attempts).toBe(1);
    expect(pub.lastError).toBeTruthy();
    expect(pub.ackedAt).toBeNull();

    // And it is tried again, rather than being left acked forever.
    const again = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: true, reason: null } }));
    expect((await publishPendingReceipts(args(again.fetchImpl))).acked).toBe(1);
    expect((await published())[0].publication.state).toBe('acked');
  });

  it('a 409 receipt_conflict is rejected, not retried, and the card is told once', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const clash = makeHubFetch(() => ({ status: 409, body: { error: 'that id is another receipt', code: 'receipt_conflict' } }));
    const out = await publishPendingReceipts(args(clash.fetchImpl));

    expect(out).toMatchObject({ acked: 0, rejected: 1, pending: 0 });
    const pub = (await published())[0].publication;
    expect(pub.state).toBe('rejected');
    expect(pub.attempts).toBe(1);
    expect(String(pub.lastError)).toContain('409');
    expect(String(pub.lastError)).toContain('receipt_conflict');

    const comments = ((await item())?.comments ?? []) as any[];
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe('ValidateTool');
    expect(comments[0].content).toMatch(/refused/i);
    expect(comments[0].content).toContain('receipt');

    // A refusal is final: the next pass does not ask again, and says nothing more.
    const later = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: true, reason: null } }));
    expect(await publishPendingReceipts(args(later.fetchImpl))).toMatchObject({ acked: 0, rejected: 0, pending: 0 });
    expect(later.calls).toHaveLength(0);
    expect(((await item())?.comments ?? [])).toHaveLength(1);
  });

  it('any other 4xx is a refusal too', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const refused = makeHubFetch(() => ({ status: 404, body: { error: 'no such repository', code: 'repo_unknown' } }));
    expect(await publishPendingReceipts(args(refused.fetchImpl))).toMatchObject({ rejected: 1 });
    const pub = (await published())[0].publication;
    expect(pub.state).toBe('rejected');
    expect(String(pub.lastError)).toContain('404');
    expect(((await item())?.comments ?? [])).toHaveLength(1);
  });

  it('a report over the cap goes as omitted, with the size and no data', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    const { fetchImpl, calls } = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: false, reason: 'report_over_cap' } }));

    expect(await publishPendingReceipts(args(fetchImpl, { maxReportGzBytes: 10 }))).toMatchObject({ acked: 1 });

    expect(calls[0].body.report).toEqual({ omitted: 'over_cap', bytes: Buffer.byteLength(LOG_TEXT) });
    expect(JSON.stringify(calls[0].body.report)).not.toContain('log line');
  });

  it('a log bigger than the uncompressed cap goes as omitted, and is not gzipped at all', async () => {
    const rcpt = receipt();
    await seed([rcpt]);
    // The hub measures its cap on the UNCOMPRESSED log, so the client must too:
    // a 30 MB suite log gzips small, and a client that only looked at the gzip
    // would send it for the hub to throw away.
    fs.writeFileSync(logPath, 'x'.repeat(50));
    const { fetchImpl, calls } = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: false, reason: 'report_over_cap' } }));

    expect(await publishPendingReceipts(args(fetchImpl, { maxReportBytes: 10 }))).toMatchObject({ acked: 1 });

    expect(calls[0].body.report).toEqual({ omitted: 'over_cap', bytes: 50 });
    expect(JSON.stringify(calls[0].body.report)).not.toContain('xxx');
  });

  it('a card whose receipt has no log sends no report at all', async () => {
    const rcpt = receipt({ execution: { ...receipt().execution, logPath: null } });
    await seed([rcpt]);
    const { fetchImpl, calls } = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: true, reason: null } }));

    expect(await publishPendingReceipts(args(fetchImpl))).toMatchObject({ acked: 1 });
    expect('report' in calls[0].body).toBe(false);
  });

  it('a log that is not there is no report, and is still a receipt', async () => {
    const rcpt = receipt({ execution: { ...receipt().execution, logPath: path.join(logDir, 'vanished.log') } });
    await seed([rcpt]);
    const { fetchImpl, calls } = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: true, reason: null } }));

    expect(await publishPendingReceipts(args(fetchImpl))).toMatchObject({ acked: 1 });
    expect('report' in calls[0].body).toBe(false);
  });

  it('publishes every pending receipt on every card, and counts each by its answer', async () => {
    await seed([receipt({ id: 'rcpt-a' })]);
    await storage.createItem({
      id: 'card-2', projectId: 'p1', type: 'TASK', title: 'Another card',
      status: 'DONE', createdAt: new Date(), updatedAt: new Date(),
    } as any);
    await storage.updateItem('card-2', {
      verificationReceipts: [
        receipt({ id: 'rcpt-b' }),
        receipt({ id: 'rcpt-c', publication: { state: 'pending', attempts: 1, lastError: '500', ackedAt: null } }),
        receipt({ id: 'rcpt-d', publication: { state: 'acked', attempts: 1, lastError: null, ackedAt: '2026-06-01T10:00:00.000Z', reusable: true } }),
        receipt({ id: 'rcpt-e', publication: { state: 'rejected', attempts: 1, lastError: '409', ackedAt: null } }),
      ],
    } as any);

    const { fetchImpl, calls } = makeHubFetch((call) =>
      call.body.receipt.id === 'rcpt-c'
        ? { status: 503, body: { error: 'unavailable' } }
        : { status: 201, body: { id: call.body.receipt.id, stored: 'new', reusable: true, reason: null } });

    expect(await publishPendingReceipts(args(fetchImpl))).toMatchObject({ acked: 2, rejected: 0, pending: 1 });
    expect(calls.map(c => c.body.receipt.id).sort()).toEqual(['rcpt-a', 'rcpt-b', 'rcpt-c']);

    const byId = Object.fromEntries((await storage.getItem('card-2') as any).verificationReceipts.map((r: any) => [r.id, r.publication]));
    expect(byId['rcpt-b'].state).toBe('acked');
    // A receipt already pending keeps counting its attempts.
    expect(byId['rcpt-c']).toMatchObject({ state: 'pending', attempts: 2 });
    // Left alone: an ack is not re-published, a rejection is not re-tried.
    expect(byId['rcpt-d'].state).toBe('acked');
    expect(byId['rcpt-e'].state).toBe('rejected');
    expect(byId['rcpt-d'].attempts).toBe(1);
    expect(byId['rcpt-e'].attempts).toBe(1);
  });

  it('a review receipt goes as kind review, with no report, and its ack lands in reviewReceipts', async () => {
    // A review receipt is a claim about a REVIEW, not about a run: there is no
    // log of it to carry, so the body is the receipt alone, and the state we
    // write back goes into the array the receipt came from rather than into the
    // verification one.
    const rcpt = reviewReceipt();
    await seed([rcpt], 'reviewReceipts');
    const { fetchImpl, calls } = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'new', reusable: true, reason: null } }));

    expect(await publishPendingReceipts(args(fetchImpl))).toMatchObject({ acked: 1, rejected: 0, pending: 0 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${HUB_URL}/v1/receipts`);
    expect(calls[0].body.receipt.kind).toBe('review');
    expect(calls[0].body.receipt.id).toBe(rcpt.id);
    expect('report' in calls[0].body).toBe(false);
    // The whole receipt as the card holds it, minus the delivery state.
    const { publication: _publication, ...asSent } = (await publishedReviews())[0];
    expect(calls[0].body.receipt).toEqual(asSent);

    expect((await publishedReviews())[0].publication).toEqual({
      state: 'acked', attempts: 1, lastError: null, ackedAt: expect.any(String), reusable: true, reason: null,
    });
    // And it is not published again, which is the ack meaning what it says.
    const again = makeHubFetch(() => ({ status: 201, body: { id: rcpt.id, stored: 'duplicate', reusable: true, reason: null } }));
    expect(await publishPendingReceipts(args(again.fetchImpl))).toMatchObject({ acked: 0, pending: 0 });
    expect(again.calls).toHaveLength(0);
  });

  it('a card with no receipts and a project with no cards cost nothing', async () => {
    const { fetchImpl, calls } = makeHubFetch(() => ({ status: 201, body: {} }));
    expect(await publishPendingReceipts(args(fetchImpl))).toMatchObject({ acked: 0, rejected: 0, pending: 0 });
    expect(calls).toHaveLength(0);
  });
});
