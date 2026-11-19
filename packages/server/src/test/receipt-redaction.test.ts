/**
 * The verify log is redacted before it leaves the machine (RFC-002: "logs are
 * redacted before upload").
 *
 * The log is whatever the test suite printed, and it travels to the hub and to
 * every CI job holding a token for the repository. What must not travel with
 * it: secrets in the formats we know, values assigned to secret-named keys,
 * this machine's own secret environment values (whatever their format), and
 * the username in the home directory. Everything else stays byte for byte, so
 * the log still reads as the run it was.
 */
import { describe, it, expect } from 'vitest';
import { redactLog } from '../hub/redact';

const HOME = '/Users/ana';
const r = (text: string, env: Record<string, string | undefined> = {}) => redactLog(text, { home: HOME, env });

describe('redactLog', () => {
  it('leaves an ordinary log exactly as it was', () => {
    const log = 'PASS tests/a.test.js (12 ms)\nTests: 3 passed, 3 total\n';
    expect(r(log)).toEqual({ text: log, count: 0 });
  });

  it.each([
    ['agenfk api key', `key agk_${'a'.repeat(64)} used`],
    ['agenfk CI token', `token ci_${'b'.repeat(64)}`],
    ['GitHub token', 'GH ghp_' + 'A1b2C3d4E5'.repeat(4)],
    ['GitHub fine-grained token', 'github_pat_' + '11ABCDEFG0'.repeat(6)],
    ['AWS access key id', 'aws AKIAIOSFODNN7EXAMPLE here'],
    // Built at runtime so secret scanners don't take the fixture for a real token.
    ['Slack token', 'xox' + 'b-1234567890-1234567890123-abcdefABCDEF1234'],
    ['sk- API key', 'ANTHROPIC sk-ant-api03-' + 'x'.repeat(40)],
    ['JWT', 'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['Bearer value', 'Authorization: Bearer abcdef0123456789abcdef'],
  ])('redacts a %s', (_kind, line) => {
    const out = r(line);
    expect(out.count).toBeGreaterThan(0);
    expect(out.text).toContain('[REDACTED');
    // Nothing of the secret's tail survives.
    expect(out.text).not.toMatch(/a{20}|b{20}|A1b2C3d4E5A1b2|11ABCDEFG011|IOSFODNN7|abcdefABCDEF1234|x{20}|dozjgNryP4J3|abcdef0123456789abcdef/);
  });

  it('redacts a private key block whole', () => {
    const log = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKCAQ\n-----END RSA PRIVATE KEY-----\nafter';
    const out = r(log);
    expect(out.text).toBe('before\n[REDACTED:private-key]\nafter');
  });

  it('redacts the password in a URL and keeps the rest', () => {
    expect(r('connecting to postgres://app:s3cretpw@db.internal:5432/app').text)
      .toBe('connecting to postgres://app:[REDACTED:url-password]@db.internal:5432/app');
  });

  it('redacts values assigned to secret-named keys, in env, JSON and YAML spellings', () => {
    const out = r('DB_PASSWORD=hunter22\n"apiKey": "k-123456"\nclient_secret: abcdefgh\nNAME=ana');
    expect(out.text).toBe('DB_PASSWORD=[REDACTED:assigned]\n"apiKey": "[REDACTED:assigned]"\nclient_secret: [REDACTED:assigned]\nNAME=ana');
  });

  it('redacts this machine\'s own secret environment values wherever they appear, whatever their format', () => {
    const env = { MY_SERVICE_TOKEN: 'zq8!plain-looking-value', HOME_DIR_NAME: 'ignored', SHORT_SECRET: 'abc', PATH: '/usr/bin' };
    const out = r('debug: using zq8!plain-looking-value for the call, PATH=/usr/bin, abc', env);
    expect(out.text).toBe('debug: using [REDACTED:env:MY_SERVICE_TOKEN] for the call, PATH=/usr/bin, abc');
  });

  it('turns the home directory into ~, so the username does not travel', () => {
    expect(r('at /Users/ana/code/app/src/x.ts:3:1\nat /Users/anabel/x').text)
      .toBe('at ~/code/app/src/x.ts:3:1\nat /Users/anabel/x');
  });

  it('counts every redaction', () => {
    expect(r(`agk_${'a'.repeat(64)} and ci_${'b'.repeat(64)}`).count).toBe(2);
  });
});

// Codex review of the redaction.
describe('redactLog - what the first version missed', () => {
  it('redacts quoted assignment values, with escapes, whole', () => {
    expect(r('DB_PASSWORD="hunter22"').text).toBe('DB_PASSWORD="[REDACTED:assigned]"');
    expect(r("client_secret: 'abcdefgh'").text).toBe("client_secret: '[REDACTED:assigned]'");
    const json = r('{"password":"prefix\\"suffixSecret"}').text;
    expect(json).not.toContain('suffixSecret');
    expect(json).toBe('{"password":"[REDACTED:assigned]"}');
  });

  it('redacts a known token embedded in a longer word', () => {
    const key = 'agk_' + 'a'.repeat(64);
    expect(r(`id=${key}_suffix`).text).not.toContain('a'.repeat(20));
    expect(r(`prefix${key}`).text).not.toContain('a'.repeat(20));
    expect(r(`x_ghp_${'A1b2C3d4E5'.repeat(4)}_y`).text).not.toContain('A1b2C3d4E5A1b2');
  });

  it.each([
    ['unclosed private-key markers', '-----BEGIN PRIVATE KEY-----\n'.repeat(400_000)],
    ['a long scheme-like run', 'a.'.repeat(2_000_000)],
    ['a secret-named run with no delimiter', 'secret'.repeat(500_000)],
    ['a long JWT-like run', 'eyJ'.repeat(1_000_000)],
    ['long token-like runs', ('ghp_' + 'A'.repeat(5000) + ' ').repeat(500)],
  ])('stays linear on %s', (_kind, input) => {
    const started = Date.now();
    r(input);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('matches a Windows home in either separator and any case', () => {
    const win = (text: string) => redactLog(text, { home: 'C:\\Users\\ana', env: {} }).text;
    expect(win('at C:\\Users\\ana\\app\\x.ts')).toBe('at ~\\app\\x.ts');
    expect(win('at C:/Users/ana/project')).toBe('at ~/project');
    expect(win('at c:\\users\\ANA\\x')).toBe('at ~\\x');
    expect(win('at C:\\Users\\anabel\\x')).toBe('at C:\\Users\\anabel\\x');
  });

  it('does not rewrite the home path inside another path', () => {
    expect(r('/Users/bob/backups/Users/ana/log').text).toBe('/Users/bob/backups/Users/ana/log');
    expect(r('file:///Users/ana/x and "/Users/ana/y"').text).toBe('file://~/x and "~/y"');
  });
});

// Codex second pass on the redaction: bounds must never let a recognised secret through.
describe('redactLog - a recognised secret of any length', () => {
  it.each([
    ['a long double-quoted assignment', 'DB_PASSWORD="' + 'x'.repeat(5000) + '"'],
    ['a long JSON value', '{"password":"' + 'x'.repeat(5000) + '"}'],
    ['a long URL password', 'https://user:' + 'x'.repeat(5000) + '@host'],
    ['an unterminated quoted value', 'DB_PASSWORD="' + 'x'.repeat(50) + ' and the line goes on'],
  ])('is redacted: %s', (_kind, line) => {
    expect(r(line).text).not.toContain('x'.repeat(20));
  });

  it('stays linear on many unterminated secret assignments on one huge line', () => {
    const line = ('password="' + 'x'.repeat(100) + ' ').repeat(100_000);
    const started = Date.now();
    expect(r(line).text).not.toContain('x'.repeat(20));
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

// Codex third pass on the redaction.
describe('redactLog - every detector reads the original log', () => {
  it('redacts a JWT of any size', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ data: 'x'.repeat(5000) })).toString('base64url') + '.' + 'a'.repeat(43);
    const out = r('received ' + jwt).text;
    expect(out).toBe('received [REDACTED:jwt]');
  });

  it('an environment value that is also a key name cannot hide the credential beside it', () => {
    const out = redactLog('{"password":"production-credential-123"}', { home: null, env: { DB_PASSWORD: 'password' } }).text;
    expect(out).not.toContain('production-credential-123');
  });

  it('overlapping detections become one redaction', () => {
    const key = 'agk_' + 'c'.repeat(64);
    const out = redactLog(`API_TOKEN=${key}`, { home: null, env: { API_TOKEN: key } });
    expect(out.text).not.toContain('c'.repeat(20));
    expect(out.count).toBe(1);
  });
});

// Codex fourth pass on the redaction.
describe('redactLog - output stays well formed', () => {
  it('a JSON value starting with an apostrophe keeps its closing quote', () => {
    expect(r('{"password":"\'sensitive","ok":true}').text).toBe('{"password":"[REDACTED:assigned]","ok":true}');
  });

  it('handles hundreds of thousands of key blocks', () => {
    const log = '-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n'.repeat(200_000);
    const out = r(log);
    expect(out.count).toBe(200_000);
    expect(out.text).not.toContain('BEGIN PRIVATE KEY');
  });
});
