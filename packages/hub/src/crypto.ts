import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(secretKey: string): Buffer {
  // Accept hex (64 chars) or base64 (44 chars). Reject anything else so a
  // misconfigured key surfaces immediately rather than weakening encryption.
  if (/^[0-9a-fA-F]{64}$/.test(secretKey)) return Buffer.from(secretKey, 'hex');
  if (secretKey.length === 44 && /^[A-Za-z0-9+/=]+$/.test(secretKey)) {
    const buf = Buffer.from(secretKey, 'base64');
    if (buf.length === 32) return buf;
  }
  throw new Error('AGENFK_HUB_SECRET_KEY must be 32 bytes (64 hex chars or 44-char base64).');
}

/** Encrypts plaintext, returns a versioned string `v1:<iv_hex>:<tag_hex>:<ct_hex>`. */
export function encryptSecret(plaintext: string, secretKey: string): string {
  const key = deriveKey(secretKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decryptSecret(blob: string, secretKey: string): string {
  const key = deriveKey(secretKey);
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted blob format');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const ct = Buffer.from(parts[3], 'hex');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid IV/tag length');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
