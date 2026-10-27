/**
 * The Airlock report token (GH-294, TEL-1): ~/.agenfk/airlock/report-token,
 * in a 0700 directory the sandbox cannot read. The server checks it at startup
 * through an opened descriptor (regular file, one link, 0600 or tighter, 64 hex
 * characters) and writes a fresh one by temp + rename when it fails; stray temp
 * files go. The route reads the file per request, so it always takes what
 * launchers read, and VERIFY_TOKEN - readable by the sandboxed agent - is
 * refused in either header.
 *
 * The second half runs the real app, so the wiring in server.ts is what is
 * tested; HOME is this vitest worker's sandbox.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { buildSync } from 'esbuild';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

for (const k of ['AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG']) delete process.env[k];

const TEST_DB = testDbPath('airlock-report-token-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import {
  ensureAirlockReportToken,
  airlockReportTokenPath,
  airlockReportTokenReader,
  readSafeAirlockReportToken,
  safeTokenStat,
  AIRLOCK_REPORT_HEADER,
} from '../airlock/reportToken';

/** Windows has no POSIX modes: assertions about 0600/0700 hold on POSIX only. */
const POSIX = process.platform !== 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-report-token-'));
const modeOf = (f: string) => fs.statSync(f).mode & 0o777;
const HEX = /^[0-9a-f]{64}$/;
const tokenFile = () => path.join(tmp(), '.agenfk', 'airlock', 'report-token');
const plant = (file: string, value: string, mode = 0o600) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${value}\n`, { mode });
  fs.chmodSync(file, mode);
};
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('ensureAirlockReportToken', () => {
  it('missing: makes the 0700 directory and a 0600 token of 32 random bytes as hex, leaving no temp file', () => {
    const file = tokenFile();
    const token = ensureAirlockReportToken(file);
    expect(token).toMatch(HEX);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(token);
    if (POSIX) {
      expect(modeOf(file)).toBe(0o600);
      expect(modeOf(path.dirname(file))).toBe(0o700);
    }
    expect(fs.readdirSync(path.dirname(file))).toEqual(['report-token']);
  });

  it('two calls agree: the second reads what the first made', () => {
    const file = tokenFile();
    expect(ensureAirlockReportToken(file)).toBe(ensureAirlockReportToken(file));
  });

  it('every platform: the token startup makes is the one the reader accepts', () => {
    const file = tokenFile();
    const token = ensureAirlockReportToken(file);
    expect(readSafeAirlockReportToken(file)).toBe(token);
    expect(airlockReportTokenReader(file)()).toBe(token);
    // And a second startup keeps it.
    expect(ensureAirlockReportToken(file)).toBe(token);
  });

  it('on Windows the mode bits are not judged (the profile ACL guards ~/.agenfk); every other condition is', () => {
    const st = (over: Partial<{ file: boolean; nlink: number; mode: number; size: number }> = {}) => ({
      isFile: () => over.file ?? true, nlink: over.nlink ?? 1, mode: over.mode ?? 0o100666, size: over.size ?? 65,
    });
    expect(safeTokenStat(st(), 'win32')).toBe(true);
    expect(safeTokenStat(st(), 'linux')).toBe(false);
    expect(safeTokenStat(st({ mode: 0o100600 }), 'linux')).toBe(true);
    expect(safeTokenStat(st({ nlink: 2 }), 'win32')).toBe(false);
    expect(safeTokenStat(st({ file: false }), 'win32')).toBe(false);
    expect(safeTokenStat(st({ size: 0 }), 'win32')).toBe(false);
  });

  it.skipIf(!POSIX)('a directory left looser is tightened to 0700', () => {
    const file = tokenFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.chmodSync(path.dirname(file), 0o755);
    ensureAirlockReportToken(file);
    expect(modeOf(path.dirname(file))).toBe(0o700);
  });

  it('present and safe: reused, unchanged', () => {
    const file = tokenFile();
    plant(file, A);
    expect(ensureAirlockReportToken(file)).toBe(A);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(A);
  });

  it('a hard-link alias (nlink 2): a new token is written; the alias keeps a dead value the route refuses', () => {
    const file = tokenFile();
    plant(file, A);
    const alias = path.join(path.dirname(path.dirname(file)), 'alias');
    fs.linkSync(file, alias);
    expect(fs.statSync(file).nlink).toBe(2);
    const token = ensureAirlockReportToken(file);
    expect(token).not.toBe(A);
    expect(token).toMatch(HEX);
    expect(fs.statSync(file).nlink).toBe(1);
    expect(fs.readFileSync(alias, 'utf8').trim()).toBe(A);
    const read = airlockReportTokenReader(file);
    expect(read()).toBe(token);
    expect(read()).not.toBe(A);
  });

  it.skipIf(!POSIX)('a 0644 file is replaced with a fresh 0600 one', () => {
    const file = tokenFile();
    plant(file, A, 0o644);
    const token = ensureAirlockReportToken(file);
    expect(token).not.toBe(A);
    expect(modeOf(file)).toBe(0o600);
  });

  for (const [what, value] of [['empty', ''], ['not hex', 'z'.repeat(64)], ['too short', 'abc123']] as const) {
    it(`a token that is ${what} is replaced`, () => {
      const file = tokenFile();
      plant(file, value);
      const token = ensureAirlockReportToken(file);
      expect(token).toMatch(HEX);
      expect(token).not.toBe(value);
    });
  }

  it.skipIf(!POSIX)('a symlink in its place is not followed; it is replaced by a real file', () => {
    const file = tokenFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const elsewhere = path.join(tmp(), 'target');
    fs.writeFileSync(elsewhere, `${A}\n`, { mode: 0o600 });
    fs.symlinkSync(elsewhere, file);
    const token = ensureAirlockReportToken(file);
    expect(token).not.toBe(A);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(elsewhere, 'utf8').trim()).toBe(A);
  });

  it('a leftover temp file is removed; one being written right now is left alone', () => {
    const file = tokenFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = path.join(path.dirname(file), '.report-token.123.abcdef.tmp');
    const fresh = path.join(path.dirname(file), '.report-token.456.012345.tmp');
    fs.writeFileSync(old, A);
    fs.writeFileSync(fresh, B);
    const t = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(old, t, t);
    ensureAirlockReportToken(file);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('defaults to ~/.agenfk/airlock/report-token, not verify-token', () => {
    expect(airlockReportTokenPath('/home/u')).toBe(path.join('/home/u', '.agenfk', 'airlock', 'report-token'));
    expect(AIRLOCK_REPORT_HEADER).toBe('x-agenfk-airlock-report');
  });
});

describe('airlockReportTokenReader (what the route accepts, per request)', () => {
  it('follows the file: replacing it on disk switches the token without a restart', () => {
    const file = tokenFile();
    plant(file, A);
    const read = airlockReportTokenReader(file);
    expect(read()).toBe(A);
    const next = path.join(path.dirname(file), 'next');
    fs.writeFileSync(next, `${B}\n`, { mode: 0o600 });
    fs.renameSync(next, file);
    expect(read()).toBe(B);
  });

  it('a same-size rewrite in place with its mtime put back is still seen: nothing is cached', () => {
    const file = tokenFile();
    plant(file, A);
    // A whole second, so putting it back is exact on every filesystem.
    const T = Math.floor(Date.now() / 1000) - 3600;
    fs.utimesSync(file, T, T);
    const read = airlockReportTokenReader(file);
    expect(read()).toBe(A);
    const before = fs.statSync(file);
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, `${B}\n`, 0);
    fs.closeSync(fd);
    fs.utimesSync(file, T, T);
    const after = fs.statSync(file);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);
    expect(read()).toBe(B);
  });

  it('missing, linked twice, or readable by others: null (refuse)', () => {
    const file = tokenFile();
    const read = airlockReportTokenReader(file);
    expect(read()).toBeNull();
    plant(file, A);
    expect(read()).toBe(A);
    fs.linkSync(file, `${file}-alias`);
    expect(read()).toBeNull();
    fs.unlinkSync(`${file}-alias`);
    expect(read()).toBe(A);
    if (POSIX) {
      fs.chmodSync(file, 0o644);
      expect(read()).toBeNull();
      expect(readSafeAirlockReportToken(file)).toBeNull();
    }
  });
});

describe('the real server: proxy reports take the report token only', () => {
  let server: import('http').Server;
  let VERIFY_TOKEN = '';
  let reportToken = '';
  beforeAll(async () => {
    const mod = await import('../server');
    await mod.initStorage();
    VERIFY_TOKEN = mod.VERIFY_TOKEN;
    server = mod.app.listen(0);
    reportToken = readSafeAirlockReportToken(airlockReportTokenPath()) ?? '';
  });
  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()));
    const mod = await import('../server');
    await removeTestDb(TEST_DB, mod.closeStorage);
  });

  const body = { client: 'pi', model: 'openai/gpt-x', decisions: [{ host: 'evil.example', port: 443, decision: 'deny', rule: 'not-on-allow-list' }] };
  const post = (headers: Record<string, string>) => request(server).post('/airlock/proxy-decisions').set(headers).send(body);

  it('the server made the token file at startup, 0600, distinct from VERIFY_TOKEN', () => {
    expect(reportToken).toMatch(HEX);
    if (POSIX) {
      expect(modeOf(airlockReportTokenPath())).toBe(0o600);
      expect(modeOf(path.dirname(airlockReportTokenPath()))).toBe(0o700);
    }
    expect(reportToken).not.toBe(VERIFY_TOKEN);
  });

  it('VERIFY_TOKEN is refused in the internal header and in the report header', async () => {
    expect((await post({ 'x-agenfk-internal': VERIFY_TOKEN })).status).toBe(403);
    expect((await post({ [AIRLOCK_REPORT_HEADER]: VERIFY_TOKEN })).status).toBe(403);
  });

  it('the report token in the internal header is refused', async () => {
    expect((await post({ 'x-agenfk-internal': reportToken })).status).toBe(403);
  });

  it('a token replaced on disk is the one accepted, without a restart; the old one is refused', async () => {
    const file = airlockReportTokenPath();
    const before = reportToken;
    const next = path.join(path.dirname(file), 'swap');
    fs.writeFileSync(next, `${B}\n`, { mode: 0o600 });
    fs.renameSync(next, file);
    try {
      const fresh = { ...body, decisions: [{ ...body.decisions[0], host: 'swapped.example' }] };
      expect((await request(server).post('/airlock/proxy-decisions').set({ [AIRLOCK_REPORT_HEADER]: B }).send(fresh)).status).toBe(200);
      expect((await post({ [AIRLOCK_REPORT_HEADER]: before })).status).toBe(403);
    } finally {
      fs.writeFileSync(next, `${before}\n`, { mode: 0o600 });
      fs.renameSync(next, file);
    }
  });

  it('the report token in the report header is accepted and logged as a proxy decision', async () => {
    const res = await post({ [AIRLOCK_REPORT_HEADER]: reportToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ recorded: 1 });
    const decisions = (await request(server).get('/airlock/decisions')).body.decisions;
    expect(decisions[0]).toMatchObject({ source: 'proxy', target: 'evil.example:443' });
  });
});

// A FIFO at the path must not hang the server: run it in a child, with a timeout,
// so a regression fails this test instead of hanging the suite.
describe.skipIf(process.platform === 'win32')('a FIFO at report-token', () => {
  it('neither the startup check nor the per-request read blocks on it; startup replaces it with a token', () => {
    const dir = path.join(tmp(), 'airlock');
    fs.mkdirSync(dir, { mode: 0o700 });
    const fifo = path.join(dir, 'report-token');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const bundle = path.join(tmp(), 'reportToken.cjs');
    buildSync({ entryPoints: [path.resolve(__dirname, '../airlock/reportToken.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    const script = `
      const m = require(${JSON.stringify(bundle)});
      const read = m.airlockReportTokenReader(${JSON.stringify(fifo)});
      const before = read();
      const token = m.ensureAirlockReportToken(${JSON.stringify(fifo)});
      console.log(JSON.stringify({ before, token, after: read() }));`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 });
    expect(r.error, 'the child hung on the FIFO').toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.before).toBeNull();
    expect(out.token).toMatch(HEX);
    expect(out.after).toBe(out.token);
    expect(fs.lstatSync(fifo).isFile()).toBe(true);
  });
});
