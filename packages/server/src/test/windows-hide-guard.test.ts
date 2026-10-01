/**
 * @file GitHub #200 — every child process AgEnFK launches must pass
 * `windowsHide: true`.
 *
 * The API server runs in the background with no console (start-services.mjs
 * spawns it `detached: true`). On Windows, when a console-less process starts a
 * console child (cmd.exe, git.exe, gh.exe, any `shell: true` spawn) without
 * CREATE_NO_WINDOW, Windows allocates a NEW, VISIBLE console window for it — and
 * that window steals keyboard focus. Node only passes CREATE_NO_WINDOW when
 * `windowsHide: true` is set, and it was set nowhere, so every `agenfk verify`,
 * close commit and git probe flashed a CMD window over whatever the user was
 * typing in. The option is a no-op on macOS/Linux.
 *
 * WHY A STRUCTURAL GUARD, given CGLAB-16 moved this repo to behaviour-based
 * tests: the invariant is per call site (~170 of them across server, CLI, hooks
 * and installer), most only reachable with `gh`/JIRA configured or on a real
 * upgrade, and the failure is invisible off Windows. The reachable hot paths
 * are exercised behaviourally in windows-hide-server.test.ts; this guard is the
 * lint that stops a NEW call site from silently reintroducing the popups. It
 * parses the TypeScript AST rather than grepping, and the fixture tests below
 * pin that the scanner actually sees each import form the repo uses.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');

const CP_MODULES = new Set(['child_process', 'node:child_process']);
const SPAWNERS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']);

/**
 * Build/test tooling that only ever runs from a developer's terminal (so it
 * inherits that console and never pops a window). Everything else under the
 * scanned roots ships to users or runs under the server.
 */
const DEV_TOOLING = new Set([
  'scripts/enforce-coverage.ts',
  'scripts/package-dist.mjs',
  'scripts/package-helpers.mjs',
  'scripts/package-hub-dist.mjs',
  'scripts/stryker-home-wrap.mjs',
  'scripts/vitest-net-guard.mjs',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '__tests__', 'coverage', '.git']);
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const NOT_SOURCE = /\.d\.[cm]?ts$|\.(test|spec)\.[cm]?[jt]sx?$/;

interface Violation { line: number; fn: string; reason: string }

const strip = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = e.expression;
  }
  return e;
};

/** `require('child_process')` or `import('child_process')`, possibly awaited. */
const isChildProcessModule = (e: ts.Expression | undefined): boolean => {
  if (!e) return false;
  const x = strip(e);
  if (!ts.isCallExpression(x)) return false;
  const isLoader = x.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(x.expression) && x.expression.text === 'require');
  const [arg] = x.arguments;
  return isLoader && !!arg && ts.isStringLiteralLike(arg) && CP_MODULES.has(arg.text);
};

const passesWindowsHide = (args: readonly ts.Expression[]): boolean =>
  args.some(a => ts.isObjectLiteralExpression(a) && a.properties.some(p =>
    ts.isPropertyAssignment(p)
    && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    && p.name.text === 'windowsHide'
    && p.initializer.kind === ts.SyntaxKind.TrueKeyword));

function findUnhiddenSpawns(source: string, fileName = 'fixture.ts'): Violation[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX
    : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const named = new Map<string, string>(); // local binding -> child_process export
  const namespaces = new Set<string>();

  const bindDestructure = (pattern: ts.ObjectBindingPattern) => {
    for (const el of pattern.elements) {
      const imported = (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name);
      if (ts.isIdentifier(imported) && ts.isIdentifier(el.name) && SPAWNERS.has(imported.text)) {
        named.set(el.name.text, imported.text);
      }
    }
  };

  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CP_MODULES.has(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) {
        for (const s of nb.elements) {
          const imported = (s.propertyName ?? s.name).text;
          if (SPAWNERS.has(imported)) named.set(s.name.text, imported);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && isChildProcessModule(node.initializer)) {
      if (ts.isObjectBindingPattern(node.name)) bindDestructure(node.name);
      else if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  /** The child_process export a callee resolves to, looking through `a ?? exec`. */
  const spawnerOf = (callee: ts.Expression): string | null => {
    const c = strip(callee);
    if (ts.isIdentifier(c)) return named.get(c.text) ?? null;
    if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)
      && namespaces.has(c.expression.text) && SPAWNERS.has(c.name.text)) return c.name.text;
    if (ts.isBinaryExpression(c)) return spawnerOf(c.left) ?? spawnerOf(c.right);
    if (ts.isConditionalExpression(c)) return spawnerOf(c.whenTrue) ?? spawnerOf(c.whenFalse);
    return null;
  };

  const violations: Violation[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const fn = spawnerOf(node.expression);
      if (fn && !passesWindowsHide(node.arguments)) {
        violations.push({ line: lineOf(node), fn, reason: 'no inline `windowsHide: true` in the options object' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

/**
 * Scripts the installer WRITES from a template string (install.mjs generates
 * scripts/start-services.mjs on every install/upgrade). Fixing only the checked-in
 * copy would be undone by the next `agenfk upgrade`, so a template literal that
 * itself imports child_process is scanned as a script of its own. Its `${}`
 * substitutions are replaced by a placeholder identifier.
 */
function findUnhiddenSpawnsInEmbeddedScripts(source: string, fileName: string): Violation[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: Violation[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map(s => '__subst__' + s.literal.text).join('');
    if (text !== null && /\b(import|require)\b[^\n]*child_process/.test(text)) {
      const base = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      for (const v of findUnhiddenSpawns(text, 'embedded.mjs')) {
        out.push({ ...v, line: base + v.line, reason: `${v.reason} (in a generated script)` });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function runtimeSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
      } else if (SOURCE_EXT.test(entry.name) && !NOT_SOURCE.test(entry.name)) {
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        if (!DEV_TOOLING.has(rel)) out.push(rel);
      }
    }
  };
  for (const top of ['bin', 'scripts', 'packages']) walk(path.join(ROOT, top));
  return out.sort();
}

describe('findUnhiddenSpawns — the scanner sees every import form the repo uses', () => {
  it('flags a named-import call with no options', () => {
    const v = findUnhiddenSpawns(`import { spawn } from 'child_process';\nspawn('git', ['status']);`);
    expect(v).toEqual([expect.objectContaining({ line: 2, fn: 'spawn' })]);
  });

  it('flags options that omit windowsHide, or set it to anything but true', () => {
    const src = `import { execSync } from 'child_process';
execSync('git status', { encoding: 'utf8' });
execSync('git status', { windowsHide: false });`;
    expect(findUnhiddenSpawns(src).map(v => v.line)).toEqual([2, 3]);
  });

  it('accepts a call that passes windowsHide: true inline', () => {
    const src = `import { spawn, execFile } from 'child_process';
spawn('git', ['status'], { cwd: '.', windowsHide: true });
execFile('gh', ['--version'], { windowsHide: true }, () => {});`;
    expect(findUnhiddenSpawns(src)).toEqual([]);
  });

  it('follows aliases, node: specifiers and namespace imports', () => {
    const src = `import { spawnSync as run } from 'node:child_process';
import * as cp from 'child_process';
run('node', ['-v']);
cp.exec('dir');`;
    expect(findUnhiddenSpawns(src).map(v => v.fn)).toEqual(['spawnSync', 'exec']);
  });

  it('follows require() and dynamic import() destructuring', () => {
    const src = `const { execSync } = require('child_process');
async function f() { const { execFile } = await import('child_process'); execFile('git', []); }
execSync('git pull');`;
    expect(findUnhiddenSpawns(src, 'x.js').map(v => v.fn).sort()).toEqual(['execFile', 'execSync']);
  });

  it('sees through an injectable-impl fallback like `(impl ?? exec)(...)`', () => {
    const src = `import { exec } from 'child_process';\nlet impl = null;\n(impl ?? exec)('npx x', { cwd: '/' });`;
    expect(findUnhiddenSpawns(src)).toEqual([expect.objectContaining({ line: 3, fn: 'exec' })]);
  });

  it('scans a script the installer generates from a template string', () => {
    const src = [
      'const port = 3000;',
      'const script = `',
      "import { spawn } from 'child_process';",
      "spawn('node', ['server.js'], { detached: true });",
      "spawn('npm', ['run', '${port}'], { windowsHide: true });",
      '`;',
    ].join('\n');
    expect(findUnhiddenSpawnsInEmbeddedScripts(src, 'install.mjs'))
      .toEqual([expect.objectContaining({ line: 4, fn: 'spawn' })]);
  });

  it('ignores same-named functions that do not come from child_process', () => {
    const src = `const re = /a/; re.exec('a'); db.exec('select 1'); function spawn() {} spawn();`;
    expect(findUnhiddenSpawns(src)).toEqual([]);
  });
});

describe('GitHub #200 — every runtime child process is spawned hidden', () => {
  const files = runtimeSourceFiles();

  it('scans the files that launch processes at runtime (the guard is not vacuous)', () => {
    for (const f of [
      'packages/server/src/server.ts',
      'packages/cli/src/index.ts',
      'scripts/start-services.mjs',
      'scripts/install.mjs',
      'bin/agenfk-pr-hook.mjs',
      'packages/create/bin/agenfk.js',
    ]) expect(files).toContain(f);
  });

  it('no child_process call omits windowsHide: true', () => {
    const offenders = files.flatMap(rel => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      return [...findUnhiddenSpawns(src, rel), ...findUnhiddenSpawnsInEmbeddedScripts(src, rel)]
        .map(v => `${rel}:${v.line} ${v.fn}() — ${v.reason}`);
    });
    expect(offenders).toEqual([]);
  });
});
