import { createHash, randomBytes } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { DB } from '../db.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateApiKey(): string {
  // 32 bytes = 256 bits of entropy. Prefixed for visual disambiguation.
  return 'agk_' + randomBytes(32).toString('hex');
}

export interface ApiKeyContext { orgId: string; tokenHash: string }

declare module 'express-serve-static-core' {
  interface Request {
    hubApiKey?: ApiKeyContext;
  }
}

export function requireApiKey(db: DB) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing bearer token' });
      return;
    }
    const token = auth.slice('Bearer '.length).trim();
    if (!token) {
      res.status(401).json({ error: 'Missing bearer token' });
      return;
    }
    const tokenHash = hashToken(token);
    const row = db.prepare('SELECT org_id, revoked_at FROM api_keys WHERE token_hash = ?').get(tokenHash) as
      | { org_id: string; revoked_at: string | null }
      | undefined;
    if (!row || row.revoked_at) {
      res.status(401).json({ error: 'Invalid or revoked token' });
      return;
    }
    req.hubApiKey = { orgId: row.org_id, tokenHash };
    next();
  };
}

/** Insert an API key row. Returns the raw token (caller must show it once). */
export function issueApiKey(db: DB, orgId: string, label?: string): string {
  const token = generateApiKey();
  db.prepare('INSERT INTO api_keys (token_hash, org_id, label) VALUES (?, ?, ?)').run(hashToken(token), orgId, label ?? null);
  return token;
}
