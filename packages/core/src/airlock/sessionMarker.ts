/**
 * SX-1 (8dd7c7c0): the marker the launcher's proxy puts on every request an
 * Airlock sandbox sends to the AgEnFK server. `v1.<nonce>.<HMAC-SHA256(key, nonce)>`,
 * keyed with the Airlock report token: the sandbox cannot read that token, so the
 * agent cannot mint a marker, and the server checks one with the same token and
 * keeps no state. The nonce names the launch.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const AIRLOCK_SESSION_HEADER = 'x-agenfk-airlock-session';

const MARKER = /^v1\.([A-Za-z0-9_-]{1,64})\.([0-9a-f]{64})$/;

const macOf = (key: string, nonce: string): string =>
  createHmac('sha256', key).update(`airlock-session:${nonce}`).digest('hex');

export function mintAirlockSessionMarker(key: string, nonce: string = randomBytes(16).toString('hex')): string {
  if (!key) throw new Error('an Airlock session marker needs the report token');
  return `v1.${nonce}.${macOf(key, nonce)}`;
}

/** The launch's nonce when `value` is a marker made with `key`; null otherwise. */
export function verifyAirlockSessionMarker(key: string | null | undefined, value: unknown): string | null {
  if (!key || typeof value !== 'string') return null;
  const m = MARKER.exec(value);
  if (!m) return null;
  const expected = Buffer.from(macOf(key, m[1]), 'hex');
  const given = Buffer.from(m[2], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? m[1] : null;
}
