import { randomUUID } from 'crypto';
import type { DB } from '../db.js';
import { countUsers } from './password.js';

/**
 * First-run admin bootstrap.
 *
 * On fresh installs the operator has no admin yet — but the open
 * `/setup/initial-admin` route is a TOFU race (anyone reachable on the
 * network can claim admin if they hit it first). To close that race the
 * hub generates a single-use UUIDv4 on first boot, persists it, and the
 * operator pastes it into the Setup UI before email/password are accepted.
 *
 * Restart-friendly: the row persists across reboots until the admin is
 * created, so an operator who restarts mid-setup keeps the same token
 * (re-logged on next boot) instead of hunting through old log lines.
 *
 * Returns the active token, or null when setup is already closed
 * (i.e. at least one user already exists in the DB).
 */
export async function ensureBootstrapToken(db: DB): Promise<string | null> {
  if ((await countUsers(db)) > 0) return null;

  const existing = await db.get<{ token: string }>(
    'SELECT token FROM bootstrap_tokens LIMIT 1',
  );
  if (existing?.token) return existing.token;

  const token = randomUUID();
  await db.run(
    'INSERT INTO bootstrap_tokens (token) VALUES (?)',
    [token],
  );
  return token;
}
