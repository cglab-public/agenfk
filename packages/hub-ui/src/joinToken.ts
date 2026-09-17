/**
 * Reading the parent hub's URL back out of a join token.
 *
 * A parent hub signs its own URL into the child-hub invites it mints, so the
 * admin on the receiving hub pastes one value instead of pairing a token with
 * a URL by hand. This is the browser's half of that: it decodes the token body
 * to show where the token would send this hub, before anything is sent.
 *
 * It does NOT verify the signature — that key belongs to the parent and never
 * leaves it. The parent checks the signature when the invite is redeemed. So
 * treat what comes out as attacker-controlled: it is bounded, parsed
 * defensively, and narrowed to http(s) so a `javascript:` payload cannot reach
 * the page. The server repeats every one of these checks; this one exists to
 * put an honest destination on screen and to keep an unusable token from being
 * submitted at all.
 *
 * The URL is returned NORMALISED, because this is the value an admin reads
 * before clicking Join and the server dials the normalised form:
 * `https://parent.example.com@evil.example.com` reads as one host and connects
 * to another, so showing it verbatim would make the confirmation a decoration
 * rather than a control.
 *
 * The server-side twin is `parentUrlFromInviteToken` in
 * `packages/hub/src/auth/inviteToken.ts`. They are separate because this one
 * runs in a browser and that one in node; if you change the rule in one, change
 * it in the other. Note the byte handling in particular: `atob` yields one
 * character per BYTE, so the UTF-8 decode below is what keeps a non-ASCII host
 * reading the same here as it does there.
 */

/** Nothing legitimate comes close; past this we do not even decode. */
const MAX_TOKEN_LEN = 4096;

export function parentUrlFromJoinToken(token: string): string | null {
  const t = typeof token === 'string' ? token.trim() : '';
  if (t.length === 0 || t.length > MAX_TOKEN_LEN) return null;
  const dot = t.lastIndexOf('.');
  if (dot <= 0) return null;

  let body: any;
  try {
    const b64 = t.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }

  // An installation invite pasted into the join box fails here rather than
  // after a round trip to whatever it names.
  if (body?.kind !== 'child-hub') return null;
  const raw = body.parentUrl;
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
  } catch {
    return null;
  }
}
