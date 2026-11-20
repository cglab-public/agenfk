/**
 * GH-398: parallel subagents of one Claude Code session charged their usage
 * to each other's cards.
 *
 * A subagent's Bash runs with the PARENT's session id (Claude Code gives it no
 * agent id of its own), so every gatekeeper and verify a subagent ran wrote
 * the shared session-to-card journal, and whichever ran last set the card for
 * all of them and for the parent. Measured 2026-11-20: up to 71% of a card's
 * turns came from other agents.
 *
 * In a session with subagents, each transcript is now charged by its OWN
 * claims (its gatekeeper and verify calls): a subagent by its own, its turns
 * before its first claim by that first claim, and only a subagent that never
 * claims by the parent's card at the time; the parent by its own only, each
 * ended by a subagent's claim on the same card. A session without subagents
 * keeps the journal. These run the real parser, watcher and SQLite
 * store over session logs laid out as the harness writes them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { ingestOnce } from '../token-ingestion/watcher';
import { defaultIngestionSources } from '../token-ingestion/service';
import { ClaudeTranscript } from './helpers/claudeTranscript';

const PARENT_CARD = '11111111-0000-4000-8000-000000000001';
const CARD_A = '22222222-0000-4000-8000-000000000002';
const CARD_B = '33333333-0000-4000-8000-000000000003';
const S = 'sess-0000-parallel';

describe('usage attribution in a session with subagents (GH-398)', () => {
  let home: string;
  let projectDir: string;
  let storage: SQLiteStorageProvider;

  const t = (hhmm: string) => `2026-11-20T${hhmm}:00.000Z`;
  /** What the CLI posts to the journal: the PARENT session id, whoever ran it. */
  const journal = (itemId: string | null, at: string, sessionId = S) =>
    storage.recordSessionCard({ client: 'claude-code', sessionId, itemId, projectId: 'proj', at });

  const ingest = () => ingestOnce({
    storage,
    sources: defaultIngestionSources(home, {}).filter((s) => s.client === 'claude-code'),
    attributeEvents: true,
  });
  const cardOf = async (messageId: string) => {
    const rows = (await storage.queryTokenEvents({})).filter((e) => e.dedupKey === messageId);
    expect(rows).toHaveLength(1);
    return rows[0].itemId ?? null;
  };

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gh398-attr-'));
    projectDir = path.join(home, '.claude', 'projects', '-repo');
    fs.mkdirSync(projectDir, { recursive: true });
    storage = new SQLiteStorageProvider();
    await storage.init({ path: ':memory:' });
    await storage.createProject({ id: 'proj', name: 'p', projectRoot: '/repo', createdAt: new Date(), updatedAt: new Date() } as any);
    for (const id of [PARENT_CARD, CARD_A, CARD_B]) {
      await storage.createItem({ id, projectId: 'proj', type: 'TASK', title: id, status: 'IN_PROGRESS', createdAt: new Date(t('09:00')), updatedAt: new Date() } as any);
    }
  });
  afterEach(async () => { await storage.shutdown(); fs.rmSync(home, { recursive: true, force: true }); });

  it('parallel subagents on different cards are each charged to their own card, and the parent to its own', async () => {
    const parent = new ClaudeTranscript(S);
    const a = new ClaudeTranscript(S, 'aaaa1111');
    const b = new ClaudeTranscript(S, 'bbbb2222');

    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    const parentEarly = parent.turn(t('10:01'));
    a.gatekeeper(t('10:04'), CARD_A); await journal(CARD_A, t('10:04'));
    b.gatekeeper(t('10:05'), CARD_B.slice(0, 8)); await journal(CARD_B, t('10:05'));
    const aWork = a.turn(t('10:06'));
    const bWork = b.turn(t('10:07'));
    const parentLater = parent.turn(t('10:08'));
    const aMore = a.turn(t('10:09'));
    for (const tr of [parent, a, b]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(parentEarly)).toBe(PARENT_CARD);
    expect(await cardOf(aWork)).toBe(CARD_A);
    expect(await cardOf(aMore)).toBe(CARD_A);
    expect(await cardOf(bWork)).toBe(CARD_B);
    expect(await cardOf(parentLater)).toBe(PARENT_CARD);
  });

  it('a subagent that names a card is charged to its first card from its first turn, before it named it', async () => {
    const parent = new ClaudeTranscript(S);
    const worker = new ClaudeTranscript(S, 'cccc3333');

    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    const orienting = worker.turn(t('10:01'));
    const firstCall = worker.gatekeeper(t('10:02'), CARD_A); await journal(CARD_A, t('10:02'));
    const working = worker.turn(t('10:03'));
    const switching = worker.gatekeeper(t('10:04'), CARD_B); await journal(CARD_B, t('10:04'));
    const onB = worker.turn(t('10:05'));
    for (const tr of [parent, worker]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(orienting)).toBe(CARD_A);
    expect(await cardOf(firstCall)).toBe(CARD_A);
    expect(await cardOf(working)).toBe(CARD_A);
    expect(await cardOf(switching)).toBe(CARD_A);
    expect(await cardOf(onB)).toBe(CARD_B);
  });

  it('a subagent\'s turns stored before its first claim was read are charged again to that card when it is, once', async () => {
    const parent = new ClaudeTranscript(S);
    const worker = new ClaudeTranscript(S, 'c0c03333');
    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    parent.turn('2026-11-20T10:00:30.000Z');
    const o1 = worker.turn(t('10:01'));
    const o2 = worker.turn(t('10:02'));
    parent.writeTo(projectDir);
    worker.writeTo(projectDir);
    await ingest();
    expect(await cardOf(o1)).toBe(PARENT_CARD);

    worker.gatekeeper(t('10:03'), CARD_A); await journal(CARD_A, t('10:03'));
    const working = worker.turn(t('10:04'));
    worker.writeTo(projectDir);
    await ingest();

    expect(await cardOf(o1)).toBe(CARD_A);
    expect(await cardOf(o2)).toBe(CARD_A);
    expect(await cardOf(working)).toBe(CARD_A);

    await ingest();
    expect((await storage.queryTokenEvents({ itemId: CARD_A })).length).toBe(4);
    expect((await storage.queryTokenEvents({ itemId: PARENT_CARD })).length).toBe(1);
  });

  it('turns charged again keep the card usage stored at a transition right: the step rows of both cards are recomputed', async () => {
    const parent = new ClaudeTranscript(S);
    const worker = new ClaudeTranscript(S, 'c1c13333');
    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    parent.turn('2026-11-20T10:00:30.000Z');
    worker.turn(t('10:01'));
    worker.turn(t('10:02'));
    parent.writeTo(projectDir);
    worker.writeTo(projectDir);
    await ingest();
    const stepRow = (turns: number) => ({
      step: 'IN_PROGRESS', to: 'REVIEW', enteredAt: t('09:00'), leftAt: t('10:30'), complete: true,
      byModel: [{ client: 'claude-code', model: 'claude-test', turns, input: 10 * turns, cacheRead: 0, cacheWrite: 0, output: 5 * turns, reasoning: 0, costUsd: 0, unpricedTurns: turns }],
      total: { turns, input: 10 * turns, cacheRead: 0, cacheWrite: 0, output: 5 * turns, reasoning: 0, costUsd: 0, unpricedTurns: turns },
    });
    await storage.updateItem(PARENT_CARD, { usageByStep: [stepRow(3)] } as any);
    await storage.updateItem(CARD_A, { usageByStep: [stepRow(0)] } as any);

    worker.gatekeeper(t('10:03'), CARD_A); await journal(CARD_A, t('10:03'));
    worker.writeTo(projectDir);
    await ingest();

    expect(((await storage.getItem(PARENT_CARD)) as any).usageByStep[0].total.turns).toBe(1);
    expect(((await storage.getItem(CARD_A)) as any).usageByStep[0].total.turns).toBe(3);
  });

  it('GH-397: turns charged again keep the price stored when they were used, and the recomputed step rows carry it', async () => {
    // claude-test at $100k/M input and $200k/M output: a 10-in, 5-out turn is $2.
    const prices = async () => ({ prices: [{ id: 'claude-test', input: 100_000, output: 200_000 }] });
    const pricedIngest = () => ingestOnce({
      storage,
      sources: defaultIngestionSources(home, {}).filter((s) => s.client === 'claude-code'),
      attributeEvents: true,
      prices,
    });
    const parent = new ClaudeTranscript(S);
    const worker = new ClaudeTranscript(S, 'c9c93333');
    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    parent.turn('2026-11-20T10:00:30.000Z');
    const o1 = worker.turn(t('10:01'));
    worker.turn(t('10:02'));
    parent.writeTo(projectDir);
    worker.writeTo(projectDir);
    await pricedIngest();
    const row = { step: 'IN_PROGRESS', to: 'REVIEW', enteredAt: t('09:00'), leftAt: t('10:30'), complete: true, byModel: [], total: {} };
    await storage.updateItem(PARENT_CARD, { usageByStep: [row] } as any);
    await storage.updateItem(CARD_A, { usageByStep: [row] } as any);

    worker.gatekeeper(t('10:03'), CARD_A); await journal(CARD_A, t('10:03'));
    worker.writeTo(projectDir);
    await pricedIngest();

    const moved = (await storage.queryTokenEvents({})).find((e) => e.dedupKey === o1)!;
    expect(moved.itemId).toBe(CARD_A);
    expect(moved.estimatedCostUsd).toBeCloseTo(2, 9);
    const a = ((await storage.getItem(CARD_A)) as any).usageByStep[0];
    // Its two turns and the gatekeeper call's own, all on the card it claimed.
    expect(a.total).toMatchObject({ turns: 3, unpricedTurns: 0 });
    expect(a.total.estimatedCostUsd).toBeCloseTo(6, 9);
    expect(a.byModel[0].estimatedCostUsd).toBeCloseTo(6, 9);
    const p = ((await storage.getItem(PARENT_CARD)) as any).usageByStep[0];
    expect(p.total).toMatchObject({ turns: 1, unpricedTurns: 0 });
    expect(p.total.estimatedCostUsd).toBeCloseTo(2, 9);
  });

  it('a helper that never names a card inherits the parent\'s card at the time', async () => {
    const parent = new ClaudeTranscript(S);
    const helper = new ClaudeTranscript(S, 'dddd4444');

    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    const reviewing = helper.turn(t('10:03'));
    parent.gatekeeper(t('10:04'), CARD_B); await journal(CARD_B, t('10:04'));
    const reviewingLater = helper.turn(t('10:05'));
    for (const tr of [parent, helper]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(reviewing)).toBe(PARENT_CARD);
    expect(await cardOf(reviewingLater)).toBe(CARD_B);
  });

  it('a parent that hands its card to a subagent is charged to no card from the subagent\'s claim on it', async () => {
    const parent = new ClaudeTranscript(S);
    const worker = new ClaudeTranscript(S, 'f0f01111');

    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    const before = parent.turn(t('10:01'));
    const spawning = parent.turn(t('10:02'));
    worker.gatekeeper(t('10:05'), PARENT_CARD); await journal(PARENT_CARD, t('10:05'));
    const workerTurn = worker.turn(t('10:06'));
    const coordinating = parent.turn(t('10:07'));
    for (const tr of [parent, worker]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(before)).toBe(PARENT_CARD);
    expect(await cardOf(spawning)).toBe(PARENT_CARD);
    expect(await cardOf(workerTurn)).toBe(PARENT_CARD);
    expect(await cardOf(coordinating)).toBeNull();
  });

  it('the parent\'s turns stored before the subagent\'s claim was read are taken off the handed-off card when it is', async () => {
    const parent = new ClaudeTranscript(S);
    const worker = new ClaudeTranscript(S, 'f1f11111');
    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    const before = parent.turn(t('10:01'));
    const coordinating = parent.turn(t('10:07'));
    parent.writeTo(projectDir);
    worker.turn(t('10:04'));
    worker.writeTo(projectDir);
    await ingest();
    expect(await cardOf(coordinating)).toBe(PARENT_CARD);

    worker.gatekeeper(t('10:05'), PARENT_CARD); await journal(PARENT_CARD, t('10:05'));
    worker.writeTo(projectDir);
    await ingest();

    expect(await cardOf(before)).toBe(PARENT_CARD);
    expect(await cardOf(coordinating)).toBeNull();
  });

  it('a parent that claims the handed-off card again is back on it, until a subagent claims it after that', async () => {
    const parent = new ClaudeTranscript(S);
    const worker = new ClaudeTranscript(S, 'f2f21111');

    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    worker.gatekeeper(t('10:05'), PARENT_CARD); await journal(PARENT_CARD, t('10:05'));
    const waiting = parent.turn(t('10:06'));
    parent.verify(t('10:10'), PARENT_CARD); await journal(PARENT_CARD, t('10:10'));
    const reviewing = parent.turn(t('10:11'));
    worker.gatekeeper(t('10:15'), PARENT_CARD); await journal(PARENT_CARD, t('10:15'));
    const waitingAgain = parent.turn(t('10:16'));
    parent.gatekeeper(t('10:20'), CARD_B); await journal(CARD_B, t('10:20'));
    const onB = parent.turn(t('10:21'));
    for (const tr of [parent, worker]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(waiting)).toBeNull();
    expect(await cardOf(reviewing)).toBe(PARENT_CARD);
    expect(await cardOf(waitingAgain)).toBeNull();
    expect(await cardOf(onB)).toBe(CARD_B);
  });

  it('after handing a card to subagents, a coordinating parent is charged to no card, not to theirs', async () => {
    const parent = new ClaudeTranscript(S);
    const a = new ClaudeTranscript(S, 'eeee5555');

    const coordinating = parent.turn(t('10:00'));
    const claiming = a.gatekeeper(t('10:01'), CARD_A); await journal(CARD_A, t('10:01'));
    const waiting = parent.turn(t('10:02'));
    for (const tr of [parent, a]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(coordinating)).toBeNull();
    expect(await cardOf(waiting)).toBeNull();
    expect(await cardOf(claiming)).toBe(CARD_A);
    expect(await storage.queryTokenEvents({ itemId: null })).toHaveLength(2);
  });

  it('a card\'s close ends the subagent\'s claim on it, though the closing verify\'s reply comes after the close', async () => {
    const parent = new ClaudeTranscript(S);
    const a = new ClaudeTranscript(S, 'ffff6666');

    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    a.gatekeeper(t('10:01'), CARD_A); await journal(CARD_A, t('10:01'));
    a.verify(t('10:10'), CARD_A, 'Item is now on DONE.');
    await journal(CARD_A, '2026-11-20T10:10:00.200Z');
    await storage.endSessionCards(CARD_A, '2026-11-20T10:10:00.300Z');
    const report = a.turn(t('10:11'));
    for (const tr of [parent, a]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(report)).toBeNull();
  });

  it('a dead subagent\'s claim captures nothing once another transcript takes over the card', async () => {
    const parent = new ClaudeTranscript(S);
    const dead = new ClaudeTranscript(S, 'a87be613c9077dcae');
    const successor = new ClaudeTranscript(S, 'aa20e0f6adf487b0c');

    dead.gatekeeper(t('10:00'), CARD_A); await journal(CARD_A, t('10:00'));
    const deadWork = dead.turn(t('10:01'));
    const parentRelaunch = parent.turn(t('10:30'));
    successor.gatekeeper(t('10:31'), CARD_A); await journal(CARD_A, t('10:31'));
    const successorWork = successor.turn(t('10:32'));
    const parentWaits = parent.turn(t('10:33'));
    for (const tr of [parent, dead, successor]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(deadWork)).toBe(CARD_A);
    expect(await cardOf(successorWork)).toBe(CARD_A);
    expect(await cardOf(parentRelaunch)).toBeNull();
    expect(await cardOf(parentWaits)).toBeNull();
  });

  it('the turn that makes the call stays on the previous card, whether its reply is read in the same pass or a later one', async () => {
    const parent = new ClaudeTranscript(S);
    const a = new ClaudeTranscript(S, 'acac9999');
    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    a.gatekeeper(t('10:01'), CARD_A); await journal(CARD_A, t('10:01'));
    const calling = a.gatekeeper(t('10:02'), CARD_B); await journal(CARD_B, t('10:02'));
    const after = a.turn(t('10:03'));
    for (const tr of [parent, a]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(calling)).toBe(CARD_A);
    expect(await cardOf(after)).toBe(CARD_B);
  });

  it('a session without subagents keeps the journal, as before', async () => {
    const solo = new ClaudeTranscript('sess-solo');
    await journal(CARD_B, t('10:00'), 'sess-solo');
    const work = solo.turn(t('10:01'));
    solo.writeTo(projectDir);

    await ingest();

    expect(await cardOf(work)).toBe(CARD_B);
  });

  it('a claim by a short id that matches no single card is no claim: the turn falls back to the parent\'s card', async () => {
    const parent = new ClaudeTranscript(S);
    const a = new ClaudeTranscript(S, 'abab7777');
    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    a.verify(t('10:01'), '99999999');
    const work = a.turn(t('10:02'));
    for (const tr of [parent, a]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(work)).toBe(PARENT_CARD);
  });

  it('a subagent log ingested in a later pass than its parent\'s still finds the parent\'s claims', async () => {
    const parent = new ClaudeTranscript(S);
    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    parent.turn(t('10:01'));
    parent.writeTo(projectDir);
    await ingest();

    const helper = new ClaudeTranscript(S, 'cdcd8888');
    const work = helper.turn(t('10:05'));
    helper.writeTo(projectDir);
    await journal(CARD_A, t('10:04'));
    await ingest();

    expect(await cardOf(work)).toBe(PARENT_CARD);
  });
});
