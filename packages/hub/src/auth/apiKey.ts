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

export interface ApiKeyContext {
  orgId: string;
  tokenHash: string;
  /** Installation id bound to this token at issue time (magic-link flow). NULL for legacy tokens. */
  installationId?: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    hubApiKey?: ApiKeyContext;
  }
}

export function requireApiKey(db: DB) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
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
      const row = await db.get<{ org_id: string; revoked_at: string | null; installation_id: string | null }>(
        'SELECT org_id, revoked_at, installation_id FROM api_keys WHERE token_hash = ?',
        [tokenHash],
      );
      if (!row || row.revoked_at) {
        res.status(401).json({ error: 'Invalid or revoked token' });
        return;
      }
      req.hubApiKey = { orgId: row.org_id, tokenHash, installationId: row.installation_id ?? null };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export interface IssueApiKeyOptions {
  installationId?: string | null;
  osUser?: string | null;
  gitName?: string | null;
  gitEmail?: string | null;
}

/** Insert an API key row. Returns the raw token (caller must show it once). */
export async function issueApiKey(
  db: DB,
  orgId: string,
  label?: string,
  bind: IssueApiKeyOptions = {},
): Promise<string> {
  const token = generateApiKey();
  await db.run(
    'INSERT INTO api_keys (token_hash, org_id, label, installation_id, os_user, git_name, git_email) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      hashToken(token),
      orgId,
      label ?? null,
      bind.installationId ?? null,
      bind.osUser ?? null,
      bind.gitName ?? null,
      bind.gitEmail ?? null,
    ],
  );
  return token;
}
