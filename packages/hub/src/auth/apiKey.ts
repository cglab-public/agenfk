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

/** AGENFK_HUB_REQUIRE_BOUND_KEYS=1|true: ingest refuses installation-unbound (org-wide) keys. Off by default for legacy fleets; read per request. */
export function requireBoundKeys(): boolean {
  const v = process.env.AGENFK_HUB_REQUIRE_BOUND_KEYS?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const BOUND_KEYS_OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);

/** Boot log of the flag's state: names an unrecognised value (a typo must not silently leave it off) and counts the unbound keys it would cut off. */
export async function logBoundKeyPosture(db: DB): Promise<void> {
  const raw = process.env.AGENFK_HUB_REQUIRE_BOUND_KEYS?.trim().toLowerCase() ?? '';
  if (!requireBoundKeys()) {
    if (!BOUND_KEYS_OFF_VALUES.has(raw)) {
      console.warn(`[HUB] AGENFK_HUB_REQUIRE_BOUND_KEYS=${JSON.stringify(raw)} is not recognised, so unbound API keys are still accepted on ingest. Use 1 or true to refuse them.`);
    }
    return;
  }
  const row = await db.get<{ c: number | string | bigint }>('SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL AND installation_id IS NULL');
  const unbound = Number(row?.c ?? 0);
  console.log(
    `[HUB] AGENFK_HUB_REQUIRE_BOUND_KEYS is on: POST /v1/events refuses API keys not bound to an installation. `
    + (unbound > 0
      ? `${unbound} live key(s) are unbound and will be refused until those machines re-onboard (agenfk hub login / join).`
      : 'Every live key is bound.'),
  );
}

export interface RequireApiKeyOptions {
  /** Ingest routes only: apply AGENFK_HUB_REQUIRE_BOUND_KEYS. */
  ingest?: boolean;
}

export function requireApiKey(db: DB, opts: RequireApiKeyOptions = {}) {
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
      // After key validation, so a bad token still gets 401. The JSON `error` tells the
      // spoke this is the hub's refusal: it keeps its batch and backs off.
      if (opts.ingest && requireBoundKeys() && !row.installation_id) {
        res.status(403).json({
          error: 'This hub only accepts events from installation-bound keys, and this key is not bound to an installation. '
            + 'Re-onboard this machine with `agenfk hub login` (or `agenfk hub join`) to get a bound key.',
        });
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
