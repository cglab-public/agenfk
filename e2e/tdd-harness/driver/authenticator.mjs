/**
 * A software WebAuthn authenticator: what a real one sends, made with a P-256
 * key in this container. It stands in for a person's fingerprint on the
 * harness's own throwaway server only, so the passkey steps' refusals AND
 * acceptances are exercised end to end. `userVerified: false` is an
 * authenticator that checked presence but no PIN, fingerprint or face.
 */
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';

const sha256 = b => createHash('sha256').update(b).digest();

export function softAuthenticator({ origin = 'http://localhost:5173', rpId = 'localhost', userVerified = true } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const id = randomBytes(16).toString('base64url');
  let count = 0;
  const authenticatorData = () => {
    const b = Buffer.alloc(37);
    sha256(rpId).copy(b, 0);
    b[32] = userVerified ? 0x05 : 0x01; // user present (+ user verified)
    b.writeUInt32BE(++count, 33);
    return b;
  };
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id,
    register(challenge) {
      return {
        credentialId: id,
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
        alg: -7,
        clientDataJSON: clientData('webauthn.create', challenge).toString('base64url'),
        authenticatorData: authenticatorData().toString('base64url'),
      };
    },
    assert(challenge) {
      const cd = clientData('webauthn.get', challenge);
      const ad = authenticatorData();
      return {
        credentialId: id,
        clientDataJSON: cd.toString('base64url'),
        authenticatorData: ad.toString('base64url'),
        // ES256 as WebAuthn sends it: DER, over authenticatorData || sha256(clientDataJSON).
        signature: sign('sha256', Buffer.concat([ad, sha256(cd)]), privateKey).toString('base64url'),
      };
    },
  };
}
