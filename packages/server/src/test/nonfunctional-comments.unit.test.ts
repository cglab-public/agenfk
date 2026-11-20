/**
 * @file GH-392 — the comment classifier behind the no-nonfunctional-comments
 * check: which comments a step's added lines may carry (directives, shebangs,
 * license headers, docstrings) and which fail (everything else), per language,
 * with comment markers inside string literals never counted.
 */
import { describe, it, expect } from 'vitest';

const mod = () => import('../nonFunctionalComments');
const src = (...lines: string[]) => lines.join('\n') + '\n';
/** The flagged line numbers of `content` as `file`, every line counted as added. */
async function flagged(file: string, content: string, added?: number[]): Promise<number[]> {
  const r = (await mod()).flagComments(file, content, added ? new Set(added) : undefined);
  expect(r, `${file} should be a known type`).not.toBeNull();
  return r!.map(c => c.line);
}

describe('languages', () => {
  it('knows each listed language by its extension', async () => {
    const { languageOf } = await mod();
    const cases: Record<string, string> = {
      'a.js': 'js', 'a.jsx': 'js', 'a.ts': 'js', 'a.tsx': 'js', 'a.mjs': 'js', 'a.cjs': 'js', 'a.mts': 'js',
      'a.py': 'python', 'a.sh': 'shell', 'a.bash': 'shell', 'a.zsh': 'shell', 'a.go': 'go', 'a.rs': 'rust',
      'A.java': 'java', 'a.kt': 'kotlin', 'a.kts': 'kotlin', 'a.cs': 'csharp', 'a.c': 'c', 'a.h': 'c', 'a.cpp': 'c',
      'a.cc': 'c', 'a.hpp': 'c', 'a.rb': 'ruby', 'Gemfile': 'ruby', 'Rakefile': 'ruby', 'a.yml': 'yaml', 'a.yaml': 'yaml',
      'a.sql': 'sql', 'a.css': 'css', 'a.scss': 'scss', 'a.less': 'scss',
    };
    for (const [f, lang] of Object.entries(cases)) expect(languageOf(f), f).toBe(lang);
  });

  it('knows an extensionless script by its shebang', async () => {
    const { languageOf } = await mod();
    expect(languageOf('bin/run', '#!/usr/bin/env bash')).toBe('shell');
    expect(languageOf('bin/tool', '#!/usr/bin/env python3')).toBe('python');
    expect(languageOf('bin/cli', '#!/usr/bin/env node')).toBe('js');
  });

  it('returns null for a type it has no rules for: Markdown, JSON, text', async () => {
    const { languageOf, flagComments } = await mod();
    for (const f of ['README.md', 'SKILL.md', 'package.json', 'notes.txt', 'img.png', 'tsconfig.json']) expect(languageOf(f), f).toBeNull();
    expect(flagComments('SKILL.md', '---\nname: x\ndescription: a skill # not a comment\n---\n')).toBeNull();
  });
});

describe('JS/TS: what fails', () => {
  it('flags narration, explanatory notes and commented-out code', async () => {
    expect(await flagged('a.ts', src(
      'const a = 1;',
      '// now we add the two numbers',
      'const b = a + 1; // the sum',
      '// const c = 3;',
    ))).toEqual([2, 3, 4]);
  });

  it('flags a bare TODO/FIXME, and a TODO with a ticket reference too', async () => {
    expect(await flagged('a.ts', src('// TODO: tidy this', '// FIXME', '// TODO(GH-392): later', 'const x = 1;'))).toEqual([1, 2, 3]);
  });

  it('flags a block comment that is not a docstring on a declaration', async () => {
    expect(await flagged('a.ts', src('foo();', '/* a note', '   over lines */', 'bar();'))).toEqual([2]);
  });

  it('flags a JSDoc block that documents no declaration (before a statement)', async () => {
    expect(await flagged('a.ts', src('function f() {', '  /** first we check */', '  if (x) return 1;', '  return 2;', '}'))).toEqual([2]);
  });

  it('flags a JSX comment', async () => {
    expect(await flagged('a.tsx', src('const v = (', '  <div>', '    {/* the header */}', '  </div>', ');'))).toEqual([3]);
  });
});

describe('JS/TS: what is allowed', () => {
  it('allows linter and compiler directives', async () => {
    expect(await flagged('a.ts', src(
      '// eslint-disable-next-line no-console',
      '/* eslint-disable */',
      '// @ts-expect-error - wrong on purpose',
      '// @ts-ignore',
      '// @ts-nocheck',
      '/* istanbul ignore next */',
      '/* c8 ignore next 3 */',
      '// nosemgrep: rule-id',
      '// prettier-ignore',
      '/// <reference types="vitest" />',
      'const x = /* @__PURE__ */ make();',
      'import(/* webpackChunkName: "x" */ "./x");',
      'const y = 1;',
    ))).toEqual([]);
  });

  it('allows a test-environment pragma', async () => {
    expect(await flagged('a.test.ts', src('// @vitest-environment jsdom', '/** @jest-environment node */', 'test();'))).toEqual([]);
  });

  it('allows a shebang on line 1', async () => {
    expect(await flagged('cli.js', src('#!/usr/bin/env node', 'run();'))).toEqual([]);
  });

  it('allows a license header before any code, and an SPDX line', async () => {
    expect(await flagged('a.js', src('/*', ' * Copyright (c) 2026 ACME', ' * Licensed under MIT', ' */', '// SPDX-License-Identifier: MIT', 'run();'))).toEqual([]);
  });

  it('does not take a copyright word below the code for a header', async () => {
    expect(await flagged('a.js', src('run();', '// copyright notes follow'))).toEqual([2]);
  });

  it('allows a JSDoc block immediately before a declaration of any kind', async () => {
    expect(await flagged('a.ts', src(
      '/** Adds. */',
      'export function add(a: number) { return a; }',
      '/** A class. */',
      'export default class K {',
      '  /** A field. */',
      '  private readonly n = 1;',
      '  /** A method. */',
      '  async go(a: string): Promise<void> {}',
      '}',
      '/** A const. */',
      'export const z = 1;',
      '/** A type. */',
      'type T = { /** a member */ a: string };',
      '/**',
      ' * An interface.',
      ' */',
      '@decorated()',
      'export interface I {',
      '  /** an optional member */',
      '  b?: number;',
      '}',
      'const o = {',
      '  /** a property */',
      '  key: 1,',
      '};',
    ))).toEqual([]);
  });

  it('allows JSDoc type annotations wherever they stand', async () => {
    expect(await flagged('a.js', src('/** @typedef {{a: string}} A */', 'const v = /** @type {A} */ (x);'))).toEqual([]);
  });
});

describe('JS/TS: strings are not comments', () => {
  it('ignores comment markers in quotes, template literals and their interpolations', async () => {
    expect(await flagged('a.ts', src(
      'const u = "http://example.com";',
      "const p = '/* not a comment */';",
      'const t = `a // b ${"/* c */"} d ${x ? `// e` : y}`;',
      'const n = 1; // but this is',
    ))).toEqual([4]);
  });

  it('ignores comment markers in a regex literal', async () => {
    expect(await flagged('a.js', src('const r = /https?:\\/\\//;', 'const s = x.split(/\\/\\*/);', 'const q = /[/]+/g;'))).toEqual([]);
  });

  it('only flags lines the step added', async () => {
    const content = src('// an old comment', 'const a = 1;', '// a new comment', 'const b = 2;');
    expect(await flagged('a.ts', content, [3, 4])).toEqual([3]);
    expect(await flagged('a.ts', content, [2, 4])).toEqual([]);
  });

  it('flags a block comment when any of its lines was added', async () => {
    expect(await flagged('a.ts', src('foo();', '/* old', ' new line', ' */', 'bar();'), [3])).toEqual([2]);
  });

  it('does not flag a comment whose every line the diff removed elsewhere: it moved, it was not added', async () => {
    const r = (await mod()).flagComments('a.ts', src('x();', '  // moved here', 'y(); // a new one', '/* a moved', '   block */'), undefined, 'old(); // moved here\n/* a moved\n   block */\n');
    expect(r!.map(c => c.line)).toEqual([3]);
  });

  it('flags a block comment only part of which the diff removed', async () => {
    const r = (await mod()).flagComments('a.ts', src('/* a moved', '   but extended */'), undefined, '/* a moved\n');
    expect(r!.map(c => c.line)).toEqual([1]);
  });

  it('reports the line and the comment text', async () => {
    const r = (await mod()).flagComments('a.ts', src('x();', 'y(); // why we call y'))!;
    expect(r).toEqual([{ line: 2, text: '// why we call y' }]);
  });
});

describe('known limits of the scanner, pinned as they behave now', () => {
  it('a /* inside a regex literal after a closing parenthesis is read as a comment', async () => {
    const r = (await mod()).flagComments('a.js', src('if (ok) /[/*]/.test(s);', 'next();'));
    expect(r).not.toBeNull();
    expect(r!.length).toBeGreaterThan(0);
  });

  it('JSX text holding // is read as a comment', async () => {
    expect(await flagged('a.jsx', src('const v = <p>see http://example.com</p>;'))).toEqual([1]);
  });

  it('a Ruby heredoc body holding # is read as a comment', async () => {
    expect(await flagged('a.rb', src('text = <<~EOS', '  # a line of the text', 'EOS'))).toEqual([2]);
  });

  it('the limits are named in words the check can show', async () => {
    const { SCANNER_LIMITS } = await mod();
    for (const w of [/regex/i, /interpolation/i, /heredoc/i, /JSX/]) expect(SCANNER_LIMITS).toMatch(w);
  });
});

describe('Python', () => {
  it('allows module, class and function docstrings', async () => {
    expect(await flagged('a.py', src(
      '"""The module."""',
      'import os',
      'class K:',
      '    """The class."""',
      '    def go(self,',
      '           a):',
      "        '''The method.'''",
      '        return a',
      'async def run():',
      '    r"""Raw docstring."""',
      '    pass',
    ))).toEqual([]);
  });

  it('flags a bare string statement that is no docstring, and every # note', async () => {
    expect(await flagged('a.py', src(
      'def f():',
      '    x = 1',
      '    """not a docstring"""',
      '    # a note',
      '    return x  # trailing note',
    ))).toEqual([3, 4, 5]);
  });

  it('allows directives, the shebang and the coding line', async () => {
    expect(await flagged('a.py', src(
      '#!/usr/bin/env python3',
      '# -*- coding: utf-8 -*-',
      'import x  # noqa: F401',
      'y = z  # type: ignore[attr-defined]',
      'w = v  # pylint: disable=invalid-name',
      'if t:  # pragma: no cover',
      '    pass',
      'k = s  # nosemgrep',
    ))).toEqual([]);
  });

  it('ignores # inside strings, triple-quoted strings and f-strings', async () => {
    expect(await flagged('a.py', src(
      'a = "# not a comment"',
      "b = '''",
      '# still the string',
      "'''",
      'c = f"{a}#{b}"',
      'd = (',
      '    "implicit"',
      '    "concat"',
      ')',
    ))).toEqual([]);
  });
});

describe('shell', () => {
  it('flags notes, allows the shebang and shellcheck directives', async () => {
    expect(await flagged('a.sh', src(
      '#!/bin/bash',
      '# shellcheck disable=SC2086',
      '# install the deps',
      'echo "#not" \'#not\' ${#arr[@]} ${x#y} $#  # a note',
    ))).toEqual([3, 4]);
  });

  it('does not read a heredoc body as comments', async () => {
    expect(await flagged('a.sh', src('cat <<EOF > f.yml', '# a line of the file', 'EOF', 'cat <<-\'END\'', '\t# also text', '\tEND'))).toEqual([]);
  });
});

describe('Go', () => {
  it('allows doc comments on exported declarations and the package, and directives', async () => {
    expect(await flagged('a.go', src(
      '//go:build linux',
      '',
      '// Package a does things.',
      'package a',
      '',
      '//go:generate stringer -type=K',
      '// Run runs.',
      '// It spans lines.',
      'func Run() {}',
      '// K is a kind.',
      'type K int',
      '// M is a method.',
      'func (k K) M() {}',
      'var x = 1 //nolint:gochecknoglobals',
      'const (',
      '\t// Big is exported.',
      '\tBig = 1',
      ')',
    ))).toEqual([]);
  });

  it('flags a comment on an unexported declaration, one split by a blank line, and inline notes', async () => {
    expect(await flagged('a.go', src(
      'package a',
      '// helper helps.',
      'func helper() {}',
      '// Run runs.',
      '',
      'func Run() {',
      '\tx := "// not" + `/* raw */` // note',
      '}',
    ))).toEqual([2, 4, 7]);
  });
});

describe('Rust', () => {
  it('allows /// and //! doc comments and doc blocks; flags plain ones', async () => {
    expect(await flagged('a.rs', src(
      '//! The crate.',
      '#![allow(dead_code)]',
      '/// A function.',
      "fn f<'a>(s: &'a str) -> char { 'x' }",
      '/** Doc block. */',
      'struct S;',
      '// a note',
      'let u = "// no"; let r = r#"/* no */"#;',
      '/* outer /* nested */ still the comment */',
      'g();',
    ))).toEqual([7, 9]);
  });
});

describe('Java, Kotlin, C#, C/C++', () => {
  it('Java: allows /** */ on a declaration, flags the rest', async () => {
    expect(await flagged('A.java', src(
      '/** The class. */',
      'public class A {',
      '  /** A field. */',
      '  private int n = 1;',
      '  /** A method. */',
      '  @Override',
      '  public String toString() {',
      '    // explain',
      '    String s = "// no"; String t = """',
      '      /* text block */',
      '      """;',
      '    return s; /* note */',
      '  }',
      '}',
    ))).toEqual([8, 12]);
  });

  it('Kotlin: allows KDoc, ignores markers in templates', async () => {
    expect(await flagged('a.kt', src('/** Doc. */', 'fun f(x: Int) = "${x} // no"', '// note'))).toEqual([3]);
  });

  it('C#: allows /// XML docs on a declaration and verbatim strings', async () => {
    expect(await flagged('a.cs', src(
      '/// <summary>Doc.</summary>',
      'public class A {',
      '  /// <summary>M.</summary>',
      '  public void M() { var s = @"C:\\// not"; }',
      '  // note',
      '  // ReSharper disable once UnusedMember.Global',
      '  public int N;',
      '}',
    ))).toEqual([5]);
  });

  it('C/C++: allows Doxygen /** */ and /// on a declaration and lint directives; flags the rest', async () => {
    expect(await flagged('a.cpp', src(
      '/** Adds. */',
      'int add(int a, int b);',
      '/// A struct.',
      'struct S { int x; };',
      'int y = 1; // NOLINT',
      'const char *p = "/* no */"; char c = \'/\';',
      '// note',
      'auto r = R"(// raw)";',
    ))).toEqual([7]);
  });
});

describe('Ruby, YAML, SQL, CSS', () => {
  it('Ruby: allows magic comments and rubocop directives, flags notes and =begin blocks', async () => {
    expect(await flagged('a.rb', src(
      '# frozen_string_literal: true',
      'x = "#{y} # no" # rubocop:disable Style/Foo',
      '# a note',
      '=begin',
      'block',
      '=end',
      'z = 1',
    ))).toEqual([3, 4]);
  });

  it('YAML: flags # notes, allows tool directives, ignores # in values and block scalars', async () => {
    expect(await flagged('a.yml', src(
      '# yaml-language-server: $schema=https://x/schema.json',
      'name: it\'s a value#not-a-comment',
      'url: "http://x/#frag"',
      'run: |',
      '  # a shell line, not a YAML comment',
      '  echo hi',
      '# the deploy job',
      'key: v # trailing note',
      'description: an agent description # also flagged as a comment',
    ))).toEqual([7, 8, 9]);
  });

  it('YAML: a description value is data, never a comment', async () => {
    expect(await flagged('agent.yaml', src('name: reviewer', 'description: "Reviews code // carefully /* really */"'))).toEqual([]);
  });

  it('SQL: flags -- and /* */ notes, allows migration annotations and hints, ignores strings', async () => {
    expect(await flagged('a.sql', src(
      '-- +goose Up',
      '-- name: GetUser :one',
      "SELECT '-- no', $$ /* no */ $$, /*+ INDEX(t i) */ a FROM t; -- note",
      '/* a note */',
    ))).toEqual([3, 4]);
  });

  it('CSS/SCSS: flags notes, allows stylelint and license blocks, ignores url()', async () => {
    expect(await flagged('a.css', src('/*! normalize | MIT License */', 'a { color: red; } /* note */', '/* stylelint-disable-next-line */', 'b { background: url("//x/y.png"); }'))).toEqual([2]);
    expect(await flagged('a.scss', src('$x: 1;', '// note', 'a { background: url(http://x/y.png); }'))).toEqual([2]);
  });
});

describe('an agent tool registration', () => {
  it('reads a tool description as data, not as a comment', async () => {
    expect(await flagged('tools.ts', src(
      'server.registerTool("verify", {',
      '  description: "Advance a step. // Never a comment /* here */",',
      '}, handler);',
    ))).toEqual([]);
  });
});

describe('review findings (gpt-6.1-sol, round 1)', () => {
  it('JSDoc before an assignment or expression statement in a body is no docstring', async () => {
    expect(await flagged('a.ts', src('function f() {', '  /** now assign */', '  x = 1;', '  /** now evaluate */', '  foo;', '}'))).toEqual([2, 4]);
  });

  it('JSDoc separated from its declaration by a blank line is no docstring', async () => {
    expect(await flagged('a.ts', src('/** Adds. */', '', 'export function add() {}'))).toEqual([1]);
  });

  it('JSDoc on members of classes, object literals and type literals still passes', async () => {
    expect(await flagged('a.ts', src(
      'class K {',
      '  /** a field */',
      '  n = 1;',
      '}',
      'const o = {',
      '  /** shorthand */',
      '  a,',
      '};',
      'f({',
      '  /** an argument property */',
      '  b: 1,',
      '});',
    ))).toEqual([]);
  });

  it('shell: a here-string does not open a heredoc, and a numeric heredoc word is a heredoc', async () => {
    expect(await flagged('a.sh', src('cat <<<EOF', '# added narration', 'echo done'))).toEqual([2]);
    expect(await flagged('a.sh', src('cat <<123', '# body text', '123', '# after'))).toEqual([4]);
  });

  it('YAML: a block scalar in a sequence entry ends at its sibling keys', async () => {
    expect(await flagged('a.yml', src('- script: |', '    echo hi', '  name: test', '  # actual comment', '  value: 2'))).toEqual([4]);
    expect(await flagged('a.yml', src('- |', '  # text, not a comment', '- next'))).toEqual([]);
  });

  it('Python: a bytes or f-string literal after def is no docstring', async () => {
    expect(await flagged('a.py', src('def f():', '    b"""not a docstring"""', '    return 1', 'def g():', '    f"""narration {1}"""', '    return 2'))).toEqual([2, 5]);
  });

  it('Go: a trailing comment is never a doc comment', async () => {
    expect(await flagged('a.go', src('package a', 'var x = 1 // added narration', 'func Run() {}'))).toEqual([2]);
  });

  it('stays linear on files made of thousands of adjacent comments', async () => {
    const { flagComments } = await mod();
    const many = Array.from({ length: 20000 }, (_, i) => `// note ${i}`).join('\n') + '\nfunc Run() {}\n';
    for (const f of ['a.go', 'a.ts', 'a.cs']) {
      const t = Date.now();
      flagComments(f, f === 'a.go' ? `package a\n${many}` : many.replace('func Run() {}', 'export {};'));
      expect(Date.now() - t, f).toBeLessThan(4000);
    }
  });
});

describe('review findings (gpt-6.1-sol, round 2)', () => {
  const flagFn = async (file: string, content: string, removed: string) => (await mod()).flagComments(file, content, undefined, removed)!.map(c => c.line);

  it('an inline block comment kept on an edited line moved with it, it was not added', async () => {
    expect(await flagFn('a.ts', src('const x = /* old note */ 2;'), 'const x = /* old note */ 1;\n')).toEqual([]);
    expect(await flagFn('a.ts', src('const x = /* new note */ 2;'), 'const x = /* old note */ 1;\n')).toEqual([1]);
  });

  it('a removed line with thousands of markers is indexed in bounded time', async () => {
    const long = Array.from({ length: 20000 }, (_, i) => `a/${i}`).join(' ') + ' // tail\n';
    const t = Date.now();
    expect(await flagFn('a.ts', src('x(); // tail'), long)).toEqual([]);
    expect(Date.now() - t).toBeLessThan(4000);
  });

  it('shell: an arithmetic shift is no heredoc, and a quoted part of a heredoc word belongs to it', async () => {
    expect(await flagged('a.sh', src('echo $((1 << 2))', '# new narration'))).toEqual([2]);
    expect(await flagged('a.sh', src('cat <<E"OF"', '# body', 'EOF', '# after'))).toEqual([4]);
  });

  it('Go: a call is no declaration, while const groups, struct fields and interface methods are', async () => {
    expect(await flagged('a.go', src('package a', 'func f() {', '\t// now run it', '\tRun()', '}'))).toEqual([3]);
    expect(await flagged('a.go', src(
      'package a',
      'const (',
      '\t// Big is big.',
      '\tBig = 1',
      ')',
      '// Kinds of things.',
      'const (',
      '\tA = iota',
      ')',
      '// T is a type.',
      'type T struct {',
      '\t// Name names.',
      '\tName string',
      '}',
      '// I is an interface.',
      'type I interface {',
      '\t// Run runs.',
      '\tRun() error',
      '}',
    ))).toEqual([]);
  });

  it('JS: a labeled block and a case block are bodies, not members', async () => {
    expect(await flagged('a.ts', src('function f() {', '  outer: {', '    /** now assign */', '    x = 1;', '  }', '  switch (y) {', '    case 1: {', '      /** again */', '      x = 2;', '    }', '  }', '}'))).toEqual([3, 8]);
  });

  it('JS: object properties holding objects, and type annotations, still open members', async () => {
    expect(await flagged('a.ts', src(
      'const o = {',
      '  inner: {',
      '    /** a nested property */',
      '    a: 1,',
      '  },',
      '};',
      'let t: {',
      '  /** a typed member */',
      '  b: number;',
      '};',
    ))).toEqual([]);
  });

  it('YAML: a comment less indented than the scalar content is a comment', async () => {
    expect(await flagged('a.yml', src('run: |4', '    echo hi', '  # actual YAML comment', 'next: value'))).toEqual([3]);
    expect(await flagged('a.yml', src('run: |', '    echo hi', '  # actual YAML comment', 'next: value'))).toEqual([3]);
  });

  it('Python: a parenthesized or concatenated string statement is judged like any other', async () => {
    expect(await flagged('a.py', src('def f():', '    (f"""narration {1}""")', '    pass'))).toEqual([2]);
    expect(await flagged('a.py', src('def f():', '    x = 1', '    ("""a note""")', '    "a" "b"', '    return x'))).toEqual([3, 4]);
    expect(await flagged('a.py', src('def f():', '    ("""A parenthesized docstring."""', '     """ still it.""")', '    return 1'))).toEqual([]);
  });
});

describe('review findings (gpt-6.1-sol, round 3)', () => {
  it('YAML: JSON-style flow mappings keep # inside quoted values', async () => {
    expect(await flagged('a.yml', src('{"message":"some # data"}', 'a: {"k":"v # no"} # note'))).toEqual([2]);
  });

  it('Python: a one-line suite is a statement start, judged like any other', async () => {
    expect(await flagged('a.py', src('def f(): b"not a docstring"', 'def g(): f"narration {1}"', 'def h(): "Doc."', 'k = lambda x: "a"', 'if x: "a note"'))).toEqual([1, 2, 5]);
  });

  it('shell: an empty quoted heredoc word ends at an empty line', async () => {
    expect(await flagged('a.sh', src("cat <<''", '# body text', '', '# real comment'))).toEqual([4]);
  });

  it('stays linear on a single long line holding thousands of comments and braces', async () => {
    const { flagComments } = await mod();
    const pure = Array.from({ length: 60000 }, (_, i) => `/*#__PURE__*/ f${i}({a:{b:1}}),`).join(' ');
    const members = 'class K { ' + Array.from({ length: 60000 }, (_, i) => `/** d${i} */ a${i} = {x: 0};`).join(' ') + ' }';
    for (const [name, text] of [['pure', `export const xs = [${pure}];`], ['members', members]]) {
      const t = Date.now();
      flagComments('a.js', text + '\n');
      expect(Date.now() - t, name).toBeLessThan(4000);
    }
  });
});

describe('review findings (gpt-6.1-sol, round 4)', () => {
  it('a comment added beside an existing license header is judged on its own', async () => {
    expect(await flagged('a.ts', src('// Copyright 2026 ACME', '// TODO: remove legacy shim', '// Licensed under MIT too', 'run();'), [2, 3])).toEqual([2]);
  });

  it('a multi-line comment whose first line shares an edited line, the rest unchanged, is not added', async () => {
    const r = (await mod()).flagComments('a.ts', src('const x = 2; /* existing explanation', ' * continued explanation', ' */'), new Set([1]), 'const x = 1; /* existing explanation\n');
    expect(r).toEqual([]);
  });

  it('C++: a doc block on a constructor or destructor inside a class passes; one before a call fails', async () => {
    expect(await flagged('a.hpp', src('class Widget {', ' public:', '  /** Creates a widget. */', '  Widget();', '  /** Destroys it. */', '  ~Widget();', '};', 'void f() {', '  /** now make one */', '  make();', '}'))).toEqual([9]);
  });

  it("SQL: a PostgreSQL E'' string keeps its escaped quote and markers", async () => {
    expect(await flagged('a.sql', src("SELECT E'it\\'s -- text';", "SELECT e'a\\'b' -- note;"))).toEqual([2]);
  });
});

describe('review findings (gpt-6.1-sol, round 5)', () => {
  it('a TODO that mentions a license is no license header', async () => {
    expect(await flagged('a.ts', src('// TODO: validate the license before saving', 'run();'))).toEqual([1]);
    expect(await flagged('a.ts', src('// Licensed under the Apache License, Version 2.0', '// Use of this source code is governed by a BSD-style license.', 'run();'))).toEqual([]);
  });

  it('a multi-line comment whose closing line shares an edited line is not added', async () => {
    const r = (await mod()).flagComments('a.ts', src('const x = /* existing', 'explanation */ 2;'), new Set([2]), 'explanation */ 1;\n');
    expect(r).toEqual([]);
  });

  it('C++: a doc block on an out-of-line constructor or destructor passes', async () => {
    expect(await flagged('a.cpp', src('/** Construct widget. */', 'Widget::Widget() {}', '/** Destroy it. */', 'Widget::~Widget() {}', 'void f() {', '  /** now sort */', '  std::sort(a, b);', '}'))).toEqual([6]);
  });
});

describe('cases the mutation run showed unguarded', () => {
  it('Go: a comment above a local var inside a function body is no doc comment', async () => {
    expect(await flagged('a.go', src('package a', 'func f() {', '\t// count them', '\tvar X = 1', '\t_ = X', '}'))).toEqual([3]);
  });

  it('YAML: an empty block scalar in a sequence entry ends at the next sibling line', async () => {
    expect(await flagged('a.yml', src('- script: |', '  # actual comment', '  name: x'))).toEqual([2]);
  });

  it('a TODO naming a copyright is still a TODO', async () => {
    expect(await flagged('a.ts', src('// TODO: update the copyright year', 'run();'))).toEqual([1]);
  });

  it('narration added beside an existing license header is flagged', async () => {
    expect(await flagged('a.ts', src('// Copyright 2026 ACME', '// This module wires the CLI.', 'run();'), [2])).toEqual([2]);
  });

  it('every line of a new license header passes, words or not', async () => {
    expect(await flagged('a.ts', src('// Copyright 2026 ACME', '// All rights reserved.', '// Do not distribute.', 'run();'))).toEqual([]);
  });
});

describe('JS module docstrings', () => {
  it('allows a JSDoc block tagged @file, @fileoverview, @module or @packageDocumentation before any code', async () => {
    for (const tag of ['@file', '@fileoverview', '@module m', '@packageDocumentation']) {
      expect(await flagged('a.ts', src('/**', ` * ${tag} What this module is for.`, ' */', "import x from 'x';")), tag).toEqual([]);
    }
  });

  it('flags an untagged header block, and a tagged one below code', async () => {
    expect(await flagged('a.ts', src('/** What this module is for. */', "import x from 'x';"))).toEqual([1]);
    expect(await flagged('a.ts', src("import x from 'x';", '/** @file late */', 'run();'))).toEqual([2]);
  });
});

