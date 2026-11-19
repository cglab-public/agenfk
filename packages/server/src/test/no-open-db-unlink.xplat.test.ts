/**
 * @file GitHub #208 phase 1 — no spec deletes its database file while it may be open.
 *
 * Inside a hook or a test the server (or a provider the spec opened) can hold
 * the database, and Windows refuses to delete an open file (EBUSY). Those
 * deletions go through `removeTestDb(path, close)` from test/helpers/testDb.ts,
 * which closes first. Module scope is fine: it runs before anything opens it.
 *
 * It parses the TypeScript AST rather than grepping, so a call is judged by the
 * function it sits in, and the fixture tests below pin what the scanner sees.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');
const BLOCKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach', 'it', 'test']);
const DELETERS = /(^|\.)(unlinkSync|rmSync|unlink|rm)$/;
/** The argument names a database (TEST_DB, dbPath, DB_PATH + '-wal'...), not a directory - nor a `sandbox`. */
const NAMES_A_DB = (text: string) => /(?:^|[^a-z])db|DB|Db/.test(text) && !/dir|tmp|root|home/i.test(text);
/**
 * Specs whose every test closes what it opened (`db.close()` / `shutdown()`)
 * before the afterEach deletes it - nothing is open there, the scanner just
 * cannot see across the test boundary.
 */
const CLOSED_BY_THEIR_TESTS = new Set([
  'packages/storage-sqlite/src/test/migration.test.ts',
]);

/** Closing first is the whole point; a deletion after one in the same hook or test is fine. */
// An HTTP server's close (`__server.close(...)`, in almost every spec) does not close the database;
// nor does a watcher's or a socket server's: only a database-ish receiver counts (#208 branch review).
const CLOSES = /\b(closeStorage|removeTestDb|\w+\.shutdown|\w*(?:db|Db|DB|storage|Storage|provider|Provider|sqlite|database)\.close)\(/;

function openDbDeletions(source: string, fileName = 'fixture.ts'): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines: number[] = [];
  // `const f = TEST_DB + suffix; fs.unlinkSync(f)` names a database through `f`.
  const initializers = new Map<string, string[]>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      initializers.set(n.name.text, [...(initializers.get(n.name.text) ?? []), n.initializer.getText(sf)]);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const namesADb = (arg: ts.Expression): boolean => NAMES_A_DB(arg.getText(sf))
    || (ts.isIdentifier(arg) && (initializers.get(arg.text) ?? []).some(NAMES_A_DB));
  /**
   * `block` is the hook or test call the node sits in, or null at module scope. A module-scope
   * helper (`cleanup = () => unlinkSync(TEST_DB)`) is not judged here: the hub's ~100 specs call
   * theirs right after `ctx.db.close()`, and the blocking full-suite Windows CI job fails on the
   * EBUSY an open database would raise - stronger than reading call sites (#208 branch review).
   */
  const visit = (n: ts.Node, block: ts.CallExpression | null): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (BLOCKS.has(callee.split('.')[0])) block = n;
      const [arg] = n.arguments;
      if (block && DELETERS.test(callee) && arg && namesADb(arg)
        && !CLOSES.test(source.slice(block.getStart(sf), n.getStart(sf)))) {
        lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(n, c => visit(c, block));
  };
  visit(sf, null);
  return lines;
}

function specFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) specFiles(full, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('test databases', () => {
  it('the TypeScript compiler API the scanner relies on is present', () => {
    expect(typeof ts.createSourceFile).toBe('function');
    expect(typeof ts.forEachChild).toBe('function');
  });

  it('the scanner flags a deletion in a hook or a test, and leaves module scope alone', () => {
    expect(openDbDeletions(`
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
      afterAll(() => { for (const s of ['', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); });
      beforeEach(async () => { fs.rmSync(dbPath, { force: true }); await initStorage(); });
      it('x', () => { fs.unlinkSync(DB_PATH); });
      afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
      afterAll(async () => { await removeTestDb(TEST_DB, closeStorage); });
      afterAll(() => { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
      afterAll(async () => { await storage.shutdown(); fs.unlinkSync(dbPath); });
      afterAll(() => { for (const s of ['', '-wal']) { const f = TEST_DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } });
      afterAll(async () => { await new Promise(r => __server.close(() => r())); fs.unlinkSync(TEST_DB); });
      afterAll(async () => { await db.close(); fs.unlinkSync(DB); });
      afterAll(() => { watcher.close(); fs.unlinkSync(TEST_DB); });
      afterAll(async () => { await ctx.db.close(); fs.unlinkSync(TEST_DB); });
    `)).toEqual([3, 4, 5, 10, 11, 13]);
  });

  it('no spec under packages/*/src deletes a database inside a hook or a test', () => {
    const offenders: string[] = [];
    for (const pkg of fs.readdirSync(path.join(ROOT, 'packages'))) {
      const src = path.join(ROOT, 'packages', pkg, 'src');
      if (!fs.existsSync(src)) continue;
      for (const file of specFiles(src)) {
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        if (file === __filename || CLOSED_BY_THEIR_TESTS.has(rel)) continue;
        for (const line of openDbDeletions(fs.readFileSync(file, 'utf8'), file)) offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders, 'close first: await removeTestDb(path, close) from test/helpers/testDb.ts').toEqual([]);
  });
});
