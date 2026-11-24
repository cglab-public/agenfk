import { randomBytes } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { DB } from '../db.js';
import { hashToken } from './apiKey.js';

/** The prefix every CI token carries, so a reader can tell one from an api key at a glance. */
export const CI_TOKEN_PREFIX = 'ci_';

export function generateCiToken(): string {
  // 32 bytes = 256 bits of entropy, like an api key.
  return CI_TOKEN_PREFIX + randomBytes(32).toString('hex');
}

export interface CiTokenContext {
  orgId: string;
  tokenHash: string;
  /** The one repository this token may read, canonical; null for the whole org. */
  remoteUrl: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    hubCiToken?: CiTokenContext;
  }
}

/**
 * A CI job's read credential (RFC-002). Looked up in `ci_tokens` only, never in
 * `api_keys`: an installation's key is not a CI token, and the routes that take
 * an installation's key look in `api_keys` only, so a CI token is refused by
 * every one of them without any of them having to know CI tokens exist.
 */
export function requireCiToken(db: DB) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.headers.authorization;
      const token = auth && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
      if (!token) {
        res.status(401).json({ error: 'Missing bearer token' });
        return;
      }
      // Not a CI token: refused without a database read.
      if (!token.startsWith(CI_TOKEN_PREFIX)) {
        res.status(401).json({ error: 'A CI token (ci_...) is required' });
        return;
      }
      const tokenHash = hashToken(token);
      const row = await db.get<{ org_id: string; remote_url: string | null; revoked_at: string | null }>(
        'SELECT org_id, remote_url, revoked_at FROM ci_tokens WHERE token_hash = ?',
        [tokenHash],
      );
      if (!row || row.revoked_at) {
        res.status(401).json({ error: 'Invalid or revoked token' });
        return;
      }
      req.hubCiToken = { orgId: row.org_id, tokenHash, remoteUrl: row.remote_url ?? null };
      next();
    } catch (err) {
      next(err);
    }
  };
}
