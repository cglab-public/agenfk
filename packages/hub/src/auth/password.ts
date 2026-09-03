import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { DB } from '../db.js';

// Production default is 11. Overridable via env (NOT via an argument) so a
// test run can drop the cost without any test being able to weaken a real
// login path by passing a low cost: hashSync/compareSync are synchronous and
// the hub suite performs ~238 of them (114 user creations + 124 logins), which
// at rounds=11 costs ~23s of blocked worker per full run. vitest.config.ts
// pins AGENFK_HUB_BCRYPT_ROUNDS=4 (~1ms/op); the hash format is unchanged, so
// auth paths stay genuinely exercised. Read lazily so a test that sets the env
// in a setup file (before this module's first call) is honoured.
const DEFAULT_BCRYPT_ROUNDS = 11;

export function getBcryptRounds(): number {
  const raw = process.env.AGENFK_HUB_BCRYPT_ROUNDS?.trim();
  if (!raw) return DEFAULT_BCRYPT_ROUNDS;
  const parsed = Number.parseInt(raw, 10);
  // bcryptjs rejects costs outside 4..31; clamp rather than throw so a typo in
  // an env file cannot take the hub down at first login.
  if (!Number.isFinite(parsed)) return DEFAULT_BCRYPT_ROUNDS;
  return Math.min(31, Math.max(4, parsed));
}

/** @deprecated Use getBcryptRounds(); kept for callers that imported the constant. */
export const BCRYPT_ROUNDS = DEFAULT_BCRYPT_ROUNDS;

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  password_hash: string | null;
  provider: 'password' | 'google' | 'entra';
  provider_subject: string | null;
  role: 'admin' | 'viewer';
  active: number;
  created_at: string;
  last_login_at: string | null;
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, getBcryptRounds());
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export async function findUserByEmail(db: DB, email: string): Promise<UserRow | null> {
  const row = await db.get<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?)', [email]);
  return row ?? null;
}

export async function createPasswordUser(
  db: DB,
  orgId: string,
  email: string,
  plainPassword: string,
  role: 'admin' | 'viewer',
): Promise<UserRow> {
  const id = randomUUID();
  await db.run(
    'INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, ?, ?, ?)',
    [id, orgId, email, hashPassword(plainPassword), 'password', role],
  );
  const created = await findUserByEmail(db, email);
  if (!created) throw new Error('Failed to read back newly inserted user');
  return created;
}

export async function countUsers(db: DB): Promise<number> {
  // Postgres returns COUNT(*) as bigint, which the pg driver serializes as a
  // string ("0", "1", …) — strict-equal comparisons with a JS number then
  // misfire (e.g. /auth/providers' `requiresSetup: countUsers === 0` would
  // wrongly return false on an empty table). Coerce here so every caller sees
  // a real number regardless of backend.
  const row = await db.get<{ c: number | string }>('SELECT COUNT(*) AS c FROM users');
  return Number(row?.c ?? 0);
}

export async function recordLogin(db: DB, userId: string): Promise<void> {
  await db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [userId]);
}
