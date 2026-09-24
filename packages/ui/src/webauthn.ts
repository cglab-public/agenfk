/**
 * CGLAB-383 — the board's side of a passkey.
 *
 * The server verifies without attestation, so the board sends what the
 * browser exposes: the credential's SPKI public key and algorithm, the
 * authenticator data and clientDataJSON (plus, for an assertion, the
 * signature). User verification is always required: a fingerprint, face or
 * PIN, which is exactly what an agent cannot supply.
 *
 * WebAuthn refuses IP origins, and the relying party is `localhost`. The
 * desktop app loads the board from 127.0.0.1, so there the board opens the
 * same card on localhost in the system browser to sign.
 */
const RP_ID = 'localhost';

const toB64u = (buf: ArrayBuffer): string => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (s: string): ArrayBuffer => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

/** Can this page sign? Only on http://localhost, in a browser with WebAuthn. */
export function canSignHere(loc: Location = window.location, hasWebAuthn = typeof window !== 'undefined' && 'PublicKeyCredential' in window): boolean {
  return loc.hostname === RP_ID && hasWebAuthn;
}

/** The same card on localhost, where the browser can sign. */
export function handoffUrl(loc: Location, itemId: string, projectId?: string): string {
  const params = new URLSearchParams({ item: itemId, ...(projectId ? { project: projectId } : {}) });
  return `${loc.protocol}//${RP_ID}${loc.port ? `:${loc.port}` : ''}/?${params.toString()}`;
}

/** Create a passkey for this board; returns the registration the server verifies. */
export async function createPasskey(challenge: string) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: fromB64u(challenge),
      rp: { id: RP_ID, name: 'AgEnFK board' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'agenfk-board', displayName: 'AgEnFK board approvals' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created.');
  const r = cred.response as AuthenticatorAttestationResponse;
  const pk = r.getPublicKey();
  if (!pk) throw new Error('This browser does not expose the passkey\'s public key; use a current Chrome, Edge, Safari or Firefox.');
  return {
    credentialId: cred.id,
    publicKey: toB64u(pk),
    alg: r.getPublicKeyAlgorithm(),
    clientDataJSON: toB64u(r.clientDataJSON),
    authenticatorData: toB64u(r.getAuthenticatorData()),
  };
}

/** Sign one act's challenge with an enrolled passkey; returns the assertion the server verifies. */
export async function signAct(challenge: string, allowCredentials: string[]) {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: fromB64u(challenge),
      rpId: RP_ID,
      allowCredentials: allowCredentials.map(id => ({ type: 'public-key' as const, id: fromB64u(id) })),
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('The passkey did not sign.');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    credentialId: cred.id,
    clientDataJSON: toB64u(r.clientDataJSON),
    authenticatorData: toB64u(r.authenticatorData),
    signature: toB64u(r.signature),
  };
}
