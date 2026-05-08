import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openHubDb } from '../db';

describe('openHubDb factory (backend selection)', () => {
  const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-factory-${process.pid}.sqlite`);
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = TEST_DB + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  };

  beforeEach(() => {
    cleanup();
    delete process.env.AGENFK_HUB_DB;
    delete process.env.AGENFK_HUB_PG_URL;
  });
  afterEach(() => cleanup());

  it('defaults to sqlite when AGENFK_HUB_DB is unset', async () => {
    const db = await openHubDb({ dbPath: TEST_DB });
    try {
      const r = await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='orgs'"
      );
      expect(r[0]?.name).toBe('orgs');
    } finally {
      await db.close();
    }
  });

  it('selects sqlite explicitly via AGENFK_HUB_DB=sqlite', async () => {
    process.env.AGENFK_HUB_DB = 'sqlite';
    const db = await openHubDb({ dbPath: TEST_DB });
    try {
      const r = await db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='orgs'"
      );
      expect(r?.name).toBe('orgs');
    } finally {
      await db.close();
    }
  });

  it('throws when AGENFK_HUB_DB=postgres but AGENFK_HUB_PG_URL is missing', async () => {
    process.env.AGENFK_HUB_DB = 'postgres';
    await expect(openHubDb({ dbPath: TEST_DB })).rejects.toThrow(/AGENFK_HUB_PG_URL/);
  });

  it('throws on unknown backend', async () => {
    process.env.AGENFK_HUB_DB = 'duckdb';
    await expect(openHubDb({ dbPath: TEST_DB })).rejects.toThrow(/AGENFK_HUB_DB/);
  });

  it('explicit backend in opts overrides the env var', async () => {
    process.env.AGENFK_HUB_DB = 'postgres';
    // No PG URL set — but explicit sqlite override should still work
    const db = await openHubDb({ dbPath: TEST_DB, backend: 'sqlite' });
    try {
      expect(typeof db.run).toBe('function');
    } finally {
      await db.close();
    }
  });
});
