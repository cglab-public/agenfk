// Unit tests for the federation-key principal (CGLAB-181, task 1).
import { describe, it, expect } from 'vitest';
import { generateFederationKey, hashFederationToken, issueFederationKey, requireFederationKey } from '../auth/federationKey';
import { openDb } from '../db';

async function memDb() {
  return openDb(':memory:');
}

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

describe('federationKey', () => {
  it('generates fed_-prefixed 256-bit tokens that are all distinct', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = generateFederationKey();
      expect(t).toMatch(/^fed_[0-9a-f]{64}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(50);
  });

  it('hashes with sha256 hex and never stores the raw token', async () => {
    const db = await memDb();
    await db.run("INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES ('c1','org','n', datetime('now'), datetime('now'))");
    const token = await issueFederationKey(db, 'org', 'c1', 'label');
    const row = await db.get<any>('SELECT * FROM federation_keys WHERE child_hub_id = ?', ['c1']);
    expect(row.token_hash).toBe(hashFederationToken(token));
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.label).toBe('label');
    expect(row.org_id).toBe('org');
    expect(JSON.stringify(row)).not.toContain(token);
    await db.close();
  });

  it('requireFederationKey attaches {orgId, childHubId, tokenHash} for a live key', async () => {
    const db = await memDb();
    await db.run("INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES ('c1','org','n', datetime('now'), datetime('now'))");
    const token = await issueFederationKey(db, 'org', 'c1');
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let called = false;
    await new Promise<void>(resolve => {
      requireFederationKey(db)(req, res, () => { called = true; resolve(); });
      // in case the middleware responded without calling next
      setTimeout(resolve, 200);
    });
    expect(called).toBe(true);
    expect(req.hubFederation).toEqual({ orgId: 'org', childHubId: 'c1', tokenHash: hashFederationToken(token) });
    await db.close();
  });

  it('requireFederationKey answers 401 for missing bearer, unknown token, revoked key and detached hub', async () => {
    const db = await memDb();
    await db.run("INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES ('c1','org','n', datetime('now'), datetime('now'))");
    const token = await issueFederationKey(db, 'org', 'c1');

    const run = async (headers: Record<string, string>) => {
      const req: any = { headers };
      const res = mockRes();
      let nexted = false;
      await new Promise<void>(resolve => {
        requireFederationKey(db)(req, res, () => { nexted = true; resolve(); });
        setTimeout(resolve, 200);
      });
      return { nexted, status: res.statusCode };
    };

    expect(await run({})).toEqual({ nexted: false, status: 401 });
    expect(await run({ authorization: 'Bearer ' })).toEqual({ nexted: false, status: 401 });
    expect(await run({ authorization: 'Bearer fed_' + '0'.repeat(64) })).toEqual({ nexted: false, status: 401 });

    await db.run("UPDATE child_hubs SET detached_at = datetime('now') WHERE id = 'c1'");
    expect(await run({ authorization: `Bearer ${token}` })).toEqual({ nexted: false, status: 401 });
    await db.run("UPDATE child_hubs SET detached_at = NULL WHERE id = 'c1'");
    expect((await run({ authorization: `Bearer ${token}` })).nexted).toBe(true);

    await db.run("UPDATE federation_keys SET revoked_at = datetime('now') WHERE child_hub_id = 'c1'");
    expect(await run({ authorization: `Bearer ${token}` })).toEqual({ nexted: false, status: 401 });
    await db.close();
  });
});
