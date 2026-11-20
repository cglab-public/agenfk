/**
 * GH-398: which card each TRANSCRIPT worked on, over time.
 *
 * A Claude Code subagent runs with its parent's session id, so the session
 * journal (session_cards) cannot tell a subagent's gatekeeper from its
 * parent's. Each transcript's own claims - the gatekeeper and verify calls it
 * made itself - are kept per (client, session, agent), the parent being agent
 * ''. A card's close ends every claim made on it before the close.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '../index';

const TEST_DB = path.join(os.tmpdir(), `agenfk-transcript-claims-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + s); } catch { /* absent */ } } };

const claim = (agentId: string, itemId: string, at: string, sessionId = 's1') =>
  ({ client: 'claude-code', sessionId, agentId, itemId, projectId: 'p', at });

describe('transcript claims', () => {
  let storage: SQLiteStorageProvider;
  beforeEach(async () => {
    cleanup();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
  });
  afterEach(async () => { await storage.shutdown(); cleanup(); });

  it('answers each transcript\'s own latest claim, apart from the other transcripts of the session', async () => {
    await storage.recordTranscriptClaim(claim('', 'PARENT', '2026-11-20T10:00:00.000Z'));
    await storage.recordTranscriptClaim(claim('agent-a', 'A', '2026-11-20T10:05:00.000Z'));
    await storage.recordTranscriptClaim(claim('agent-b', 'B', '2026-11-20T10:06:00.000Z'));

    const t = '2026-11-20T10:30:00.000Z';
    expect(await storage.transcriptCardAt('claude-code', 's1', '', t)).toEqual({ itemId: 'PARENT', projectId: 'p' });
    expect(await storage.transcriptCardAt('claude-code', 's1', 'agent-a', t)).toEqual({ itemId: 'A', projectId: 'p' });
    expect(await storage.transcriptCardAt('claude-code', 's1', 'agent-b', t)).toEqual({ itemId: 'B', projectId: 'p' });
  });

  it('knows nothing about a transcript before its first claim, nor about another session or client', async () => {
    await storage.recordTranscriptClaim(claim('agent-a', 'A', '2026-11-20T10:05:00.000Z'));
    expect(await storage.transcriptCardAt('claude-code', 's1', 'agent-a', '2026-11-20T10:04:59.999Z')).toBeNull();
    expect(await storage.transcriptCardAt('claude-code', 's2', 'agent-a', '2026-11-20T11:00:00.000Z')).toBeNull();
    expect(await storage.transcriptCardAt('codex', 's1', 'agent-a', '2026-11-20T11:00:00.000Z')).toBeNull();
    expect(await storage.transcriptCardAt('claude-code', 's1', '', '2026-11-20T11:00:00.000Z')).toBeNull();
  });

  it('a later claim replaces an earlier one, compared as instants', async () => {
    await storage.recordTranscriptClaim(claim('agent-a', 'A', '2026-11-20T10:00:00.000Z'));
    await storage.recordTranscriptClaim(claim('agent-a', 'B', '2026-11-20T08:00:00.000-03:00'));
    expect(await storage.transcriptCardAt('claude-code', 's1', 'agent-a', '2026-11-20T10:59:00.000Z')).toEqual({ itemId: 'A', projectId: 'p' });
    expect(await storage.transcriptCardAt('claude-code', 's1', 'agent-a', '2026-11-20T11:00:00.000Z')).toEqual({ itemId: 'B', projectId: 'p' });
  });

  it('recording the same claim again (a file read twice) changes nothing', async () => {
    await storage.recordTranscriptClaim(claim('agent-a', 'A', '2026-11-20T10:00:00.000Z'));
    await storage.recordTranscriptClaim(claim('agent-a', 'B', '2026-11-20T10:10:00.000Z'));
    await storage.recordTranscriptClaim(claim('agent-a', 'A', '2026-11-20T10:00:00.000Z'));
    expect(await storage.transcriptCardAt('claude-code', 's1', 'agent-a', '2026-11-20T10:20:00.000Z')).toEqual({ itemId: 'B', projectId: 'p' });
  });

  it('a card closed after a claim ends it: the transcript is on no card from the close on', async () => {
    await storage.recordTranscriptClaim(claim('agent-a', 'A', '2026-11-20T10:00:00.000Z'));
    await storage.recordCardClose('A', '2026-11-20T10:30:00.000Z');
    expect(await storage.transcriptCardAt('claude-code', 's1', 'agent-a', '2026-11-20T10:29:59.000Z')).toEqual({ itemId: 'A', projectId: 'p' });
    expect(await storage.transcriptCardAt('claude-code', 's1', 'agent-a', '2026-11-20T10:30:00.000Z')).toEqual({ itemId: null, projectId: 'p' });
  });

  it('a claim made after the card\'s close (it was reopened) stands, and a close of another card ends nothing', async () => {
    await storage.recordCardClose('A', '2026-11-20T09:00:00.000Z');
    await storage.recordTranscriptClaim(claim('agent-a', 'A', '2026-11-20T10:00:00.000Z'));
    await storage.recordCardClose('B', '2026-11-20T10:30:00.000Z');
    expect(await storage.transcriptCardAt('claude-code', 's1', 'agent-a', '2026-11-20T11:00:00.000Z')).toEqual({ itemId: 'A', projectId: 'p' });
  });

  it('endSessionCards records the card\'s close for the transcript claims too', async () => {
    await storage.recordTranscriptClaim(claim('agent-a', 'A', '2026-11-20T10:00:00.000Z'));
    await storage.endSessionCards('A', '2026-11-20T10:30:00.000Z');
    expect(await storage.transcriptCardAt('claude-code', 's1', 'agent-a', '2026-11-20T11:00:00.000Z')).toEqual({ itemId: null, projectId: 'p' });
  });

  it('a session that claimed a card only in its transcript is one of the card\'s sessions (its logs are flushed)', async () => {
    await storage.recordTranscriptClaim(claim('agent-a', 'A', '2026-11-20T10:00:00.000Z', 'sub-only'));
    expect(await storage.sessionsForItem('A')).toEqual([{ client: 'claude-code', sessionId: 'sub-only' }]);
  });

  it('moves a stored turn to another card or to none, and reads turns by session', async () => {
    const base = {
      ts: '2026-11-20T10:00:00.000Z', client: 'claude-code' as const, model: 'm', input: 1, cachedInput: 0,
      output: 1, reasoning: 0, total: 2, projectId: 'p', sourcePath: '/x.jsonl',
    };
    await storage.insertTokenEvent({ ...base, id: 't1', sessionId: 's1', itemId: 'WRONG', sourceOffset: 0 });
    await storage.insertTokenEvent({ ...base, id: 't2', sessionId: 's1', itemId: 'WRONG', sourceOffset: 1 });
    await storage.insertTokenEvent({ ...base, id: 't3', sessionId: 's2', itemId: 'WRONG', sourceOffset: 2 });

    await storage.setTokenEventItem('t1', 'RIGHT', 'p2');
    await storage.setTokenEventItem('t2', null);

    const s1 = await storage.queryTokenEvents({ sessionId: 's1' });
    expect(s1.map((e) => [e.id, e.itemId ?? null, e.projectId])).toEqual([['t1', 'RIGHT', 'p2'], ['t2', null, 'p']]);
    expect((await storage.queryTokenEvents({ itemId: 'WRONG' })).map((e) => e.id)).toEqual(['t3']);
  });

  it('keeps one-off markers in the ingestion meta', async () => {
    expect(await storage.getIngestionMeta('migration:x')).toBeNull();
    await storage.setIngestionMeta('migration:x', '{"moved":3}');
    expect(await storage.getIngestionMeta('migration:x')).toBe('{"moved":3}');
    await storage.setIngestionMeta('migration:x', '{"moved":4}');
    expect(await storage.getIngestionMeta('migration:x')).toBe('{"moved":4}');
  });
});
