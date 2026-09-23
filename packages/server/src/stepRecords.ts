/**
 * CGLAB-379 — what a test run said, test by test, and which files it depends on.
 *
 * Per-step checks (CGLAB-380) compare test runs by NAME: the tests that failed
 * when the tests were written must pass later, under the same names, and a
 * skipped or missing test is not a pass. An exit code cannot say any of that,
 * so these readers turn a runner's report into names, statuses and failure
 * classes. A test file that fails to load has no names to compare, so it is
 * reported on its own, as broken - never silently dropped.
 *
 * The TEST SURFACE is the content of the files a run depends on: the test
 * files the report names plus the runner's config. It is hashed from the
 * WORKING TREE, not from git history, so an edit cannot hide behind an amend.
 *
 * Pure functions only: no server state, no spawning.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type ReportedStatus = 'passed' | 'failed' | 'skipped';
export type FailureClass = 'assertion' | 'error';

export interface ReportedTest {
  /** `<file> > <full test name>` - stable across runs, the key checks compare. */
  readonly name: string;
  readonly file: string;
  readonly status: ReportedStatus;
  /** Only on a failed test: an assertion that did not hold, or anything else thrown. */
  readonly failure?: FailureClass;
}

export interface ParsedReport {
  readonly tests: ReportedTest[];
  /**
   * Files that failed as a whole: an import-time throw (no tests at all), or
   * a hook that threw after its tests passed. Either way the file failed.
   */
  readonly brokenFiles: Array<{ file: string; message: string }>;
  /** Names reported more than once: a check keyed by name cannot tell them apart. */
  readonly duplicateNames: string[];
}

export interface TestSurface {
  /** Repository-relative path -> sha256 of its current content. */
  readonly files: Record<string, string>;
  /** Named files that could not be found in the tree: the surface is then incomplete. */
  readonly missing: string[];
}

/** Runner configuration that decides which tests run and how: part of the surface. */
const RUNNER_CONFIGS = [
  'vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.workspace.ts',
  'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs',
  'jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs',
  'playwright.config.ts', 'playwright.config.js',
  'pytest.ini', 'conftest.py', 'tox.ini', 'setup.cfg', 'pyproject.toml',
  // Where test scripts and jest config live, and the conventional setup files
  // - a stubbed `expect` in one of these turns red green without touching a test.
  'package.json',
  'vitest.setup.ts', 'vitest.setup.js', 'vitest.setup.mts', 'jest.setup.ts', 'jest.setup.js',
  'setupTests.ts', 'setupTests.js',
];

/** Most files the extra surface paths may contribute before the surface is marked incomplete. */
const SURFACE_WALK_CAP = 20_000;

function duplicatesOf(tests: readonly ReportedTest[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const t of tests) (seen.has(t.name) ? dup : seen).add(t.name);
  return [...dup];
}

const toPosix = (p: string) => p.split(path.sep).join('/');

const realOr = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };

/**
 * A path as the repository names it: relative to `root`, forward slashes.
 * Runners report REAL paths, and a root reached through a symlink (macOS
 * /var -> /private/var, a symlinked checkout) would otherwise turn every test
 * file into a `../../..` chain - so both sides are also tried resolved.
 */
function relativeTo(root: string, p: string): string {
  if (!path.isAbsolute(p)) return toPosix(path.normalize(p));
  for (const r of new Set([root, realOr(root)])) {
    for (const f of new Set([p, realOr(p)])) {
      const rel = path.relative(r, f);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
    }
  }
  return toPosix(path.relative(root, p));
}

/**
 * `abs` as a path relative to `root`, or null when it leaves the root -
 * lexically or through a symlink. For a path that does not exist yet (a report
 * about to be written) the nearest existing ancestor is resolved instead.
 */
export function insideRoot(root: string, abs: string): string | null {
  const base = path.resolve(root);
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  const real = path.relative(realOr(base), realOr(probe));
  if (real.startsWith('..') || path.isAbsolute(real)) return null;
  return toPosix(rel);
}

function classify(message: string): FailureClass {
  return /AssertionError|expected .* to /i.test(message) ? 'assertion' : 'error';
}

/** Vitest's `--reporter=json` output. Throws when the text is not one. */
export function parseVitestJson(text: string, root: string): ParsedReport {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.testResults)) throw new Error('not a vitest JSON report: no testResults array');
  const tests: ReportedTest[] = [];
  const brokenFiles: Array<{ file: string; message: string }> = [];
  for (const f of data.testResults) {
    const file = relativeTo(root, String(f?.name ?? ''));
    const results = Array.isArray(f?.assertionResults) ? f.assertionResults : [];
    const fileMessage = String(f?.message ?? '');
    if (f?.status === 'failed' && (results.length === 0 || fileMessage.trim())) {
      brokenFiles.push({ file, message: fileMessage.split('\n')[0] });
      if (results.length === 0) continue;
    }
    for (const a of results) {
      const status: ReportedStatus = a?.status === 'passed' ? 'passed' : a?.status === 'failed' ? 'failed' : 'skipped';
      const messages = Array.isArray(a?.failureMessages) ? a.failureMessages.join('\n') : '';
      tests.push({
        name: `${file} > ${String(a?.fullName ?? a?.title ?? '')}`,
        file,
        status,
        ...(status === 'failed' ? { failure: classify(messages) } : {}),
      });
    }
  }
  return { tests, brokenFiles, duplicateNames: duplicatesOf(tests) };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return out;
}

/**
 * JUnit XML, as pytest, go-junit-report, surefire, dotnet and most CI tools
 * write it. Only `<testcase>` and its `<failure>`/`<error>`/`<skipped>`
 * children are read. Throws when there is no `<testsuite>` at all.
 *
 * A tokenizer, not a pattern over the whole text: comments and CDATA are
 * removed first (a `<testcase>` quoted inside either must not become a test),
 * quoted attributes may contain `>`, and every tag is visited once - so a
 * large or truncated report is read in linear time.
 */
export function parseJunitXml(text: string, root: string): ParsedReport {
  // One left-to-right pass: whichever of a comment or a CDATA section opens
  // first wins, so a `<!--` inside one test's output cannot eat later tests.
  const clean = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const tests: ReportedTest[] = [];
  let sawSuite = false;
  let open: { attrs: Record<string, string>; failed?: 'assertion' | 'error'; skipped?: boolean } | null = null;
  const close = () => {
    if (!open) return;
    const file = open.attrs.file ? relativeTo(root, open.attrs.file) : (open.attrs.classname ?? '');
    const status: ReportedStatus = open.failed ? 'failed' : open.skipped ? 'skipped' : 'passed';
    tests.push({ name: `${file} > ${open.attrs.name ?? ''}`, file, status, ...(open.failed ? { failure: open.failed } : {}) });
    open = null;
  };
  for (const m of clean.matchAll(tag)) {
    const [, closing, name, attrText, selfClosing] = m;
    if (name === 'testsuite' || name === 'testsuites') { sawSuite = true; continue; }
    if (name === 'testcase') {
      if (closing) { close(); continue; }
      close(); // an unclosed testcase ends where the next begins
      open = { attrs: attributes(attrText) };
      if (selfClosing) close();
      continue;
    }
    if (!open || closing) continue;
    if (name === 'failure') open.failed = open.failed ?? 'assertion';
    else if (name === 'error') open.failed = 'error';
    else if (name === 'skipped') open.skipped = true;
  }
  close();
  if (!sawSuite) throw new Error('not a JUnit XML report: no <testsuite>');
  return { tests, brokenFiles: [], duplicateNames: duplicatesOf(tests) };
}

/**
 * Hash the files a run depends on, from the working tree: `files` (what the
 * report named), runner config, package.json and conventional setup files at
 * the root, and `extra` paths from the project setting (a directory is walked).
 *
 * A report is input the server did not write, so it never chooses what gets
 * read: a path that resolves outside the root - lexically or through a
 * symlink - is left out. A named file that cannot be found is listed in
 * `missing` (a dotted pytest classname is first tried as a path), so a check
 * can tell an incomplete surface from a complete one.
 */
export function surfaceOf(root: string, files: readonly string[], extra: readonly string[] = []): TestSurface {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  const base = path.resolve(root);
  const inside = (abs: string) => insideRoot(base, abs);
  const hashFile = (abs: string, rel: string): boolean => {
    try {
      if (!fs.statSync(abs).isFile()) return false;
      out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      return true;
    } catch {
      return false;
    }
  };
  // Symlinks are never followed (a loop would walk for minutes, synchronously),
  // and the walk stops at SURFACE_WALK_CAP files, marking the surface incomplete.
  let walked = 0;
  let capped = false;
  const walk = (abs: string) => {
    if (capped) return;
    const rel = inside(abs);
    if (!rel) return;
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isFile()) {
      if (++walked > SURFACE_WALK_CAP) { capped = true; return; }
      hashFile(abs, rel);
      return;
    }
    if (!st.isDirectory()) return;
    for (const e of fs.readdirSync(abs)) {
      if (e === 'node_modules' || e === '.git') continue;
      walk(path.join(abs, e));
    }
  };

  for (const name of new Set(files)) {
    const candidates = [name];
    // pytest's xunit2 report names a module or a class, not a file:
    // tests.test_a -> tests/test_a.py, tests.test_a.TestK -> tests/test_a.py
    if (!name.includes('/') && /^[\w.]+$/.test(name) && name.includes('.')) {
      const segs = name.split('.');
      for (let k = segs.length; k >= 1; k--) candidates.push(`${segs.slice(0, k).join('/')}.py`);
    }
    const found = candidates.some(c => {
      const abs = path.resolve(base, c);
      const rel = inside(abs);
      return rel !== null && hashFile(abs, rel);
    });
    if (!found) missing.push(name);
  }
  for (const cfg of RUNNER_CONFIGS) {
    const abs = path.resolve(base, cfg);
    const rel = inside(abs);
    if (rel) hashFile(abs, rel);
  }
  for (const e of extra) {
    const abs = path.resolve(base, e);
    if (!fs.existsSync(abs)) missing.push(e); else walk(abs);
  }
  if (capped) missing.push(`(more than ${SURFACE_WALK_CAP} files under the extra paths)`);
  return { files: out, missing };
}

/** What changed from `before` to `after`: `added x`, `deleted y`, `edited z`. */
export function surfaceDiff(before: TestSurface, after: TestSurface): string[] {
  const out: string[] = [];
  for (const f of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    if (!(f in after.files)) out.push(`deleted ${f}`);
    else if (!(f in before.files)) out.push(`added ${f}`);
    else if (before.files[f] !== after.files[f]) out.push(`edited ${f}`);
  }
  return out;
}
