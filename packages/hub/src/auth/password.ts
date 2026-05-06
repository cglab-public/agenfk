import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { DB } from '../db.js';

export const BCRYPT_ROUNDS = 11;

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
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
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
  const row = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users');
  return row?.c ?? 0;
}

export async function recordLogin(db: DB, userId: string): Promise<void> {
  await db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [userId]);
}
