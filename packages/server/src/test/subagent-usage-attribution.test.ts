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
 * claims (its gatekeeper and verify calls): a subagent by its own, else the
 * parent's card at the time; the parent by its own only. A session without
 * subagents keeps the journal. These run the real parser, watcher and SQLite
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

  it('a subagent that has not named a card yet, and a helper that never does, inherit the parent\'s card at the time', async () => {
    const parent = new ClaudeTranscript(S);
    const worker = new ClaudeTranscript(S, 'cccc3333');
    const helper = new ClaudeTranscript(S, 'dddd4444');

    parent.gatekeeper(t('10:00'), PARENT_CARD); await journal(PARENT_CARD, t('10:00'));
    const beforeClaim = worker.turn(t('10:01'));
    worker.gatekeeper(t('10:02'), CARD_A); await journal(CARD_A, t('10:02'));
    const reviewing = helper.turn(t('10:03'));
    parent.gatekeeper(t('10:04'), CARD_B); await journal(CARD_B, t('10:04'));
    const reviewingLater = helper.turn(t('10:05'));
    for (const tr of [parent, worker, helper]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(beforeClaim)).toBe(PARENT_CARD);
    expect(await cardOf(reviewing)).toBe(PARENT_CARD);
    expect(await cardOf(reviewingLater)).toBe(CARD_B);
  });

  it('after handing a card to subagents, a coordinating parent is charged to no card, not to theirs', async () => {
    const parent = new ClaudeTranscript(S);
    const a = new ClaudeTranscript(S, 'eeee5555');

    const coordinating = parent.turn(t('10:00'));
    a.gatekeeper(t('10:01'), CARD_A); await journal(CARD_A, t('10:01'));
    const waiting = parent.turn(t('10:02'));
    for (const tr of [parent, a]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(coordinating)).toBeNull();
    expect(await cardOf(waiting)).toBeNull();
    expect(await storage.queryTokenEvents({ itemId: null })).toHaveLength(3);
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
    const calling = a.gatekeeper(t('10:01'), CARD_A); await journal(CARD_A, t('10:01'));
    const after = a.turn(t('10:02'));
    for (const tr of [parent, a]) tr.writeTo(projectDir);

    await ingest();

    expect(await cardOf(calling)).toBe(PARENT_CARD);
    expect(await cardOf(after)).toBe(CARD_A);
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
