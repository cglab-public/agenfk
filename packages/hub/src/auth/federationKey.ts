import { createHash, randomBytes } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { DB } from '../db.js';

/**
 * Federation-key principal (CGLAB-181). A child hub authenticates to its
 * parent with a `fed_` token whose sha256 lives in `federation_keys`. This is
 * deliberately a separate table and middleware from the installation api_key:
 * `requireApiKey` cannot resolve a fed_ token and `requireFederationKey`
 * cannot resolve an agk_ token, so neither credential kind reaches the
 * other's routes.
 */
export function hashFederationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateFederationKey(): string {
  return 'fed_' + randomBytes(32).toString('hex');
}

export interface FederationContext {
  orgId: string;
  childHubId: string;
  tokenHash: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    hubFederation?: FederationContext;
  }
}

/** Insert a federation key for a child hub. Returns the raw token (show once). */
export async function issueFederationKey(db: DB, orgId: string, childHubId: string, label?: string): Promise<string> {
  const token = generateFederationKey();
  await db.run(
    'INSERT INTO federation_keys (token_hash, org_id, child_hub_id, label) VALUES (?, ?, ?, ?)',
    [hashFederationToken(token), orgId, childHubId, label ?? null],
  );
  return token;
}

export function requireFederationKey(db: DB) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.headers.authorization;
      const token = auth && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
      if (!token) {
        res.status(401).json({ error: 'Missing bearer token' });
        return;
      }
      const tokenHash = hashFederationToken(token);
      // The join to child_hubs makes detachment authoritative on its own: a
      // detached hub is refused even when its key row was never revoked.
      const row = await db.get<{ org_id: string; child_hub_id: string; revoked_at: string | null; detached_at: string | null }>(
        `SELECT k.org_id, k.child_hub_id, k.revoked_at, c.detached_at
           FROM federation_keys k
           JOIN child_hubs c ON c.id = k.child_hub_id
          WHERE k.token_hash = ?`,
        [tokenHash],
      );
      if (!row || row.revoked_at || row.detached_at) {
        res.status(401).json({ error: 'Invalid, revoked or detached federation key' });
        return;
      }
      req.hubFederation = { orgId: row.org_id, childHubId: row.child_hub_id, tokenHash };
      next();
    } catch (err) {
      next(err);
    }
  };
}
