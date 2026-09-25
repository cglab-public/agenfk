/**
 * CodeQL on PR #194 (BUG 2f96c81a).
 *
 * - js/missing-rate-limiting: the routes that record a person's authority
 *   (passkey enrolment and removal, approvals, overrides) are rate limited.
 * - js/incomplete-multi-character-sanitization: the JUnit reader drops
 *   comments and CDATA with a left-to-right scan. It keeps the single-pass
 *   meaning, where whichever section opens first wins.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { EXPENSIVE_ROUTE_LIMIT } from '@agenfk/core';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./codeql-hardening-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage } from '../server';
import { parseJunitXml } from '../stepRecords';

let server: import('http').Server;
const agent = () => request(server);
beforeAll(async () => { await initStorage(); server = app.listen(0); });
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
});

describe('authority routes are rate limited', () => {
  const routes: Array<[string, () => request.Test]> = [
    ['POST /webauthn/credentials', () => agent().post('/webauthn/credentials').send({})],
    ['DELETE /webauthn/credentials/:credId', () => agent().delete('/webauthn/credentials/c1')],
    ['POST /items/:id/approvals', () => agent().post('/items/no-such/approvals').send({})],
    ['POST /items/:id/overrides', () => agent().post('/items/no-such/overrides').send({})],
  ];
  for (const [name, call] of routes) {
    it(`answers 429 on ${name} once the per-minute budget is spent`, async () => {
      for (let i = 0; i < EXPENSIVE_ROUTE_LIMIT; i++) {
        expect((await call()).status, `request ${i + 1} was limited early`).not.toBe(429);
      }
      const over = await call();
      expect(over.status).toBe(429);
      expect(over.body.error).toMatch(/Too many requests/);
    });
  }
});

describe('JUnit comments and CDATA', () => {
  const suite = (inner: string) => `<testsuite>${inner}</testsuite>`;
  const names = (xml: string) => parseJunitXml(xml, '/r').tests.map(t => t.name.replace(/^.*> /, ''));

  it('drops a testcase inside a comment or CDATA', () => {
    expect(names(suite('<testcase name="a"/><!-- <testcase name="ghost"/> --><![CDATA[<testcase name="ghost2"/>]]><testcase name="b"/>'))).toEqual(['a', 'b']);
  });

  it('keeps the single-pass meaning: stripping one comment does not open a new one', () => {
    // `<!<!---->--` is a stray `<!`, an empty comment, then `--`: the testcase after it is real markup.
    expect(names(suite('<!<!---->-- <testcase name="real"/> -->'))).toEqual(['real']);
  });

  it('an unterminated comment is left as text, as before', () => {
    expect(names(suite('<testcase name="a"/><!-- <testcase name="b"/>'))).toEqual(['a', 'b']);
  });

  it('an unterminated comment does not stop a later CDATA from being dropped', () => {
    expect(names(suite('<testcase name="a"/><!-- open <![CDATA[<testcase name="ghost"/>]]><testcase name="b"/>'))).toEqual(['a', 'b']);
  });

  it('reads a large CDATA-heavy report in linear time (verify parses it on the event loop)', () => {
    const body = 'x'.repeat(200);
    const xml = suite(Array.from({ length: 20000 }, (_, i) => `<testcase name="t${i}"><system-out><![CDATA[${body}]]></system-out></testcase>`).join(''));
    const t0 = Date.now();
    expect(names(xml)).toHaveLength(20000);
    // Linear is a few tens of ms; the quadratic scan took ~5 s at this size.
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

