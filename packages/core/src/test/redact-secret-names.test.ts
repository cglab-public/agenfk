/**
 * Values under credential names are redacted in text - a file's content, a log -
 * for every name the dataset's structured-key screen treats as a credential
 * (BUG 84604611, epic review: `{"passphrase": ...}` and `cookie: ...` in a write's
 * content reached the hub while the same keys as tool arguments were dropped).
 */
import { describe, it, expect } from 'vitest';
import { redactLog, hasCredentialKey } from '../redact';

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

  it('a YAML block scalar or a quoted value over several lines goes whole (epic re-review)', () => {
    const cases = [
      'passphrase: |\n  opaque-block-91234\n  second-line-91234\nname: keep-me\n',
      'password: >-\n    opaque-block-91234\n    second-line-91234\nname: keep-me\n',
      'db:\n  password: |2\n      opaque-block-91234\n      second-line-91234\n  name: keep-me\n',
      'token: "opaque-block-91234\n  second-line-91234"\nname: keep-me\n',
      "secret: 'opaque-block-91234\n  second-line-91234'\nname: keep-me\n",
      // review pass 3: an empty value with the secret below it; an anchor or a tag before the header
      'password:\n  opaque-block-91234\n  second-line-91234\nname: keep-me\n',
      'passphrase: &credential |\n  opaque-block-91234\n  second-line-91234\nname: keep-me\n',
      'passphrase: !!str >-\n  opaque-block-91234\n  second-line-91234\nname: keep-me\n',
      // .env: a quoted value over lines, the continuation not indented
      'PASSWORD="opaque-block-91234\nsecond-line-91234"\nname=keep-me\n',
      'export API_TOKEN=\'opaque-block-91234\n  second-line-91234\'\nname=keep-me\n',
    ];
    for (const c of cases) {
      const out = redact(c);
      expect(out, c).not.toContain('opaque-block-91234');
      expect(out, c).not.toContain('second-line-91234');
      expect(out, c).toContain('keep-me');
    }
  });

  it('a quote that never closes (a cut-off log line) does not take the whole rest of the text', () => {
    const out = redact('token="cut-off-91234\n' + 'line\n'.repeat(300) + 'tail: keep-me\n');
    expect(out).not.toContain('cut-off-91234');
    expect(out).toContain('keep-me');
  });

  it('a quoted value that closes past the 200th line is still redacted to its quote (review)', () => {
    const out = redact('PASSWORD="start\n' + 'x\n'.repeat(210) + 'late-tail-91234"\nname=keep-me\n');
    expect(out).not.toContain('late-tail-91234');
    expect(out).toContain('keep-me');
  });

  it('hasCredentialKey: a credential-named key in any of the usual syntaxes, not a word that merely contains one', () => {
    for (const t of ['password: x', 'PASSWORD=x', 'export API_TOKEN=x', '{"credentials":{}}', 'secret => 1', "'auth': 1", '[secrets]\nvalue = 1', '[[tokens]]',
      '{"password"         : "x"}', 'password\t\t\t\t\t\t\t\t\t= x', '["secrets"]', "[['tokens']]", '[app."api-tokens"]', '[ db . credentials ]',
      // review pass 6: shell-quoted, quoted dotted, escaped spellings
      "printf '%s' 'passphrase: &c x' > c.yaml", 'db."password" = "x"', '{"pass\\u0077ord":"x"}', 'pass\\x77ord=x', 'pass%77ord=x']) expect(hasCredentialKey(t), t).toBe(true);
    for (const t of ['author: Ada', 'compass: north', 'sessions: 3', 'the password is in the vault', 'tokenizer settings']) expect(hasCredentialKey(t), t).toBe(false);
  });

  it('hasCredentialKey: a key after an escaped newline or tab in a one-line command (BUG 9e6fc052)', () => {
    // The beta.5 prod dataset row: printf wrote a YAML document whose second line is the secret.
    for (const t of ["printf 'user: demo\\npassword: x\\n' > ds-smoke.yml", 'echo -e "a: 1\\r\\ntoken=x"', "printf 'a\\tsecret: x'", 'echo $\'user: x\\npassword: y\'']) {
      expect(hasCredentialKey(t), t).toBe(true);
    }
    // An escape is not a separator by itself: a word that merely contains a key stays out.
    for (const t of ["printf 'compass: north\\n'", 'echo "\\nsessions: 3"']) expect(hasCredentialKey(t), t).toBe(false);
  });

  it('hasCredentialKey: a credential-named XML element or attribute (review of BUG 493ede38)', () => {
    for (const t of ['<config><password>local-db-password</password></config>', '<api-key>x</api-key>', '<Token type="a">x</Token>', '< secret >x</ secret >', '<db password="x"/>',
      // second review: XML whitespace includes line breaks, and a local name may carry a prefix
      '<password\n>x</password>', '<password\r\n  type="a">x</password>', '<db:password>x</db:password>', '<ns.v2:api-key>x</ns.v2:api-key>']) {
      expect(hasCredentialKey(t), t).toBe(true);
    }
    for (const t of ['<compass>north</compass>', '<sessions>3</sessions>', '<p>the password is in the vault</p>']) expect(hasCredentialKey(t), t).toBe(false);
  });

  it('ordinary words that only contain a credential word are kept', () => {
    const out = redact('author: Ada Lovelace\ncompass: north\nsessions: 3\n');
    expect(out).toContain('Ada Lovelace');
    expect(out).toContain('north');
    expect(out).toContain('sessions: 3');
  });
});
