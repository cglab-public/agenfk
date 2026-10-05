/**
 * @vitest-environment jsdom
 *
 * CGLAB-383 (S7-T2) — the board's side of a passkey: what it asks the browser
 * for, and what it hands the server (the fields the server verifies).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { canSignHere, createPasskey, signAct, handoffUrl } from '../webauthn';

const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

afterEach(() => { vi.unstubAllGlobals(); });

describe('canSignHere', () => {
  it('signs only on http://localhost with WebAuthn present', () => {
    expect(canSignHere({ hostname: 'localhost' } as Location, true)).toBe(true);
    expect(canSignHere({ hostname: '127.0.0.1' } as Location, true)).toBe(false);
    expect(canSignHere({ hostname: 'localhost' } as Location, false)).toBe(false);
  });
});

describe('handoffUrl', () => {
  it('opens the same card on localhost, same port', () => {
    expect(handoffUrl({ protocol: 'http:', port: '3000' } as Location, 'c1', 'p1')).toBe('http://localhost:3000/?item=c1&project=p1');
  });
});

describe('createPasskey', () => {
  it('asks for a user-verified credential on localhost and returns what the server checks', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'cred-1',
      response: {
        clientDataJSON: bytes('cd'),
        getPublicKey: () => bytes('pk'),
        getPublicKeyAlgorithm: () => -7,
        getAuthenticatorData: () => bytes('ad'),
      },
    });
    vi.stubGlobal('navigator', { credentials: { create } });
    const reg = await createPasskey(b64u('chal'));
    const opts = create.mock.calls[0][0].publicKey;
    expect(opts.rp.id).toBe('localhost');
    expect(opts.authenticatorSelection.userVerification).toBe('required');
    expect(opts.pubKeyCredParams.map((p: { alg: number }) => p.alg)).toEqual([-7, -257]);
    expect(new TextDecoder().decode(opts.challenge)).toBe('chal');
    expect(reg).toEqual({ credentialId: 'cred-1', publicKey: b64u('pk'), alg: -7, clientDataJSON: b64u('cd'), authenticatorData: b64u('ad') });
  });
});

describe('signAct', () => {
  it('asks the enrolled passkeys for a user-verified assertion and returns it for the server', async () => {
    const get = vi.fn().mockResolvedValue({
      id: 'cred-1',
      response: { clientDataJSON: bytes('cd'), authenticatorData: bytes('ad'), signature: bytes('sig') },
    });
    vi.stubGlobal('navigator', { credentials: { get } });
    const a = await signAct(b64u('chal'), ['cred-1']);
    const opts = get.mock.calls[0][0].publicKey;
    expect(opts.rpId).toBe('localhost');
    expect(opts.userVerification).toBe('required');
    expect(opts.allowCredentials).toHaveLength(1);
    expect(a).toEqual({ credentialId: 'cred-1', clientDataJSON: b64u('cd'), authenticatorData: b64u('ad'), signature: b64u('sig') });
  });
});
