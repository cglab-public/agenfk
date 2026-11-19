/**
 * GH-389: which card a harness session was working on, over time. The
 * gatekeeper and verify append a row whenever a session is seen on a card;
 * closing a card appends an "ended" row (no card) so the session's later turns
 * are not charged to it. Token attribution reads the row in effect at a turn's
 * timestamp.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '../index';

const TEST_DB = path.join(os.tmpdir(), `agenfk-session-cards-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + s); } catch { /* absent */ } } };

describe('session cards journal', () => {
  let storage: SQLiteStorageProvider;
  beforeEach(async () => {
    cleanup();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
  });
  afterEach(async () => { await storage.shutdown(); cleanup(); });

  it('answers the card a session was on at a given time', async () => {
    await storage.recordSessionCard({ client: 'claude-code', sessionId: 's1', itemId: 'A', projectId: 'p', at: '2026-11-19T10:00:00.000Z' });
    await storage.recordSessionCard({ client: 'claude-code', sessionId: 's1', itemId: 'B', projectId: 'p', at: '2026-11-19T11:00:00.000Z' });

    expect(await storage.sessionCardAt('claude-code', 's1', '2026-11-19T10:30:00.000Z')).toEqual({ itemId: 'A', projectId: 'p' });
    expect(await storage.sessionCardAt('claude-code', 's1', '2026-11-19T11:00:00.000Z')).toEqual({ itemId: 'B', projectId: 'p' });
    expect(await storage.sessionCardAt('claude-code', 's1', '2026-11-19T12:00:00.000Z')).toEqual({ itemId: 'B', projectId: 'p' });
  });

  it('knows nothing about a session before its first row', async () => {
    await storage.recordSessionCard({ client: 'pi', sessionId: 's1', itemId: 'A', projectId: 'p', at: '2026-11-19T10:00:00.000Z' });
    expect(await storage.sessionCardAt('pi', 's1', '2026-11-19T09:59:59.000Z')).toBeNull();
  });

  it('an ended row means the session is on no card from then on', async () => {
    await storage.recordSessionCard({ client: 'pi', sessionId: 's1', itemId: 'A', projectId: 'p', at: '2026-11-19T10:00:00.000Z' });
    await storage.recordSessionCard({ client: 'pi', sessionId: 's1', itemId: null, projectId: 'p', at: '2026-11-19T10:30:00.000Z' });
    expect(await storage.sessionCardAt('pi', 's1', '2026-11-19T10:45:00.000Z')).toEqual({ itemId: null, projectId: 'p' });
  });

  it('keeps sessions and clients apart', async () => {
    await storage.recordSessionCard({ client: 'pi', sessionId: 's1', itemId: 'A', projectId: 'p', at: '2026-11-19T10:00:00.000Z' });
    expect(await storage.sessionCardAt('pi', 's2', '2026-11-19T11:00:00.000Z')).toBeNull();
    expect(await storage.sessionCardAt('claude-code', 's1', '2026-11-19T11:00:00.000Z')).toBeNull();
  });

  it('compares instants, not strings: an offset timestamp on the turn still finds its row', async () => {
    await storage.recordSessionCard({ client: 'codex', sessionId: 's1', itemId: 'A', projectId: 'p', at: '2026-11-19T10:00:00.000Z' });
    // 07:30-03:00 is 10:30Z: after the row, although it sorts before it as text.
    expect(await storage.sessionCardAt('codex', 's1', '2026-11-19T07:30:00.000-03:00')).toEqual({ itemId: 'A', projectId: 'p' });
  });

  it('closing a card ends it for every session whose latest row is that card, and only those', async () => {
    await storage.recordSessionCard({ client: 'pi', sessionId: 'on-a', itemId: 'A', projectId: 'p', at: '2026-11-19T10:00:00.000Z' });
    await storage.recordSessionCard({ client: 'claude-code', sessionId: 'also-on-a', itemId: 'A', projectId: 'p', at: '2026-11-19T10:05:00.000Z' });
    await storage.recordSessionCard({ client: 'pi', sessionId: 'moved-on', itemId: 'A', projectId: 'p', at: '2026-11-19T10:00:00.000Z' });
    await storage.recordSessionCard({ client: 'pi', sessionId: 'moved-on', itemId: 'B', projectId: 'p', at: '2026-11-19T10:10:00.000Z' });

    await storage.endSessionCards('A', '2026-11-19T11:00:00.000Z');

    const after = '2026-11-19T11:30:00.000Z';
    expect(await storage.sessionCardAt('pi', 'on-a', after)).toEqual({ itemId: null, projectId: 'p' });
    expect(await storage.sessionCardAt('claude-code', 'also-on-a', after)).toEqual({ itemId: null, projectId: 'p' });
    expect(await storage.sessionCardAt('pi', 'moved-on', after)).toEqual({ itemId: 'B', projectId: 'p' });
    // Before the close, the turns still belong to A.
    expect(await storage.sessionCardAt('pi', 'on-a', '2026-11-19T10:30:00.000Z')).toEqual({ itemId: 'A', projectId: 'p' });
  });
});
