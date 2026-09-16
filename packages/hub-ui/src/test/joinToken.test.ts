/**
 * Reading the parent hub's URL back out of a join token.
 *
 * The parent signs its own URL into the invite so the child's admin pastes one
 * value instead of two. The child cannot verify the signature — that key is the
 * parent's — so this decode is deliberately unverified and has to be hostile to
 * everything it is handed. The parent checks the signature at enrolment; this
 * only decides what to put on screen and where to point the request.
 */
import { describe, it, expect } from 'vitest';
import { parentUrlFromJoinToken } from '../joinToken';

/** Exactly what a hub mints: UTF-8 bytes, base64url, then the signature. */
const sign = (payload: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;
};

describe('parentUrlFromJoinToken', () => {
  it('reads the URL the parent signed in', () => {
    const t = sign({ orgId: 'group', nonce: 'n', exp: Date.now() + 1000, kind: 'child-hub', parentUrl: 'https://parent.example.com' });
    expect(parentUrlFromJoinToken(t)).toBe('https://parent.example.com');
  });

  it('tolerates surrounding whitespace, because this comes off a clipboard', () => {
    const t = sign({ orgId: 'g', nonce: 'n', exp: 1, kind: 'child-hub', parentUrl: 'https://p.example.com' });
    expect(parentUrlFromJoinToken(`  ${t}\n`)).toBe('https://p.example.com');
  });

  it('returns null for a token minted before the URL was signed in', () => {
    const t = sign({ orgId: 'g', nonce: 'n', exp: 1, kind: 'child-hub' });
    expect(parentUrlFromJoinToken(t)).toBeNull();
  });

  it('returns null rather than throwing on anything that is not a token', () => {
    for (const junk of ['', '   ', 'nodot', '.sig', '!!!!.sig', `${btoa('not json')}.sig`]) {
      expect(parentUrlFromJoinToken(junk), junk).toBeNull();
    }
  });

  it('refuses a URL that is not http(s)', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x.example.com', 'parent.example.com']) {
      const t = sign({ orgId: 'g', nonce: 'n', exp: 1, kind: 'child-hub', parentUrl: bad });
      expect(parentUrlFromJoinToken(t), bad).toBeNull();
    }
  });

  it('refuses a parentUrl that is not a string', () => {
    const t = sign({ orgId: 'g', nonce: 'n', exp: 1, kind: 'child-hub', parentUrl: { href: 'https://x.example.com' } });
    expect(parentUrlFromJoinToken(t)).toBeNull();
  });

  it('refuses an absurdly long token instead of decoding it', () => {
    expect(parentUrlFromJoinToken(`${'x'.repeat(5000)}.sig`)).toBeNull();
  });
});

// Review findings. The decoded string is what the admin is shown before they
// enrol, and the server independently decodes the same token — so this has to
// agree with the server on every input, not just the friendly ones.
describe('parentUrlFromJoinToken agrees with what the hub will dial', () => {
  const tok = (parentUrl: unknown) =>
    sign({ orgId: 'g', nonce: 'n', exp: Date.now() + 60_000, kind: 'child-hub', parentUrl });

  it('strips userinfo, so the host on screen is the host contacted', () => {
    // Reads as parent.example.com at a glance; connects to evil.example.com.
    expect(parentUrlFromJoinToken(tok('https://parent.example.com@evil.example.com/x')))
      .toBe('https://evil.example.com/x');
  });

  it('normalises the way the server does, so the two never disagree', () => {
    expect(parentUrlFromJoinToken(tok('https://parent.example.com/'))).toBe('https://parent.example.com');
    expect(parentUrlFromJoinToken(tok('https://parent.example.com/hub/'))).toBe('https://parent.example.com/hub');
    expect(parentUrlFromJoinToken(tok('https://parent.example.com/?x=1#f'))).toBe('https://parent.example.com');
    expect(parentUrlFromJoinToken(tok('https://parent.example.com:8443/'))).toBe('https://parent.example.com:8443');
  });

  it('reads a non-ASCII host as UTF-8, like the server does', () => {
    // atob yields one char per BYTE. Read as latin1 the admin would be shown
    // https://hÃ¼b.example.com while the hub enrolled with https://hüb.example.com.
    expect(parentUrlFromJoinToken(tok('https://hüb.example.com')))
      .toBe(new URL('https://hüb.example.com').origin);
  });

  it('drops control characters rather than displaying a broken string', () => {
    expect(parentUrlFromJoinToken(tok('ht\ttps://evil.example.com'))).toBe('https://evil.example.com');
  });

  it('refuses a token that is not a child-hub invite', () => {
    const inst = sign({ orgId: 'g', nonce: 'n', exp: 1, kind: 'installation', parentUrl: 'https://p.example.com' });
    expect(parentUrlFromJoinToken(inst)).toBeNull();
  });

  it('refuses an array, which URL() would otherwise coerce', () => {
    expect(parentUrlFromJoinToken(tok(['https://evil.example.com']))).toBeNull();
  });

  it('leaves Object.prototype alone when the body carries __proto__', () => {
    const before = ({} as any).parentUrl;
    expect(parentUrlFromJoinToken(sign({ __proto__: { parentUrl: 'https://evil.example.com' } }))).toBeNull();
    expect(({} as any).parentUrl).toBe(before);
  });

  it('refuses a body that is not an object', () => {
    for (const body of ['"a string"', '["an","array"]', '42', 'null']) {
      expect(parentUrlFromJoinToken(`${btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`), body).toBeNull();
    }
  });
});
