/**
 * @file GH-392 — which comments a step's added lines may carry.
 *
 * A per-language scanner finds the comments of a file (comment markers inside
 * string literals are not comments) and classifies each as functional - a tool
 * directive, a shebang, a license header, a docstring on the declaration it
 * documents - or not. The no-nonfunctional-comments check fails a step on the
 * second kind, in the lines the step added.
 */
import * as path from 'path';

export type CommentLang = 'js' | 'python' | 'shell' | 'go' | 'rust' | 'java' | 'kotlin' | 'csharp' | 'c' | 'ruby' | 'yaml' | 'sql' | 'css' | 'scss';

/** One comment the check refuses: its first line and its text. */
export interface FlaggedComment { line: number; text: string }

/** What the scanner cannot tell, in words the check shows with a failure. */
export const SCANNER_LIMITS = 'Comments are told from code by a per-language scanner, not a parser, so a few can be misread as comments: a comment marker inside a JS regex literal that follows a closing parenthesis, a quote nested inside an interpolation of a Python f-string, a C# interpolated string or a shell $(...) inside double quotes, a Ruby heredoc body, and JSX text holding //; and a JSDoc block inside a JS labeled block whose { starts the next line can pass as a member docstring. A person can pass a misread on the board.';

const BY_EXT: Record<string, CommentLang> = {
  '.js': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.mjs': 'js', '.cjs': 'js', '.mts': 'js', '.cts': 'js',
  '.py': 'python', '.pyi': 'python', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ksh': 'shell', '.bats': 'shell',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.cxx': 'c', '.hpp': 'c', '.hh': 'c', '.hxx': 'c', '.m': 'c', '.mm': 'c',
  '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby', '.yml': 'yaml', '.yaml': 'yaml', '.sql': 'sql',
  '.css': 'css', '.scss': 'scss', '.less': 'scss',
};
const BY_NAME: Record<string, CommentLang> = { Gemfile: 'ruby', Rakefile: 'ruby', Guardfile: 'ruby', Vagrantfile: 'ruby', Podfile: 'ruby' };

/** The language a file is read as, from its name, else an extensionless script's shebang; null when there are no rules for it. */
export function languageOf(file: string, firstLine?: string): CommentLang | null {
  const base = path.basename(file);
  if (Object.prototype.hasOwnProperty.call(BY_NAME, base)) return BY_NAME[base];
  const ext = path.extname(base).toLowerCase();
  if (ext) return Object.prototype.hasOwnProperty.call(BY_EXT, ext) ? BY_EXT[ext] : null;
  const m = firstLine?.startsWith('#!') ? /\b(bash|sh|zsh|ksh|dash|python[\d.]*|node|deno|ruby)\b/.exec(firstLine) : null;
  if (!m) return null;
  return m[1].startsWith('python') ? 'python' : m[1] === 'node' || m[1] === 'deno' ? 'js' : m[1] === 'ruby' ? 'ruby' : 'shell';
}

interface Found {
  start: number;
  end: number;
  /** A Python string statement, which is a docstring or a comment by where it stands. */
  stringStatement?: { docstring: boolean };
}

const WS = /\s/;
const WORD = /[\w$]/;
const lineEnd = (src: string, i: number) => { const e = src.indexOf('\n', i); return e < 0 ? src.length : e; };

/** The end of a quoted literal opened at `i` (the quote is `q`, `open` long). */
function quoted(src: string, i: number, q: string, o: { open?: number; escape?: boolean; multiline?: boolean; doubled?: boolean; interp?: string; scan?: (j: number) => number } = {}): number {
  let j = i + (o.open ?? q.length);
  while (j < src.length) {
    if (o.escape !== false && src[j] === '\\') { j += 2; continue; }
    if (o.interp && src.startsWith(o.interp, j) && o.scan) { j = o.scan(j + o.interp.length); continue; }
    if (src.startsWith(q, j)) {
      if (o.doubled && src.startsWith(q + q, j)) { j += 2 * q.length; continue; }
      return j + q.length;
    }
    if (src[j] === '\n' && !o.multiline) return j;
    j++;
  }
  return src.length;
}

const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof', 'when', 'unless', 'if', 'and', 'or', 'not']);

interface LangSpec {
  line: string[];
  block?: [string, string];
  nest?: boolean;
  rubyBegin?: boolean;
  literal: (src: string, i: number, st: { lastSig: string; lastWord: string; scan: (j: number) => number }) => number;
}

/** A regex literal at `i` when the token before allows one, else -1. */
function regexAt(src: string, i: number, st: { lastSig: string; lastWord: string }): number {
  const allowed = st.lastSig === '' || REGEX_AFTER.has(st.lastSig) || (st.lastSig === 'a' && REGEX_KEYWORDS.has(st.lastWord));
  if (!allowed) return -1;
  let j = i + 1, cls = false;
  while (j < src.length && src[j] !== '\n') {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') cls = true;
    else if (c === ']') cls = false;
    else if (c === '/' && !cls) { j++; while (j < src.length && /[a-z]/i.test(src[j])) j++; return j; }
    j++;
  }
  return -1;
}

const C_LIKE = { line: ['//'], block: ['/*', '*/'] as [string, string] };
const SPECS: Record<Exclude<CommentLang, 'python' | 'shell' | 'yaml'>, LangSpec> = {
  js: { ...C_LIKE, literal: (src, i, st) => {
    const c = src[i];
    if (c === '"' || c === "'") return quoted(src, i, c);
    if (c === '`') return quoted(src, i, '`', { multiline: true, interp: '${', scan: st.scan });
    if (c === '/') return regexAt(src, i, st);
    return -1;
  } },
  go: { ...C_LIKE, literal: (src, i) => {
    const c = src[i];
    if (c === '"' || c === "'") return quoted(src, i, c);
    if (c === '`') return quoted(src, i, '`', { escape: false, multiline: true });
    return -1;
  } },
  rust: { ...C_LIKE, nest: true, literal: (src, i) => {
    const raw = /^b?r(#*)"/.exec(src.slice(i, i + 40));
    if (raw) { const close = '"' + raw[1]; const e = src.indexOf(close, i + raw[0].length); return e < 0 ? src.length : e + close.length; }
    if (src.startsWith('b"', i)) return quoted(src, i + 1, '"', { multiline: true });
    if (src[i] === '"') return quoted(src, i, '"', { multiline: true });
    if (src[i] === "'") {
      if (src[i + 1] === '\\') return quoted(src, i, "'");
      if (src[i + 2] === "'") return i + 3;
      return i + 1;
    }
    return -1;
  } },
  java: { ...C_LIKE, literal: (src, i) => {
    if (src.startsWith('"""', i)) return quoted(src, i, '"""', { multiline: true });
    return src[i] === '"' || src[i] === "'" ? quoted(src, i, src[i]) : -1;
  } },
  kotlin: { ...C_LIKE, nest: true, literal: (src, i, st) => {
    if (src.startsWith('"""', i)) return quoted(src, i, '"""', { escape: false, multiline: true, interp: '${', scan: st.scan });
    if (src[i] === '"') return quoted(src, i, '"', { interp: '${', scan: st.scan });
    return src[i] === "'" ? quoted(src, i, "'") : -1;
  } },
  csharp: { ...C_LIKE, literal: (src, i) => {
    const raw = /^\$*("{3,})/.exec(src.slice(i, i + 20));
    if (raw) { const e = src.indexOf(raw[1], i + raw[0].length); return e < 0 ? src.length : e + raw[1].length; }
    const verb = /^(?:\$@|@\$|@)"/.exec(src.slice(i, i + 3));
    if (verb) return quoted(src, i, '"', { open: verb[0].length, escape: false, multiline: true, doubled: true });
    if (src.startsWith('$"', i)) return quoted(src, i, '"', { open: 2 });
    return src[i] === '"' || src[i] === "'" ? quoted(src, i, src[i]) : -1;
  } },
  c: { ...C_LIKE, literal: (src, i) => {
    const raw = /^(?:u8|u|U|L)?R"([^()\\\s]{0,16})\(/.exec(src.slice(i, i + 24));
    if (raw) { const close = `)${raw[1]}"`; const e = src.indexOf(close, i + raw[0].length); return e < 0 ? src.length : e + close.length; }
    const pre = /^(?:u8|u|U|L)?(["'])/.exec(src.slice(i, i + 3));
    return pre ? quoted(src, i, pre[1], { open: pre[0].length }) : -1;
  } },
  ruby: { line: ['#'], rubyBegin: true, literal: (src, i, st) => {
    const c = src[i];
    if (c === "'") return quoted(src, i, "'", { multiline: true });
    if (c === '"' || c === '`') return quoted(src, i, c, { multiline: true, interp: '#{', scan: st.scan });
    if (c === '/') return regexAt(src, i, st);
    const pct = /^%[qQwWiIr]?([(\[{<|!/])/.exec(src.slice(i, i + 4));
    if (pct && (st.lastSig === '' || REGEX_AFTER.has(st.lastSig))) {
      const open = pct[1], close = ({ '(': ')', '[': ']', '{': '}', '<': '>' } as Record<string, string>)[open] ?? open;
      let j = i + pct[0].length, depth = 0;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === open && close !== open) depth++;
        else if (src[j] === close) { if (depth === 0) return j + 1; depth--; }
        j++;
      }
      return src.length;
    }
    return -1;
  } },
  sql: { line: ['--'], block: ['/*', '*/'], literal: (src, i) => {
    if (/^[eE]'/.test(src.slice(i, i + 2))) return quoted(src, i, "'", { open: 2, multiline: true, doubled: true });
    const c = src[i];
    if (c === "'" || c === '"') return quoted(src, i, c, { escape: false, multiline: true, doubled: true });
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i, i + 64));
    if (dollar) { const e = src.indexOf(dollar[0], i + dollar[0].length); return e < 0 ? src.length : e + dollar[0].length; }
    return -1;
  } },
  css: { line: [], block: ['/*', '*/'], literal: (src, i) => (src[i] === '"' || src[i] === "'" ? quoted(src, i, src[i]) : -1) },
  scss: { ...C_LIKE, literal: (src, i) => {
    if (src[i] === '"' || src[i] === "'") return quoted(src, i, src[i]);
    if (/^url\(\s*[^\s'")]/i.test(src.slice(i, i + 6))) { const e = src.indexOf(')', i); return e < 0 ? lineEnd(src, i) : e + 1; }
    return -1;
  } },
};

/** A brace or parenthesis in code, outside literals and comments. */
interface Brace { pos: number; ch: '{' | '}' | '(' | ')' }

/** The comments of a C-family, Ruby, SQL or CSS source; the braces of its code go to `braces`. */
function scanGeneric(src: string, spec: LangSpec, from: number, braces: Brace[] = []): Found[] {
  const out: Found[] = [];
  const st = { lastSig: '', lastWord: '', scan: (j: number) => scan(j, true) };
  const blockEnd = (i: number): number => {
    const [o, c] = spec.block!;
    let j = i + o.length, depth = 0;
    while (j < src.length) {
      if (spec.nest && src.startsWith(o, j)) { depth++; j += o.length; continue; }
      if (src.startsWith(c, j)) { if (depth === 0) return j + c.length; depth--; j += c.length; continue; }
      j++;
    }
    return src.length;
  };
  function scan(i: number, toBrace: boolean): number {
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (toBrace) {
        if (ch === '{') depth++;
        else if (ch === '}') { if (depth === 0) return i + 1; depth--; }
      }
      if (ch === '{' || ch === '}' || ch === '(' || ch === ')') braces.push({ pos: i, ch });
      if (spec.rubyBegin && (i === 0 || src[i - 1] === '\n') && src.startsWith('=begin', i)) {
        const e = src.indexOf('\n=end', i);
        const end = e < 0 ? src.length : lineEnd(src, e + 1);
        out.push({ start: i, end });
        i = end;
        continue;
      }
      if (spec.block && src.startsWith(spec.block[0], i)) { const end = blockEnd(i); out.push({ start: i, end }); i = end; continue; }
      if (spec.line.some(m => src.startsWith(m, i))) { const end = lineEnd(src, i); out.push({ start: i, end }); i = end; continue; }
      const lit = spec.literal(src, i, st);
      if (lit > i) { i = lit; st.lastSig = 'a'; st.lastWord = ''; continue; }
      if (WORD.test(ch)) {
        let j = i;
        while (j < src.length && WORD.test(src[j])) j++;
        st.lastSig = 'a';
        st.lastWord = src.slice(i, j);
        i = j;
        continue;
      }
      if (!WS.test(ch)) { st.lastSig = ch; st.lastWord = ''; }
      i++;
    }
    return src.length;
  }
  scan(from, false);
  return out;
}

/** Python statements whose header ends in `:` and may carry their suite on the same line. */
const COMPOUND = new Set(['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally', 'match', 'case']);

/** The comments and string statements of a Python source. */
function scanPython(src: string, from: number): Found[] {
  const out: Found[] = [];
  let i = from, depth = 0, atStart = true, continued = false;
  let first = '', lastSig = '';
  let prev: { first: string; colon: boolean } | null = null;
  const endStatement = () => { if (first) prev = { first, colon: lastSig === ':' }; first = ''; lastSig = ''; atStart = true; };
  const stringAt = (j: number): { end: number; constant: boolean } | null => {
    const m = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(src.slice(j, j + 5));
    if (!m) return null;
    const q = m[2];
    return { end: quoted(src, j, q, { open: m[0].length, multiline: q.length === 3 }), constant: !/[bBfF]/.test(m[1]) };
  };
  /** A statement that is only string literals - concatenated, parenthesized or both - starting at `j`: its end, and whether every part is a constant. */
  const stringStatementAt = (j: number): { end: number; constant: boolean } | null => {
    let opens = 0, parts = 0, constant = true;
    const skip = (newlines: boolean) => { while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r' || (newlines && src[j] === '\n'))) j++; };
    while (src[j] === '(') { opens++; j++; skip(true); }
    for (;;) {
      const lit = stringAt(j);
      if (!lit) break;
      parts++;
      constant &&= lit.constant;
      j = lit.end;
      skip(opens > 0);
    }
    if (!parts) return null;
    while (opens > 0) { skip(true); if (src[j] !== ')') return null; opens--; j++; }
    skip(false);
    return j >= src.length || src[j] === '\n' || src[j] === '#' || src[j] === ';' ? { end: j, constant } : null;
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') {
      if (depth === 0 && !continued) endStatement();
      continued = false;
      i++;
      continue;
    }
    if (ch === '\\' && src[i + 1] === '\n') { continued = true; i += 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '#') { const end = lineEnd(src, i); out.push({ start: i, end }); i = end; continue; }
    const stmt = atStart && depth === 0 ? stringStatementAt(i) : null;
    if (stmt) {
      const p = prev as { first: string; colon: boolean } | null;
      out.push({ start: i, end: stmt.end, stringStatement: { docstring: stmt.constant && (p === null || (p.colon && (p.first === 'def' || p.first === 'class'))) } });
      first = '"';
      atStart = false;
      lastSig = '"';
      i = stmt.end;
      continue;
    }
    const lit = stringAt(i);
    if (lit) {
      const s = lit.end;
      if (atStart) first = first || '"';
      atStart = false;
      lastSig = '"';
      i = s;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /\w/.test(src[j])) j++;
      const w = src.slice(i, j);
      if (atStart) {
        first = w;
        if (w === 'async') { const n = /^\s+(\w+)/.exec(src.slice(j, j + 20)); if (n) first = n[1]; }
      }
      atStart = false;
      lastSig = 'a';
      i = j;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) { endStatement(); i++; continue; }
    if (ch === ':' && depth === 0 && COMPOUND.has(first)) { prev = { first, colon: true }; first = ''; lastSig = ''; atStart = true; i++; continue; }
    if (atStart) first = first || ch;
    atStart = false;
    lastSig = ch;
    i++;
  }
  return out;
}

/** The comments of a shell script: # at a word start, outside quotes and heredoc bodies. */
function scanShell(src: string, from: number): Found[] {
  const out: Found[] = [];
  const pending: Array<{ word: string; tabs: boolean }> = [];
  let i = from, arith = 0;
  /** The heredoc word at `j` with its quotes removed, and where it ends. */
  const wordAt = (j: number): { word: string; end: number } | null => {
    let word = '', quotedWord = false;
    while (j < src.length && !/[\s;&|<>()]/.test(src[j])) {
      const c = src[j];
      if (c === "'" || c === '"') { const e = src.indexOf(c, j + 1); if (e < 0) return null; word += src.slice(j + 1, e); quotedWord = true; j = e + 1; continue; }
      if (c === '\\') { word += src[j + 1] ?? ''; j += 2; continue; }
      word += c;
      j++;
    }
    return word || quotedWord ? { word, end: j } : null;
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '(' && src[i + 1] === '(') { arith++; i += 2; continue; }
    if (ch === ')' && src[i + 1] === ')' && arith > 0) { arith--; i += 2; continue; }
    if (ch === '\n') {
      i++;
      while (pending.length) {
        const h = pending.shift()!;
        while (i < src.length) {
          const e = lineEnd(src, i);
          const line = src.slice(i, e).replace(/\r$/, '');
          i = e + 1;
          if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.word) break;
        }
      }
      continue;
    }
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'") { i = quoted(src, i, "'", { escape: false, multiline: true }); continue; }
    if (ch === '$' && src[i + 1] === "'") { i = quoted(src, i, "'", { open: 2, multiline: true }); continue; }
    if (ch === '"' || ch === '`') { i = quoted(src, i, ch, { multiline: true }); continue; }
    if (ch === '<' && src[i + 1] === '<') {
      if (src[i + 2] === '<' || arith > 0) { i += src[i + 2] === '<' ? 3 : 2; continue; }
      const tabs = src[i + 2] === '-';
      let j = i + (tabs ? 3 : 2);
      while (src[j] === ' ' || src[j] === '\t') j++;
      const w = wordAt(j);
      if (w) { pending.push({ word: w.word, tabs }); i = w.end; continue; }
    }
    if (ch === '#' && (i === 0 || /[\s;&|]/.test(src[i - 1]))) { const end = lineEnd(src, i); out.push({ start: i, end }); i = end; continue; }
    i++;
  }
  return out;
}

/** The comments of a YAML file: # after whitespace, outside quoted scalars and block scalars. */
function scanYaml(src: string, from: number): Found[] {
  const out: Found[] = [];
  let block: { parent: number; content: number | null } | null = null;
  let flow = 0;
  let quote: string | null = null;
  let i = from;
  while (i < src.length) {
    const e = lineEnd(src, i);
    const line = src.slice(i, e);
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (block !== null && !quote) {
      if (!line.trim()) { i = e + 1; continue; }
      if (block.content === null && indent > block.parent) block.content = indent;
      if (block.content !== null && indent >= block.content) { i = e + 1; continue; }
      block = null;
    }
    let scalarStart = !quote, comment: number | null = null;
    const flowAtStart = flow;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (quote) {
        if (quote === '"' && c === '\\') { j++; continue; }
        if (c === quote) { if (quote === "'" && line[j + 1] === "'") { j++; continue; } quote = null; }
        continue;
      }
      if (c === '#' && (j === 0 || line[j - 1] === ' ' || line[j - 1] === '\t')) { comment = j; break; }
      if (c === ' ' || c === '\t') continue;
      if (scalarStart && (c === '"' || c === "'")) { quote = c; continue; }
      if (c === '[' || c === '{') flow++;
      else if ((c === ']' || c === '}') && flow > 0) flow--;
      scalarStart = c === '[' || c === '{' || c === ',' || (c === ':' && flow > 0) || ((c === '-' || c === ':' || c === '?') && (j + 1 >= line.length || line[j + 1] === ' '));
    }
    if (comment !== null) out.push({ start: i + comment, end: e });
    const code = line.slice(0, comment ?? line.length).trimEnd();
    const header = quote ? null : /(?:^\s*|:\s+|-\s+)[|>][-+]?(\d?)[-+]?$/.exec(code);
    if (header) {
      const lead = /^[ \t]*((?:-[ \t]+)*)/.exec(code)!;
      const parent = /^[|>]/.test(code.slice(lead[0].length)) ? Math.max(indent, lead[0].length - 2) : lead[0].length;
      block = { parent, content: header[1] ? parent + Number(header[1]) : null };
    }
    i = e + 1;
  }
  return out;
}

const DIRECTIVES: RegExp[] = [
  /^eslint(?:-disable|-enable|-env)?\b/, /^globals?\s/, /^jshint\b/, /^jscs:/, /^@ts-(?:expect-error|ignore|nocheck|check)\b/,
  /^(?:istanbul|c8|v8)\s+ignore\b/, /^nosemgrep\b/, /^prettier-ignore\b/, /^biome-ignore\b/, /^deno-(?:lint|fmt)-ignore/,
  /^@(?:vitest|jest)-environment\b/, /^@(?:jsx|jsxImportSource|jsxRuntime|jsxFrag|flow|license|preserve|vite-ignore|refresh)\b/,
  /^[@#]__(?:PURE|NO_SIDE_EFFECTS|INLINE)__/, /^webpack[A-Z]\w*\s*:/, /^[@#]\s*source(?:Mapping)?URL=/, /^<(?:reference|amd-module|amd-dependency)\b/,
  /^type:/, /^noqa\b/i, /^pragma\b/, /^pylint:/, /^mypy:/, /^pyright:/, /^fmt:\s*(?:off|on|skip)\b/, /^isort:/, /^nosec\b/, /^ruff:/,
  /^shellcheck\s/, /^rubocop:/, /^frozen_string_literal:/, /^(?:en)?coding[:=]/, /^-\*-.*-\*-$/, /^vim?:\s/, /^(?:yaml-language-server|yamllint)\b/, /^\$schema\b/,
  /^go:\w+/, /^\+build\b/, /^line\s+\S+:\d+/, /^nolint\b/, /^lint:(?:ignore|file-ignore)\b/, /^export\s+\w+$/,
  /^NOLINT/, /^clang-format\s+(?:off|on)\b/, /^IWYU\s+pragma\b/, /^cppcheck-suppress\b/, /^LCOV_EXCL/, /^NOSONAR\b/, /^noinspection\b/,
  /^ReSharper\s+(?:disable|restore|enable)\b/, /^@formatter:(?:off|on)\b/, /^CHECKSTYLE:/, /^language=/, /^stylelint-/, /^purgecss\s/, /^autoprefixer:/,
  /^sqlfluff:/, /^\+(?:goose|migrate)\b/, /^migrate:\w/, /^name:\s*\w+\s+:\w+/, /^liquibase\b/, /^changeset\s/,
  /^checkov:skip/, /^tfsec:ignore/, /^trivy:ignore/, /^gitleaks:allow\b/, /^pragma:\s*allowlist/, /^codeql\b/, /^lgtm\b/, /^cspell:/, /^spell-?checker:/,
  /^kics-scan\b/, /^hadolint\b/, /^@generated\b/, /^Code generated .* DO NOT EDIT\.$/,
];
const LICENSE = /copyright|SPDX-License-Identifier|©|\(c\)\s*\d{4}|\blicensed under\b|\bgoverned by\b.*\blicen[cs]e\b|\b(?:MIT|BSD|Apache|GPL|LGPL|AGPL|MPL|ISC|EPL)\b.{0,30}\blicen[cs]e\b|\blicen[cs]e\b.{0,30}\b(?:MIT|BSD|Apache|GPL|LGPL|AGPL|MPL|ISC|EPL)\b/i;
/** Work markers a license header never carries. */
const WORK_MARKER = /\b(?:TODO|FIXME|XXX|HACK)\b/;

/** A comment's words, without its markers. */
function bodyOf(raw: string): string {
  let t = raw.trim();
  if (t.startsWith('/*')) t = t.replace(/^\/\*+!?/, '').replace(/\*+\/$/, '').split('\n').map(l => l.replace(/^\s*\*+(?!\/)\s?/, '')).join('\n');
  else if (t.startsWith('=begin')) t = t.replace(/^=begin/, '').replace(/=end\s*$/, '');
  else t = t.replace(/^(?:\/\/+[!/]?|#+|--)/, '');
  return t.trim();
}

const JS_CONTROL = /^(?:return|if|else|for|while|do|switch|case|break|continue|throw|try|catch|finally|await|yield|delete|new|super|this|import|typeof|void)\b/;
const JS_MODIFIERS = /^(?:(?:export|default|declare|async|abstract|public|private|protected|static|readonly|override|accessor|get|set)\s+)*/;
/**
 * Is this line of JS/TS a declaration a JSDoc block can document? A member
 * (`name: ...`, `name = ...`, `name(...) {`) counts only inside a class,
 * interface, object or type literal, where it is one; in a body it is a statement.
 */
function jsDeclaration(line: string, inMembers: boolean): boolean {
  if (!line) return false;
  if (line.startsWith('@') || /^export\b/.test(line)) return true;
  if (JS_CONTROL.test(line)) return false;
  const rest = line.replace(JS_MODIFIERS, '');
  if (/^(?:function\b|class\b|interface\b|type\b|enum\b|const\b|let\b|var\b|namespace\b|module\b|constructor\b|abstract\b)/.test(rest)) return true;
  if (!inMembers) return false;
  const m = /^\*?\s*(?:#?[A-Za-z_$][\w$]*|'[^']*'|"[^"]*"|\[[^\]]+\])\s*[?!]?\s*/.exec(rest);
  if (!m) return false;
  const after = rest.slice(m[0].length);
  if (after === '' || /^[:=,;<]/.test(after)) return true;
  return after.startsWith('(') && /\)\s*(?:[:{]|=>)|[{(,]\s*$/.test(after);
}

const C_CONTROL = /^(?:return|if|else|for|foreach|while|do|switch|case|default\s*:|break|continue|throw|try|catch|finally|goto|yield|await|lock|delete|new|when)\b/;
const C_KEYWORDS = /^(?:public|private|protected|internal|static|final|abstract|sealed|open|override|virtual|class|interface|enum|record|struct|union|typedef|namespace|template|fun|val|var|object|data|suspend|inline|extern|const|constexpr|delegate|event|partial|readonly|unsafe|lateinit|companion|annotation|actual|expect|typealias|explicit|friend|operator|volatile|mutable|signed|unsigned|void|auto)\b/;
const C_TYPED = /^(?:[A-Za-z_][\w:.<>,?[\]]*[\s*&]+)+[*&]*[A-Za-z_~]\w*\s*[(=;{,[:]/;
/** Is this line of Java, Kotlin, C# or C/C++ a declaration a doc comment can document? */
function cDeclaration(line: string, inMembers: boolean): boolean {
  if (!line || C_CONTROL.test(line)) return false;
  if (inMembers && /^~?[A-Za-z_]\w*\s*\(/.test(line)) return true;
  if (/^([A-Za-z_]\w*)(?:<[^>]*>)?::~?\1\s*\(/.test(line)) return true;
  return line.startsWith('@') || line.startsWith('[') || /^#\s*define\b/.test(line) || C_KEYWORDS.test(line) || C_TYPED.test(line);
}

const GO_DECLARATION = /^(?:package\s+\w|func\s+(?:\([^)]*\)\s*)?[A-Z]|(?:type|var|const)\s+[A-Z]|(?:type|var|const)\s*\()/;
/** An exported name inside a const/var/type group, a struct or an interface. */
const GO_MEMBER = /^[A-Z]\w*(?:[\s,=(]|$)/;

/** How much of the code after a comment its classification reads. */
const CODE_AFTER_MAX = 400;

/** Comments, in order, with the analysis a classification needs, each computed once. */
class Analysed {
  readonly lineStarts: number[] = [0];
  readonly firstCode: number;
  /** Per comment: the first and last comment of its group (neighbours with no blank line between). */
  private readonly groupLo: number[] = [];
  private readonly groupHi: number[] = [];
  private readonly licensed = new Map<number, boolean>();
  /** Per comment: the code after it, past other comments, and whether a blank line stands between. */
  private after: Array<{ text: string; blank: boolean }> | null = null;
  /** Per comment: what the innermost bracket around it opens. */
  private context: Context[] | null = null;

  constructor(readonly src: string, readonly found: Found[], from: number, private readonly braces: Brace[] = []) {
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') this.lineStarts.push(i + 1);
    const byStart = new Map<number, Found>();
    for (const f of found) if (!f.stringStatement) byStart.set(f.start, f);
    let pos = from;
    for (;;) {
      while (pos < src.length && WS.test(src[pos])) pos++;
      const c = byStart.get(pos);
      if (!c) break;
      pos = c.end;
    }
    this.firstCode = pos;
    const touching = (a: Found, b: Found) => { const gap = src.slice(a.end, b.start); return !gap.trim() && (gap.match(/\n/g) ?? []).length <= 1; };
    for (let k = 0; k < found.length; k++) this.groupLo[k] = k > 0 && touching(found[k - 1], found[k]) ? this.groupLo[k - 1] : k;
    for (let k = found.length - 1; k >= 0; k--) this.groupHi[k] = k < found.length - 1 && touching(found[k], found[k + 1]) ? this.groupHi[k + 1] : k;
  }

  lineOf(offset: number): number {
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }

  /** The offset of the newline ending the line `offset` is on (or the end of the source). */
  endOfLine(offset: number): number {
    const next = this.lineStarts[this.lineOf(offset)];
    return next === undefined ? this.src.length : next - 1;
  }

  /** Does comment `k` stand alone on its line, with no code before it? */
  standalone(k: number): boolean {
    let i = this.found[k].start - 1;
    while (i >= 0 && this.src[i] !== '\n' && WS.test(this.src[i])) i--;
    return i < 0 || this.src[i] === '\n';
  }

  /** The code after comment `k`, past whitespace and other comments: the rest of its line. Null when a blank line intervenes and `strict`. */
  codeAfter(k: number, strict: boolean): string | null {
    if (!this.after) {
      const after: Array<{ text: string; blank: boolean }> = [];
      for (let j = this.found.length - 1; j >= 0; j--) {
        let pos = this.found[j].end, newlines = 0;
        while (pos < this.src.length && WS.test(this.src[pos])) { if (this.src[pos] === '\n') newlines++; pos++; }
        const next = this.found[j + 1];
        after[j] = next && next.start === pos && !next.stringStatement
          ? { text: after[j + 1].text, blank: newlines > 1 || after[j + 1].blank }
          : { text: this.src.slice(pos, Math.min(this.endOfLine(pos), pos + CODE_AFTER_MAX)).trim(), blank: newlines > 1 };
      }
      this.after = after;
    }
    const a = this.after[k];
    return strict && a.blank ? null : a.text;
  }

  /**
   * Is comment `k` part of a license header - a group before any code that
   * names a license or copyright? The header covers the comments around it
   * only when it arrived with them; beside an existing header, a comment
   * counts only when it names a license or copyright itself.
   */
  inLicenseHeader(k: number, touches: (g: number) => boolean): boolean {
    const lo = this.groupLo[k], hi = this.groupHi[k];
    if (this.found[hi].end > this.firstCode) return false;
    const text = (g: number) => this.src.slice(this.found[g].start, this.found[g].end);
    if (WORK_MARKER.test(text(k))) return false;
    const names = (g: number) => LICENSE.test(text(g));
    if (names(k)) return true;
    if (!this.licensed.has(lo)) {
      let named = false, arrived = true;
      for (let g = lo; g <= hi; g++) if (names(g)) { named = true; arrived &&= touches(g); }
      this.licensed.set(lo, named && arrived);
    }
    return this.licensed.get(lo)!;
  }

  /** What the innermost bracket around comment `k` opens, for `lang`: 'top' outside any. */
  contextOf(k: number, lang: CommentLang): Context {
    if (!this.context) {
      const context: Context[] = [];
      const stack: Context[] = [];
      let b = 0;
      this.found.forEach((f, j) => {
        for (; b < this.braces.length && this.braces[b].pos < f.start; b++) {
          const br = this.braces[b];
          if (br.ch === '{' || br.ch === '(') stack.push(opens(this.src, br.pos, this.lineStarts[this.lineOf(br.pos) - 1], br.ch, stack[stack.length - 1] ?? 'top', lang));
          else stack.pop();
        }
        context[j] = stack[stack.length - 1] ?? 'top';
      });
      this.context = context;
    }
    return this.context[k];
  }
}

type Context = 'top' | 'members' | 'block' | 'paren';

/**
 * What the bracket at `pos` opens: members (a class, interface, enum or struct
 * body, an object or type literal, a Go const/var/type group) or a block.
 */
function opens(src: string, pos: number, lineStart: number, ch: '{' | '(', parent: Context, lang: CommentLang): Context {
  const before = src.slice(Math.max(0, pos - 300), pos).trimEnd();
  if (lang === 'go') {
    if (ch === '(') return /\b(?:const|var|type)$/.test(before) ? 'members' : 'paren';
    return /\b(?:struct|interface)$/.test(before) ? 'members' : 'block';
  }
  if (ch === '(') return 'paren';
  if (lang !== 'js') return /\b(?:class|struct|interface|enum|record|union|object)\b[^{};]*$/.test(before) ? 'members' : 'block';
  const head = src.slice(Math.max(lineStart, pos - 300), pos).trim();
  if (/^(?:case\b.*|default\s*):$/.test(head)) return 'block';
  if (/^[A-Za-z_$][\w$]*\s*:$/.test(head)) return parent === 'members' ? 'members' : 'block';
  return opensMembers(before) ? 'members' : 'block';
}

/** Does a brace after `before` open members - a class, interface or enum body, or an object or type literal - rather than a block? */
function opensMembers(before: string): boolean {
  if (/\b(?:class|interface|enum)\b(?:\s+[\w$]+)?[^{};]*$/.test(before)) return true;
  if (/(?:return|default|yield|satisfies|as)$/.test(before)) return true;
  return /[=:(,[?<|&]$/.test(before) && !/=>$/.test(before);
}

/** Does comment `k` have a function? */
function functional(a: Analysed, k: number, lang: CommentLang, touches: (g: number) => boolean): boolean {
  const c = a.found[k];
  if (c.stringStatement) return c.stringStatement.docstring;
  const raw = a.src.slice(c.start, c.end);
  const body = bodyOf(raw);
  const firstLine = body.split('\n')[0].trim();
  if (DIRECTIVES.some(d => d.test(firstLine))) return true;
  if (lang === 'sql' && raw.startsWith('/*+')) return true;
  if (/SPDX-License-Identifier/.test(body)) return true;
  if (c.start < a.firstCode && a.inLicenseHeader(k, touches)) return true;
  const doc = (marker: RegExp) => marker.test(raw);
  switch (lang) {
    case 'js':
      if (!doc(/^\/\*\*(?!\/)/)) return false;
      if (c.start < a.firstCode && /@(?:file|fileoverview|module|packageDocumentation)\b/.test(body)) return true;
      return /@(?:type|typedef|callback|satisfies|template|import|overload|enum)\b/.test(body) || jsDeclaration(a.codeAfter(k, true) ?? '', a.contextOf(k, lang) === 'members');
    case 'rust':
      return doc(/^(?:\/\/\/(?!\/)|\/\/!|\/\*\*(?![*/])|\/\*!)/);
    case 'go': {
      const next = a.codeAfter(k, true) ?? '';
      const where = a.contextOf(k, lang);
      if (!a.standalone(k) || where === 'block' || where === 'paren') return false;
      return where === 'members' ? GO_MEMBER.test(next) : GO_DECLARATION.test(next);
    }
    case 'java':
    case 'kotlin':
      return doc(/^\/\*\*(?!\/)/) && cDeclaration(a.codeAfter(k, false) ?? '', a.contextOf(k, lang) === 'members');
    case 'csharp':
      return doc(/^(?:\/\*\*(?!\/)|\/\/\/(?!\/))/) && cDeclaration(a.codeAfter(k, false) ?? '', a.contextOf(k, lang) === 'members');
    case 'c':
      return doc(/^(?:\/\*\*(?!\/)|\/\*!|\/\/\/(?!\/)|\/\/!)/) && cDeclaration(a.codeAfter(k, false) ?? '', a.contextOf(k, lang) === 'members');
    default:
      return false;
  }
}

/** A comment's text as the check names it: its first line, trimmed and shortened. */
function shown(raw: string): string {
  const lines = raw.trim().split('\n');
  const one = lines[0].trim() + (lines.length > 1 ? ' …' : '');
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
}

let lastMoved: { removed: string; index: Set<string> } | null = null;
/** The longest comment line a move is recognised for: longer ones are judged as added. */
const MOVED_MAX = 1000;
/**
 * Every removed line, trimmed, and its tail from each comment-marker character
 * on: a moved comment is found whether it stood alone or after code. Kept for
 * the last `removed` text, which a check passes unchanged for every file.
 */
function movedIndex(removed: string): Set<string> {
  if (lastMoved?.removed === removed) return lastMoved.index;
  const index = new Set<string>();
  for (const line of removed.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.length <= MOVED_MAX) index.add(t);
    const marks = '/#-*"\'';
    for (let i = Math.max(0, line.length - MOVED_MAX); i < line.length; i++) if (marks.includes(line[i]) && (i === 0 || !marks.includes(line[i - 1]))) index.add(line.slice(i).trim());
    for (let e = line.indexOf('*/'); e >= 0 && e + 2 <= MOVED_MAX; e = line.indexOf('*/', e + 2)) index.add(line.slice(0, e + 2).trim());
    for (let j = line.indexOf('/*'); j >= 0; j = line.indexOf('/*', j + 2)) {
      const e = line.indexOf('*/', j + 2);
      if (e < 0) break;
      if (e + 2 - j <= MOVED_MAX) index.add(line.slice(j, e + 2));
      j = e;
    }
  }
  lastMoved = { removed, index };
  return index;
}

/**
 * The comments with no function in `content` read as `file`, in the `added`
 * lines (1-based; every line when absent). A comment counts when any of its
 * lines was added, unless every one of its lines ends a line in `removed` (the
 * lines the same change deleted, newline-terminated): that comment moved.
 * Null when the file's type has no rules.
 */
export function flagComments(file: string, content: string, added?: ReadonlySet<number>, removed?: string): FlaggedComment[] | null {
  const lang = languageOf(file, content.slice(0, lineEnd(content, 0)));
  if (!lang) return null;
  const from = content.startsWith('#!') && !content.startsWith('#![') ? lineEnd(content, 0) : 0;
  const braces: Brace[] = [];
  const found = lang === 'python' ? scanPython(content, from)
    : lang === 'shell' ? scanShell(content, from)
      : lang === 'yaml' ? scanYaml(content, from)
        : scanGeneric(content, SPECS[lang], from, braces);
  const a = new Analysed(content, found, from, braces);
  const moved = removed ? movedIndex(removed) : null;
  const out: FlaggedComment[] = [];
  /** Did the change add any line of comment `g`? */
  const touches = (g: number): boolean => {
    if (!added) return true;
    const f = found[g];
    for (let l = a.lineOf(f.start), last = a.lineOf(Math.max(f.start, f.end - 1)); l <= last; l++) if (added.has(l)) return true;
    return false;
  };
  found.forEach((c, k) => {
    const first = a.lineOf(c.start), last = a.lineOf(Math.max(c.start, c.end - 1));
    if (added) {
      let touched = false;
      for (let l = first; l <= last && !touched; l++) touched = added.has(l);
      if (!touched) return;
    }
    const raw = content.slice(c.start, c.end);
    if (moved && raw.split('\n').every((l, i) => !l.trim() || (added && !added.has(first + i)) || moved.has(l.trim()))) return;
    if (!functional(a, k, lang, touches)) out.push({ line: first, text: shown(raw) });
  });
  return out;
}
