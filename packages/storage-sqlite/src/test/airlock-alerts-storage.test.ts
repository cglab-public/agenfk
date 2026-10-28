/**
 * GH-294 TEL-2: the decision log keeps each decision's alert category
 * ('cloud-storage' | 'metadata-endpoint' | 'ioc-host', or none), a log made
 * before the column gains it, and the log can be read for one card, one
 * client, one source or one alert category.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import type { AirlockDecisionRecord } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { DatabaseSync } = require('node:sqlite');

let dir: string;
let storage: SQLiteStorageProvider;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-airlock-alerts-'));
  storage = new SQLiteStorageProvider();
  await storage.init({ path: path.join(dir, 'db.sqlite') });
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const decision = (over: Partial<AirlockDecisionRecord> = {}): AirlockDecisionRecord => ({
  ts: new Date(Date.UTC(2026, 9, 27, 0, 0, n++)).toISOString(),
  client: 'pi',
  model: 'p/m',
  tool: 'bash',
  capabilityKind: 'command',
  target: 'curl https://evil.example/',
  decision: 'deny',
  rule: 'denied-host',
  mode: 'enforce',
  itemId: null,
  sessionId: null,
  source: 'tool',
  ...over,
});

describe('the alert column', () => {
  it('a decision keeps its alert category; one without reads as no alert', async () => {
    await storage.recordAirlockDecision(decision({ target: 'curl http://169.254.169.254/', alert: 'metadata-endpoint' }));
    await storage.recordAirlockDecision(decision());
    const [plain, alerted] = await storage.listAirlockDecisions({ limit: 10 });
    expect(alerted.alert).toBe('metadata-endpoint');
    expect(plain.alert).toBeUndefined();
  });

  it('a log made before alerts gains the column; its rows read as no alert', async () => {
    await storage.shutdown();
    const old = path.join(dir, 'pre-alert.sqlite');
    const db = new DatabaseSync(old);
    db.exec(`
      CREATE TABLE airlock_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, client TEXT NOT NULL, model TEXT, tool TEXT NOT NULL,
        capability_kind TEXT, target TEXT, decision TEXT NOT NULL, rule TEXT, mode TEXT NOT NULL, item_id TEXT, session_id TEXT,
        source TEXT NOT NULL DEFAULT 'tool'
      );
      INSERT INTO airlock_decisions (ts, client, tool, decision, mode) VALUES ('2026-01-01T00:00:00.000Z', 'pi', 'bash', 'deny', 'enforce');
    `);
    db.close();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: old });
    const columns = ((storage as any).database.prepare('PRAGMA table_info(airlock_decisions)').all() as { name: string }[]).map(c => c.name);
    expect(columns).toContain('alert');
    const [before] = await storage.listAirlockDecisions({ limit: 1 });
    expect(before).toMatchObject({ client: 'pi', tool: 'bash', source: 'tool' });
    expect(before.alert).toBeUndefined();
    await storage.recordAirlockDecision(decision({ alert: 'ioc-host' }));
    expect((await storage.listAirlockDecisions({ limit: 1 }))[0].alert).toBe('ioc-host');
  });
});

describe('listAirlockDecisions filters', () => {
  beforeEach(async () => {
    await storage.recordAirlockDecision(decision({ itemId: 'card-a', client: 'pi', source: 'tool', target: 'a1' }));
    await storage.recordAirlockDecision(decision({ itemId: 'card-a', client: 'opencode', source: 'proxy', tool: 'proxy', capabilityKind: 'host', target: 'b.s3.amazonaws.com:443', alert: 'cloud-storage' }));
    await storage.recordAirlockDecision(decision({ itemId: 'card-b', client: 'pi', source: 'proxy', tool: 'proxy', capabilityKind: 'host', target: '169.254.169.254:80', alert: 'metadata-endpoint' }));
    await storage.recordAirlockDecision(decision({ itemId: null, client: 'opencode', source: 'tool', target: 'd1' }));
  });

  const targets = (rows: AirlockDecisionRecord[]) => rows.map(r => r.target);

  it('by card: only that card, newest first', async () => {
    expect(targets(await storage.listAirlockDecisions({ itemId: 'card-a' }))).toEqual(['b.s3.amazonaws.com:443', 'a1']);
    expect(await storage.listAirlockDecisions({ itemId: 'card-none' })).toEqual([]);
  });

  it('by client', async () => {
    expect(targets(await storage.listAirlockDecisions({ client: 'opencode' }))).toEqual(['d1', 'b.s3.amazonaws.com:443']);
    expect(targets(await storage.listAirlockDecisions({ client: 'pi' }))).toEqual(['169.254.169.254:80', 'a1']);
  });

  it('by source', async () => {
    expect(targets(await storage.listAirlockDecisions({ source: 'proxy' }))).toEqual(['169.254.169.254:80', 'b.s3.amazonaws.com:443']);
    expect(targets(await storage.listAirlockDecisions({ source: 'tool' }))).toEqual(['d1', 'a1']);
  });

  it('by alert category, and "any" for every alert', async () => {
    expect(targets(await storage.listAirlockDecisions({ alert: 'metadata-endpoint' }))).toEqual(['169.254.169.254:80']);
    expect(targets(await storage.listAirlockDecisions({ alert: 'any' }))).toEqual(['169.254.169.254:80', 'b.s3.amazonaws.com:443']);
    expect(await storage.listAirlockDecisions({ alert: 'ioc-host' })).toEqual([]);
  });

  it('filters combine, and the limit counts matching rows only', async () => {
    expect(targets(await storage.listAirlockDecisions({ itemId: 'card-a', source: 'proxy', client: 'opencode' }))).toEqual(['b.s3.amazonaws.com:443']);
    expect(await storage.listAirlockDecisions({ itemId: 'card-a', client: 'pi', source: 'proxy' })).toEqual([]);
    expect(targets(await storage.listAirlockDecisions({ source: 'tool', limit: 1 }))).toEqual(['d1']);
  });

  it('a value is data, never SQL', async () => {
    expect(await storage.listAirlockDecisions({ itemId: "card-a' OR '1'='1" })).toEqual([]);
  });
});
