/**
 * GH-398: the turns already stored under the old rule are re-attributed once,
 * on upgrade.
 *
 * Only sessions with subagents were charged wrongly (a session without any has
 * one transcript, and the journal is its own). For those, every stored turn is
 * charged again by the corrected rule, read from the session logs on disk. A
 * turn whose transcript (or, for a subagent with no claim, its parent's) is no
 * longer on disk cannot be re-derived, so it is not left on a guessed card: it
 * goes to no card, still counted for its project. Every card that gained or
 * lost turns has its stored usage (each step's row, the close total, and its
 * ancestors' close totals) recomputed from the corrected turns. The migration
 * runs once (a marker in the store) and by itself before the first ingestion
 * pass; it reports what it moved and cleared.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TokenEvent } from '@agenfk/core';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { reattributeSubagentUsage, REATTRIBUTION_MIGRATION } from '../token-ingestion/reattribute';
import { createUsageIngestion, defaultIngestionSources } from '../token-ingestion/service';
import { ClaudeTranscript } from './helpers/claudeTranscript';

const PARENT_CARD = 'aaaaaaaa-0000-4000-8000-000000000001';
const CARD_A = 'bbbbbbbb-0000-4000-8000-000000000002';
const CARD_B = 'cccccccc-0000-4000-8000-000000000003';
const EPIC = 'dddddddd-0000-4000-8000-000000000004';
const S = 'sess-mixed';

const t = (hhmm: string) => `2026-11-20T${hhmm}:00.000Z`;

describe('re-attribution of the stored turns (GH-398)', () => {
  let home: string;
  let projectDir: string;
  let storage: SQLiteStorageProvider;
  let seq = 0;

  /** A turn as the buggy version stored it: on whatever card the shared journal said. */
  const stored = async (tr: ClaudeTranscript, messageId: string, ts: string, itemId: string | null) => {
    const ev: TokenEvent = {
      id: `ev-${++seq}`, ts, client: 'claude-code', sessionId: tr.sessionId, turnId: messageId, dedupKey: messageId,
      model: 'claude-test', input: 10, cachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0, total: 15,
      ...(itemId ? { itemId } : {}), projectId: 'proj', sourcePath: tr.pathIn(projectDir), sourceOffset: seq,
    };
    await storage.insertTokenEvent(ev);
    return ev.id;
  };
  const cardOf = async (eventId: string) =>
    (await storage.queryTokenEvents({})).find((e) => e.id === eventId)!.itemId ?? null;
  const migrate = (opts: { force?: boolean } = {}) => reattributeSubagentUsage(storage, { ...opts, log: () => {} });

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gh398-reattr-'));
    projectDir = path.join(home, '.claude', 'projects', '-repo');
    fs.mkdirSync(projectDir, { recursive: true });
    storage = new SQLiteStorageProvider();
    await storage.init({ path: ':memory:' });
    await storage.createProject({ id: 'proj', name: 'p', projectRoot: '/repo', createdAt: new Date(), updatedAt: new Date() } as any);
    await storage.createItem({ id: EPIC, projectId: 'proj', type: 'EPIC', title: 'e', status: 'IN_PROGRESS', createdAt: new Date(t('09:00')), updatedAt: new Date() } as any);
    for (const id of [PARENT_CARD, CARD_A, CARD_B]) {
      await storage.createItem({ id, projectId: 'proj', parentId: id === CARD_A ? EPIC : undefined, type: 'TASK', title: id, status: 'IN_PROGRESS', createdAt: new Date(t('09:00')), updatedAt: new Date() } as any);
    }
  });
  afterEach(async () => { await storage.shutdown(); fs.rmSync(home, { recursive: true, force: true }); });

  /** Parent on PARENT_CARD, subagent A on CARD_A; the journal's last word was B's gatekeeper on CARD_B. */
  async function mixedSession() {
    const parent = new ClaudeTranscript(S);
    const a = new ClaudeTranscript(S, 'aaaa0001');
    const b = new ClaudeTranscript(S, 'bbbb0002');
    parent.gatekeeper(t('10:00'), PARENT_CARD);
    a.gatekeeper(t('10:01'), CARD_A);
    b.gatekeeper(t('10:02'), CARD_B);
    const ids = {
      aWork: await stored(a, a.turn(t('10:03')), t('10:03'), CARD_B),
      bWork: await stored(b, b.turn(t('10:04')), t('10:04'), CARD_B),
      parentWork: await stored(parent, parent.turn(t('10:05')), t('10:05'), CARD_B),
      aRight: await stored(a, a.turn(t('10:06')), t('10:06'), CARD_A),
    };
    for (const tr of [parent, a, b]) tr.writeTo(projectDir);
    return { parent, a, b, ids };
  }

  it('moves exactly the turns charged to the wrong card, and reports it', async () => {
    const { ids } = await mixedSession();
    const solo = new ClaudeTranscript('sess-solo');
    const soloTurn = await stored(solo, solo.turn(t('10:07')), t('10:07'), CARD_B);
    solo.writeTo(projectDir);

    const report = await migrate();

    expect(report).toMatchObject({ skipped: false, sessions: 1, moved: 2, cleared: 0 });
    expect(await cardOf(ids.aWork)).toBe(CARD_A);
    expect(await cardOf(ids.parentWork)).toBe(PARENT_CARD);
    expect(await cardOf(ids.bWork)).toBe(CARD_B);
    expect(await cardOf(ids.aRight)).toBe(CARD_A);
    expect(await cardOf(soloTurn)).toBe(CARD_B);
  });

  it('clears the card of a turn whose transcript is gone, rather than leave it on a guess', async () => {
    const { a, parent, ids } = await mixedSession();
    fs.unlinkSync(a.pathIn(projectDir));

    const report = await migrate();

    expect(report).toMatchObject({ moved: 1, cleared: 2 });
    expect(await cardOf(ids.aWork)).toBeNull();
    expect(await cardOf(ids.aRight)).toBeNull();
    expect(await cardOf(ids.parentWork)).toBe(PARENT_CARD);
    expect((await storage.queryTokenEvents({ itemId: null })).map((e) => e.projectId)).toEqual(['proj', 'proj']);
    void parent;
  });

  it('clears a subagent\'s unclaimed turn when the parent\'s transcript it would inherit from is gone', async () => {
    const parent = new ClaudeTranscript(S);
    const helper = new ClaudeTranscript(S, 'cccc0003');
    parent.gatekeeper(t('10:00'), PARENT_CARD);
    const helped = await stored(helper, helper.turn(t('10:01')), t('10:01'), CARD_B);
    helper.writeTo(projectDir);

    const report = await migrate();

    expect(report).toMatchObject({ sessions: 1, cleared: 1 });
    expect(await cardOf(helped)).toBeNull();
  });

  it('recomputes the stored usage of every card that gained or lost turns: step rows, close totals, ancestors', async () => {
    const { ids } = await mixedSession();
    const row = (n: number, from: string, to: string) => ({
      step: 'IN_PROGRESS', to: 'DONE', enteredAt: from, leftAt: to, complete: true,
      byModel: [{ client: 'claude-code', model: 'claude-test', turns: n, input: 10 * n, cacheRead: 0, cacheWrite: 0, output: 5 * n, reasoning: 0, costUsd: 0, unpricedTurns: n }],
      total: { turns: n, input: 10 * n, cacheRead: 0, cacheWrite: 0, output: 5 * n, reasoning: 0, costUsd: 0, unpricedTurns: n },
    });
    await storage.updateItem(CARD_B, { usageByStep: [row(3, t('09:00'), t('11:00'))] } as any);
    await storage.updateItem(CARD_A, { usageByStep: [row(1, t('09:00'), t('11:00'))], cardUsage: { ...row(1, t('09:00'), t('11:00')), byStep: [], cards: 1, complete: true, atStatus: 'DONE' } } as any);
    await storage.updateItem(EPIC, { cardUsage: { ...row(1, t('09:00'), t('11:00')), byStep: [], cards: 2, complete: true, atStatus: 'DONE' } } as any);

    const report = await migrate();

    const b: any = await storage.getItem(CARD_B);
    const a: any = await storage.getItem(CARD_A);
    const epic: any = await storage.getItem(EPIC);
    expect(b.usageByStep[0].total.turns).toBe(1);
    expect(b.usageByStep[0]).toMatchObject({ step: 'IN_PROGRESS', enteredAt: t('09:00'), leftAt: t('11:00'), complete: true });
    expect(a.usageByStep[0].total.turns).toBe(2);
    expect(a.cardUsage.total.turns).toBe(2);
    expect(a.cardUsage.atStatus).toBe('DONE');
    expect(epic.cardUsage.total.turns).toBe(2);
    expect(report.cardsRecomputed).toBeGreaterThanOrEqual(3);
    void ids;
  });

  it('runs once: a second call is skipped and moves nothing, and a forced one finds nothing left to move', async () => {
    await mixedSession();
    expect((await migrate()).moved).toBe(2);
    expect(await storage.getIngestionMeta(REATTRIBUTION_MIGRATION)).toBeTruthy();
    expect(await migrate()).toMatchObject({ skipped: true, moved: 0, cleared: 0 });
    expect(await migrate({ force: true })).toMatchObject({ skipped: false, moved: 0, cleared: 0 });
  });

  it('charges a subagent\'s turns before its first claim to that card, and the parent\'s turns after a subagent claimed its card to none, once', async () => {
    const parent = new ClaudeTranscript(S);
    const worker = new ClaudeTranscript(S, 'f0f00006');
    const helper = new ClaudeTranscript(S, 'f0f00007');
    parent.gatekeeper(t('10:00'), PARENT_CARD);
    const parentBefore = await stored(parent, parent.turn(t('10:01')), t('10:01'), PARENT_CARD);
    const orienting = await stored(worker, worker.turn(t('10:02')), t('10:02'), PARENT_CARD);
    const helping = await stored(helper, helper.turn(t('10:03')), t('10:03'), PARENT_CARD);
    worker.gatekeeper(t('10:04'), CARD_A);
    const parentHandedOff = await stored(parent, parent.turn(t('10:05')), t('10:05'), CARD_A);
    worker.gatekeeper(t('10:06'), PARENT_CARD);
    const parentAfter = await stored(parent, parent.turn(t('10:07')), t('10:07'), PARENT_CARD);
    const workerOnParentCard = await stored(worker, worker.turn(t('10:08')), t('10:08'), PARENT_CARD);
    for (const tr of [parent, worker, helper]) tr.writeTo(projectDir);

    const report = await migrate();

    expect(await cardOf(parentBefore)).toBe(PARENT_CARD);
    expect(await cardOf(orienting)).toBe(CARD_A);
    expect(await cardOf(helping)).toBe(PARENT_CARD);
    expect(await cardOf(parentHandedOff)).toBe(PARENT_CARD);
    expect(await cardOf(parentAfter)).toBeNull();
    expect(await cardOf(workerOnParentCard)).toBe(PARENT_CARD);
    expect(report).toMatchObject({ sessions: 1, moved: 3, cleared: 0 });
    expect(await migrate()).toMatchObject({ skipped: true, moved: 0 });
    expect(await migrate({ force: true })).toMatchObject({ skipped: false, moved: 0, cleared: 0 });
    expect(await cardOf(orienting)).toBe(CARD_A);
  });

  it('records the claims it read, so the next turns of a live session are charged by them', async () => {
    const { a } = await mixedSession();
    await migrate();
    expect(await storage.transcriptCardAt('claude-code', S, a.agentId!, t('12:00'))).toEqual({ itemId: CARD_A, projectId: 'proj' });
  });

  it('closes recorded before the fix (a card\'s move to DONE) end the claims made before them', async () => {
    const parent = new ClaudeTranscript(S);
    const a = new ClaudeTranscript(S, 'dddd0004');
    parent.turn(t('10:00'));
    a.gatekeeper(t('10:01'), CARD_A);
    await storage.updateItem(CARD_A, { status: 'DONE' } as any);
    const late = await stored(a, a.turn('2099-01-01T00:00:00.000Z'), '2099-01-01T00:00:00.000Z', CARD_A);
    for (const tr of [parent, a]) tr.writeTo(projectDir);

    await migrate();

    expect(await cardOf(late)).toBeNull();
  });

  it('a close into a flow\'s own final step (not named DONE) ends the claims made before it too', async () => {
    await storage.createFlow({ id: 'flow-closed', name: 'f', steps: [
      { id: 's1', name: 'TODO', order: 0, isSpecial: true }, { id: 's3', name: 'CLOSED', order: 2, isSpecial: true }, { id: 's2', name: 'WORK', order: 1 },
    ] } as any);
    await storage.updateProject('proj', { flowId: 'flow-closed' } as any);
    const parent = new ClaudeTranscript(S);
    const a = new ClaudeTranscript(S, 'eeee0005');
    parent.turn(t('10:00'));
    a.gatekeeper(t('10:01'), CARD_A);
    await storage.updateItem(CARD_A, { status: 'CLOSED' } as any);
    const late = await stored(a, a.turn('2099-01-01T00:00:00.000Z'), '2099-01-01T00:00:00.000Z', CARD_A);
    for (const tr of [parent, a]) tr.writeTo(projectDir);

    await migrate();

    expect(await cardOf(late)).toBeNull();
  });

  it('the usage service runs it by itself before its first pass, and logs what it did', async () => {
    await mixedSession();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const svc = createUsageIngestion({
        storage,
        sources: defaultIngestionSources(home, {}).filter((s) => s.client === 'claude-code'),
        now: () => new Date('2026-11-01T00:00:00Z'),
      });
      await svc.runOnce();
      expect(await storage.getIngestionMeta(REATTRIBUTION_MIGRATION)).toBeTruthy();
      expect(log.mock.calls.flat().join('\n')).toMatch(/GH-398.*moved 2 turn/);
    } finally {
      log.mockRestore();
    }
  });
});
