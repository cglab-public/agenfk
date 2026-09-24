/**
 * CGLAB-383 — a passkey on the board: the authority an agent cannot reach.
 *
 * Anything the agent's OS user can read, the agent can use: the internal
 * token, the board header. A passkey with user verification is different -
 * producing an assertion takes a person's touch or face at an authenticator.
 * So once one is enrolled, every approval and override carries an assertion
 * over a single-use challenge the server bound to that exact act.
 *
 * Verified without attestation and without dependencies. The board sends what
 * the browser exposes: the credential's SPKI public key and algorithm
 * (getPublicKey(), getPublicKeyAlgorithm()), the authenticator data and
 * clientDataJSON; an assertion adds the signature over
 * authenticatorData || sha256(clientDataJSON). The relying party is
 * `localhost`: WebAuthn refuses IP origins, which is why the board hands an
 * act off from 127.0.0.1 (the desktop shell) to localhost.
 *
 * The store is a server-only file (0600, never behind a generic route). A
 * same-user process can still edit it by hand; that is tampering outside the
 * API, which the enforcement hooks guard against, not something the API lets
 * anyone do.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const RP_ID = 'localhost';
const ORIGIN = /^http:\/\/localhost(:\d{1,5})?$/;
const ALGS: Record<number, string> = { [-7]: 'ES256', [-257]: 'RS256' };
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export interface Registration { credentialId: string; publicKey: string; alg: number; clientDataJSON: string; authenticatorData: string }
export interface Assertion { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string }
export interface Credential { id: string; publicKey: string; alg: number; signCount: number; createdAt?: string }

const fromB64u = (s: unknown, what: string): Buffer => {
  if (typeof s !== 'string' || !s) throw new Error(`${what} is missing`);
  return Buffer.from(s, 'base64url');
};
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();

function parseClientData(b64: unknown, type: string, challenge: string): Buffer {
  const raw = fromB64u(b64, 'clientDataJSON');
  let cd: any;
  try { cd = JSON.parse(raw.toString('utf8')); } catch { throw new Error('clientDataJSON is not JSON'); }
  if (cd?.type !== type) throw new Error(`clientDataJSON type is ${JSON.stringify(cd?.type)}, not ${type}`);
  if (typeof cd.challenge !== 'string' || cd.challenge !== challenge) throw new Error('the challenge does not match the one issued for this act');
  if (typeof cd.origin !== 'string' || !ORIGIN.test(cd.origin)) throw new Error(`origin ${JSON.stringify(cd.origin)} is not the board on http://localhost`);
  return raw;
}

function parseAuthData(b64: unknown): { flags: number; signCount: number; raw: Buffer } {
  const raw = fromB64u(b64, 'authenticatorData');
  if (raw.length < 37) throw new Error('authenticatorData is too short');
  if (!raw.subarray(0, 32).equals(sha256(RP_ID))) throw new Error(`the credential belongs to another relying party, not ${RP_ID}`);
  const flags = raw[32];
  if (!(flags & 0x01)) throw new Error('the authenticator reports no user presence');
  if (!(flags & 0x04)) throw new Error('the authenticator reports no user verification (a PIN, fingerprint or face is required)');
  return { flags, signCount: raw.readUInt32BE(33), raw };
}

function publicKeyOf(spki: string): crypto.KeyObject {
  try { return crypto.createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' }); } catch {
    throw new Error('the public key is not an SPKI public key');
  }
}

/** Check a new passkey. Returns the credential to store; throws with the reason otherwise. */
export function verifyRegistration(reg: Registration, challenge: string): Omit<Credential, 'signCount'> {
  if (!reg || typeof reg !== 'object') throw new Error('registration is required');
  if (!ALGS[reg.alg]) throw new Error(`algorithm ${JSON.stringify(reg.alg)} is not supported (ES256 or RS256)`);
  if (typeof reg.credentialId !== 'string' || !/^[A-Za-z0-9_-]{8,1024}$/.test(reg.credentialId)) throw new Error('credentialId is not a credential id');
  parseClientData(reg.clientDataJSON, 'webauthn.create', challenge);
  parseAuthData(reg.authenticatorData);
  const key = publicKeyOf(reg.publicKey);
  const kind = key.asymmetricKeyType;
  if ((reg.alg === -7 && kind !== 'ec') || (reg.alg === -257 && kind !== 'rsa')) throw new Error(`the public key is ${kind}, which does not match algorithm ${ALGS[reg.alg]}`);
  return { id: reg.credentialId, publicKey: reg.publicKey, alg: reg.alg };
}

/** Check an assertion by an enrolled passkey. Returns its sign count; throws with the reason otherwise. */
export function verifyAssertion(a: Assertion, cred: Credential, challenge: string): { signCount: number } {
  if (!a || typeof a !== 'object') throw new Error('assertion is required');
  const clientData = parseClientData(a.clientDataJSON, 'webauthn.get', challenge);
  const auth = parseAuthData(a.authenticatorData);
  const signed = Buffer.concat([auth.raw, sha256(clientData)]);
  let ok = false;
  try { ok = crypto.verify('sha256', signed, publicKeyOf(cred.publicKey), fromB64u(a.signature, 'signature')); } catch { ok = false; }
  if (!ok) throw new Error('the signature does not verify against the enrolled passkey');
  // A counter that does not go up means a cloned authenticator; zero means it does not count.
  if ((auth.signCount !== 0 || cred.signCount !== 0) && auth.signCount <= cred.signCount) {
    throw new Error(`the sign count did not go up (${auth.signCount} after ${cred.signCount}): the authenticator may be cloned`);
  }
  return { signCount: auth.signCount };
}

// ── The store ────────────────────────────────────────────────────────────────

export function storePath(): string {
  return process.env.AGENFK_PASSKEY_STORE || path.join(os.homedir(), '.agenfk', 'passkeys.json');
}

export function loadCredentials(): Credential[] {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return Array.isArray(data?.credentials) ? data.credentials : [];
  } catch { return []; }
}

export function saveCredentials(creds: Credential[]): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ credentials: creds }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

// ── Act-bound challenges ─────────────────────────────────────────────────────

/** What a challenge is for: a signature over it authorises exactly this and nothing else. */
export interface Act {
  purpose: 'enroll' | 'add-passkey' | 'remove' | 'approval' | 'override';
  itemId?: string;
  step?: string;
  note?: string;
  checkId?: string;
  reason?: string;
  credentialId?: string;
}

const PURPOSES = new Set(['enroll', 'add-passkey', 'remove', 'approval', 'override']);
const actKey = (act: Act) => sha256(JSON.stringify([act.purpose, act.itemId ?? '', act.step ?? '', act.note ?? '', act.checkId ?? '', act.reason ?? '', act.credentialId ?? ''])).toString('hex');
const issued = new Map<string, { key: string; expires: number }>();

export function isPurpose(p: unknown): p is Act['purpose'] {
  return typeof p === 'string' && PURPOSES.has(p);
}

/** Issue a single-use challenge bound to one act. */
export function issueChallenge(act: Act, now = Date.now()): string {
  for (const [c, v] of issued) if (v.expires < now) issued.delete(c);
  const challenge = crypto.randomBytes(32).toString('base64url');
  issued.set(challenge, { key: actKey(act), expires: now + CHALLENGE_TTL_MS });
  return challenge;
}

/** The challenge a WebAuthn response carries, read before its signature is checked. */
export function challengeOf(clientDataJSON: unknown): string | null {
  try { const c = JSON.parse(fromB64u(clientDataJSON, 'clientDataJSON').toString('utf8'))?.challenge; return typeof c === 'string' ? c : null; } catch { return null; }
}

/** Consume a challenge for this act: true once, when it was issued for exactly this act and has not expired. */
export function consumeChallenge(challenge: string | null, act: Act, now = Date.now()): boolean {
  if (!challenge) return false;
  const v = issued.get(challenge);
  if (!v) return false;
  issued.delete(challenge);
  return v.expires >= now && v.key === actKey(act);
}

/**
 * Verify an assertion for an act against the enrolled passkeys, consuming its
 * challenge and advancing the passkey's sign count. Throws with the reason.
 */
export function authorise(assertion: Assertion | undefined, act: Act): Credential {
  if (!assertion || typeof assertion !== 'object') throw new Error('a passkey is enrolled on this board: sign this with it (the board asks for your fingerprint, face or PIN)');
  const creds = loadCredentials();
  const cred = creds.find(c => c.id === assertion.credentialId);
  const challenge = challengeOf(assertion.clientDataJSON);
  // Consumed before anything else can fail, so a refused assertion cannot be retried.
  if (!consumeChallenge(challenge, act)) throw new Error('the passkey signature is not for this act, was already used, or expired: sign it again');
  if (!cred) throw new Error('the assertion is from a passkey that is not enrolled on this board');
  const { signCount } = verifyAssertion(assertion, cred, challenge!);
  cred.signCount = signCount;
  saveCredentials(creds);
  return cred;
}
