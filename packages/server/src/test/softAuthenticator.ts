/**
 * A software WebAuthn authenticator for tests (CGLAB-383): what a browser and
 * a platform authenticator hand the server, built from a node key pair. It
 * produces exactly the fields the board sends - `getPublicKey()` (SPKI),
 * `getAuthenticatorData()`, `clientDataJSON` and the signature - so the
 * server's checks are exercised against real signatures.
 */
import * as crypto from 'crypto';

const b64u = (b: Buffer) => b.toString('base64url');
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();

export interface SoftOptions {
  origin?: string;
  rpId?: string;
  /** Authenticator flags: user present (0x01) and user verified (0x04). */
  up?: boolean;
  uv?: boolean;
  type?: string;
  signCount?: number;
}

export class SoftAuthenticator {
  readonly id = b64u(crypto.randomBytes(16));
  private readonly keys: crypto.KeyPairKeyObjectResult;
  counter = 0;

  constructor(readonly alg: -7 | -257 = -7) {
    this.keys = alg === -7
      ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  }

  private authData(o: SoftOptions, count: number): Buffer {
    const flags = ((o.up ?? true) ? 0x01 : 0) | ((o.uv ?? true) ? 0x04 : 0);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(count);
    return Buffer.concat([sha(o.rpId ?? 'localhost'), Buffer.from([flags]), c]);
  }

  private clientData(type: string, challenge: string, o: SoftOptions): Buffer {
    return Buffer.from(JSON.stringify({ type: o.type ?? type, challenge, origin: o.origin ?? 'http://localhost:5173', crossOrigin: false }));
  }

  /** What the board posts after navigator.credentials.create. */
  register(challenge: string, o: SoftOptions = {}) {
    return {
      credentialId: this.id,
      publicKey: b64u(this.keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer),
      alg: this.alg,
      clientDataJSON: b64u(this.clientData('webauthn.create', challenge, o)),
      authenticatorData: b64u(this.authData(o, 0)),
    };
  }

  /** What the board posts after navigator.credentials.get. */
  assert(challenge: string, o: SoftOptions = {}) {
    const count = o.signCount ?? ++this.counter;
    const authData = this.authData(o, count);
    const clientData = this.clientData('webauthn.get', challenge, o);
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientData)]), this.keys.privateKey);
    return { credentialId: this.id, clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) };
  }
}
