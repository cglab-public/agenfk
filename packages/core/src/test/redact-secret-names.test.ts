/**
 * Values under credential names are redacted in text - a file's content, a log -
 * for every name the dataset's structured-key screen treats as a credential
 * (BUG 84604611, epic review: `{"passphrase": ...}` and `cookie: ...` in a write's
 * content reached the hub while the same keys as tool arguments were dropped).
 */
import { describe, it, expect } from 'vitest';
import { redactLog } from '../redact';

const redact = (s: string) => redactLog(s, { home: '/nonexistent-home', env: {} }).text;

const NAMES = ['passphrase', 'pwd', 'pass', 'DB_USER_PASS', 'db.user-pass', 'auth', 'oauth', 'cookie', 'session_id', 'sessionKey', 'session-secret', 'session.key', 'api.key', 'private.key', 'authorization', 'auth_token', 'signature', 'client_signature', 'Set-Cookie'];

describe('credential-named values in text', () => {
  for (const name of NAMES) {
    it(`JSON: "${name}": "<value>" is redacted`, () => {
      const out = redact(`{"${name}":"fresh-value-91234","ok":"keep-me"}`);
      expect(out).not.toContain('fresh-value-91234');
      expect(out).toContain('keep-me');
    });
    it(`YAML / .env: ${name}: <value> and ${name}=<value> are redacted`, () => {
      const out = redact(`${name}: fresh-yaml-91234\n${name}=fresh-env-91234\nname: keep-me\n`);
      expect(out).not.toContain('fresh-yaml-91234');
      expect(out).not.toContain('fresh-env-91234');
      expect(out).toContain('keep-me');
    });
  }

  it('every cookie in a cookie line goes, not only the first (review)', () => {
    for (const line of ['Cookie: theme=dark; SID=opaque-session-91234', 'set-cookie: theme=dark; SID=opaque-session-91234; Path=/', 'cookie=theme=dark; SID=opaque-session-91234']) {
      const out = redact(`${line}\nname: keep-me\n`);
      expect(out, line).not.toContain('opaque-session-91234');
      expect(out).toContain('keep-me');
    }
  });

  it('a quoted name, YAML style, with a single-, double-quoted or bare value (review)', () => {
    for (const line of [`'passphrase': 'opaque-91234'`, `"passphrase": 'opaque-91234'`, `'pwd': opaque-91234`, `"cookie": 'SID=opaque-91234'`, `'cookie': theme=dark; SID=opaque-91234`]) {
      const out = redact(`${line}\nname: keep-me\n`);
      expect(out, line).not.toContain('opaque-91234');
      expect(out).toContain('keep-me');
    }
  });

  it('ordinary words that only contain a credential word are kept', () => {
    const out = redact('author: Ada Lovelace\ncompass: north\nsessions: 3\n');
    expect(out).toContain('Ada Lovelace');
    expect(out).toContain('north');
    expect(out).toContain('sessions: 3');
  });
});
