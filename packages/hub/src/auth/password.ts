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

export function findUserByEmail(db: DB, email: string): UserRow | null {
  return (db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email) as UserRow | undefined) ?? null;
}

export function createPasswordUser(
  db: DB,
  orgId: string,
  email: string,
  plainPassword: string,
  role: 'admin' | 'viewer',
): UserRow {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, orgId, email, hashPassword(plainPassword), 'password', role);
  return findUserByEmail(db, email)!;
}

export function countUsers(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c;
}

export function recordLogin(db: DB, userId: string): void {
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
}
