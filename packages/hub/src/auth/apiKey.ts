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

/**
 * AGENFK_HUB_REQUIRE_BOUND_KEYS=1|true: ingest refuses an installation-UNBOUND
 * key. An unbound key (POST /v1/admin/api-keys, and keys from before binding
 * existed) is org-wide by design: it may report events for any installation of
 * its org, so one leaked key can write into every machine's history. A bound
 * key is held to its own installation (events.ts, foreign_installation). Off by
 * default so a fleet still on legacy keys keeps reporting; a deployment that
 * has re-onboarded can turn it on to close the gap. Read per request so an
 * operator can flip it without a rebuild.
 */
export function requireBoundKeys(): boolean {
  const v = process.env.AGENFK_HUB_REQUIRE_BOUND_KEYS?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const BOUND_KEYS_OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Boot-time statement of where AGENFK_HUB_REQUIRE_BOUND_KEYS stands. A security
 * flag that silently stays off because of a typo ('enabled') is the worse
 * failure, so an unrecognised value is named. And switching it on refuses every
 * live unbound key, onboarding-labelled ones included (they can only bind by
 * reporting, which this refuses), so the count is logged: flipped blind on a
 * half-migrated fleet it would cut those machines off.
 */
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
  /** This route ingests events: apply AGENFK_HUB_REQUIRE_BOUND_KEYS. Everything else (ping, polls, flows) stays open to unbound keys. */
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
      // After the key is known to be valid, so a bad token still answers 401 and
      // nothing is revealed about binding to someone who has no key. The body
      // carries a JSON `error` string: the spoke reads that as the hub's own
      // refusal (not a proxy's), keeps its batch and backs off - nothing is lost.
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
