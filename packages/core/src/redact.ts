/**
 * Redaction of a verify run's log before it leaves this machine (RFC-002).
 *
 * The log is whatever the test suite printed, and a verification receipt
 * carries it to the hub, where every CI job holding a token for the repository
 * can download it. What must not go with it: secrets in the formats we know,
 * values assigned to secret-named keys, this machine's own secret environment
 * values (the verify command inherits them, and a test that echoes one prints
 * it in a format no pattern knows), and the username in the home directory.
 *
 * Everything else stays exactly as printed, so the log still reads as the run
 * it was. Each redaction is a visible `[REDACTED:<kind>]`, never a silent gap:
 * a reader must be able to tell a scrubbed log from a short one.
 *
 * Every pattern is BOUNDED, and the one block that can span lines (a private
 * key) is found by a scan, not a lazy regex: a log can be 32 MiB of anything,
 * and an unbounded pattern on malformed input rescans the rest of the log from
 * every starting point, blocking the server (Codex review).
 *
 * Lives in core so the CLI can screen what it sends with the same rules
 * (Airlock learning, TEL-3); server/hub/redact.ts re-exports it.
 *
 * This is best effort against accidents, not a guarantee: a secret in a format
 * nobody named and not in the environment is still uploaded.
 */

export interface RedactOptions {
  /** The home directory to turn into `~`, or null to leave paths alone. */
  home: string | null;
  /** The environment the verify command ran with. */
  env: Record<string, string | undefined>;
}

export interface Redacted {
  text: string;
  /** How many values were replaced. */
  count: number;
}

/** An environment variable whose value is a secret, by its name. */
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|_KEY$|^KEY$|AUTH)/i;
/** Shorter values are too likely to be ordinary words to replace everywhere. */
const MIN_ENV_SECRET_LENGTH = 8;

/**
 * A key name that announces a secret value. Bounded on both sides of the word.
 * The words the Airlock dataset's key screen drops a value for are here too
 * (BUG 84604611): a credential under them in a file's content is removed as one
 * in a tool's arguments is. `pass` counts only as a word of its own (db_user_pass,
 * pass), so `compass` is not a credential; `auth` but not `author`; not `sessions`.
 */
const SECRET_KEY_NAME = '(?:[A-Za-z0-9_.-]{0,40}(?:password|passwd|passphrase|pwd|secret|token|api[_.-]?key|private[_.-]?key|access[_.-]?key|credential|cookie|authorization|auth(?!or)|signature|session[_.-]?(?:id|key|secret|token))[A-Za-z0-9_.-]{0,40}'
  + '|(?:[A-Za-z0-9_.-]{0,40}[_.-])?pass(?:[_.-][A-Za-z0-9_.-]{0,40})?)';
/**
 * A value: double-quoted with escapes, single-quoted, or bare. NOT bounded, and
 * the closing quote is optional: once a secret-named key is recognised, its
 * value is consumed to the closing quote or the end of the line, so a value of
 * any length - or one whose quote never closes - is redacted, never let
 * through (Codex review). A pattern that cannot fail after its key cannot
 * backtrack, and its matches do not overlap: one pass over the log.
 */
// A closing quote counts only when a delimiter follows it; otherwise the quote
// is the NEXT value's and pairing it would let the text between them through,
// so the value runs to the end of the line instead.
const AFTER_QUOTE = '(?=[\\s,;)}\\]]|$)';
const DQ = `"(?:[^"\\\\\\n]|\\\\.)*"${AFTER_QUOTE}|"[^\\n]*`;
const SQ = `'[^'\\n]*'${AFTER_QUOTE}|'[^\\n]*`;
const BARE = '[^\\s"\',;]+';

/**
 * A detector: a pattern and, when only part of a match is the secret, which
 * group is (the key, the `Bearer ` and the URL around it stay readable).
 *
 * No `\b`: a token embedded in a longer word (`id=agk_..._suffix`) is still
 * that token. No upper length either: every token starts at a fixed prefix,
 * so a failed attempt costs only its minimum, and a token of any length is
 * redacted whole (Codex review). Only `sk-` and JWTs keep a start guard - the
 * first or every `task-...` would go, the second so a long run of `eyJ` is
 * tried once, not at every offset.
 */
/**
 * `unquote`: 'outer' when the captured value may start with its own quote
 * (`key="v"`), 'inside' when the capture already starts inside a JSON string
 * and may end with the closing `"` - an apostrophe there is part of the value.
 */
interface Detector { kind: string; re: RegExp; group?: number; unquote?: 'outer' | 'inside' }

const DETECTORS: Detector[] = [
  { kind: 'agenfk-key', re: /(?:agk|ci)_[0-9a-f]{64}/dg },
  { kind: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}/dg },
  { kind: 'aws-key-id', re: /(?:AKIA|ASIA)[0-9A-Z]{16}/dg },
  { kind: 'slack-token', re: /xox[abposr]-[A-Za-z0-9-]{10,}/dg },
  { kind: 'api-key', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/dg },
  { kind: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg },
  { kind: 'bearer', re: /Bearer[ \t]{1,8}([A-Za-z0-9._~+/=-]{12,})/dg, group: 1 },
  { kind: 'url-password', re: /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,256}:([^\s@/]+)@/dgi, group: 1 },
  // "name": "value", with escaped quotes inside the value
  {
    kind: 'assigned',
    re: new RegExp(`"${SECRET_KEY_NAME}"\\s{0,8}:\\s{0,8}"((?:[^"\\\\\\n]|\\\\.)*"${AFTER_QUOTE}|[^\\n]*)`, 'dgim'),
    group: 1,
    unquote: 'inside',
  },
  // A cookie header or line: every cookie in it, to the end of the line - a bare value
  // stops at `;`, which would leave the cookies after the first (BUG 84604611 review).
  {
    kind: 'assigned',
    re: new RegExp(`(?:^|[\\s,;{(])(["']?)(?:set-)?cookies?\\1[ \\t]{0,8}[=:][ \\t]{0,8}(${DQ}|${SQ}|[^\\n]+)`, 'dgim'),
    group: 2,
    unquote: 'outer',
  },
  // name=value / name: value, the value quoted or bare; the name may be quoted too
  // ('passphrase': ..., YAML; BUG 84604611 review)
  {
    kind: 'assigned',
    re: new RegExp(`(?:^|[\\s,;{(])(["']?)${SECRET_KEY_NAME}\\1[ \\t]{0,8}[=:][ \\t]{0,8}(${DQ}|${SQ}|${BARE})`, 'dgim'),
    group: 2,
    unquote: 'outer',
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
const END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g;

interface Range { start: number; end: number; kind: string }

/**
 * Private-key blocks, by scanning: from each BEGIN to the next END. When no END
 * follows a BEGIN, none follows any later BEGIN either, so the scan stops -
 * one pass over the log, whatever it holds.
 */
function keyBlocks(text: string): Range[] {
  const out: Range[] = [];
  let at = 0;
  for (;;) {
    BEGIN.lastIndex = at;
    const b = BEGIN.exec(text);
    if (!b) break;
    END.lastIndex = b.index + b[0].length;
    const e = END.exec(text);
    if (!e) break;
    out.push({ start: b.index, end: e.index + e[0].length, kind: 'private-key' });
    at = e.index + e[0].length;
  }
  return out;
}

/** The part of a quoted value inside its quotes; an unclosed one runs to its end. */
function unquoted(text: string, start: number, end: number, mode: 'outer' | 'inside'): [number, number] {
  if (mode === 'inside') {
    return text[end - 1] === '"' && end - 1 > start ? [start, end - 1] : [start, end];
  }
  const q = text[start];
  if (q !== '"' && q !== "'") return [start, end];
  const closes = end - start > 1 && text[end - 1] === q;
  return [start + 1, closes ? end - 1 : end];
}
/**
 * The home directory, as a whole path that starts there: not preceded by a path
 * character (`/Users/bob/backups/Users/ana` is someone else's path) and ending
 * at a separator or the end of the path. A Windows home matches either
 * separator and any case, as Windows does.
 */
function homePattern(home: string): RegExp | null {
  // A loop, not /[\\/]+$/: that regex backtracks polynomially on a long run of separators (CodeQL).
  let end = home.length;
  while (end > 0 && (home[end - 1] === '/' || home[end - 1] === '\\')) end--;
  const trimmed = home.slice(0, end);
  if (trimmed.length < 2) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes('\\');
  const body = trimmed.split(/[\\/]/).map(escapeRe).join(windows ? '[\\\\/]' : '/');
  return new RegExp(`(?<![A-Za-z0-9_.~-])${body}(?=[\\\\/]|$|[\\s:'")\\]])`, windows ? 'gim' : 'gm');
}

/**
 * Every detector reads the ORIGINAL log and names the ranges to hide; the
 * ranges are merged and replaced once. Replacing as we went let one redaction
 * hide the key another detector needed to see - an environment value equal to
 * `password` turned `{"password":"..."}` into a key nothing recognised
 * (Codex review).
 */
/** A credential-named key on its own line (YAML `key:` or env `[export ]KEY=`), and what follows on that line. */
const SECRET_KEY_LINE = new RegExp(`^([ \\t]*)(?:-[ \\t]+|export[ \\t]+)?(["']?)${SECRET_KEY_NAME}\\2[ \\t]{0,8}[:=][ \\t]*(.*)$`, 'i');
/** Anchors and tags a YAML value may start with (`&credential`, `!!str`, `!secret`). */
const NODE_PROPERTIES = /^(?:[&!][^\s]*[ \t]+)*/;
/** What is left after them when the value continues on the next lines: nothing, or a block scalar's header. */
const BLOCK_START = /^(?:[|>][-+0-9]{0,3})?[ \t]*(?:#.*)?$/;
const indentOf = (line: string): number => line.length - line.trimStart().length;
const MAX_QUOTED_LINES = 200;
/**
 * Where a quoted value opened at v[0] closes in `v` (the index after its quote), or -1
 * when it does not close there. An escaped `"`, or a doubled `'`, does not close it.
 */
function quoteEnd(v: string, q: string, from: number): number {
  for (let i = from; i < v.length; i++) {
    if (q === '"' && v[i] === '\\') { i++; continue; }
    if (v[i] === q) {
      if (q === "'" && v[i + 1] === "'") { i++; continue; }
      return i + 1;
    }
  }
  return -1;
}

/**
 * A credential's value over several lines (epic re-review), redacted whole:
 *  - a quote that does not close on the key's line: every line to its closing quote,
 *    however they are indented (.env values are not), or the next MAX_QUOTED_LINES when
 *    it never closes (a cut-off log line does not take the rest of the log);
 *  - an empty value, or one that is only anchors/tags and a block scalar's header
 *    (`password:`, `passphrase: &c |`, `token: !!str >-`): the lines after the key that
 *    are indented deeper than it.
 * Over-redaction is the accepted failure. One pass over the lines: linear.
 */
function multilineSecretValues(input: string): Range[] {
  const out: Range[] = [];
  const lines = input.split('\n');
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }
  for (let i = 0; i < lines.length; i++) {
    const m = SECRET_KEY_LINE.exec(lines[i].replace(/\r$/, ''));
    if (!m) continue;
    const value = m[3].trim();
    const q = value[0];
    let last = i;
    if ((q === '"' || q === "'") && quoteEnd(value, q, 1) < 0) {
      // To its closing quote, however far; one that never closes (a cut-off log line)
      // takes at most MAX_QUOTED_LINES with it (review: the cap is for that case only).
      let closed = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (quoteEnd(lines[j], q, 0) >= 0) { closed = j; break; }
      }
      last = closed >= 0 ? closed : Math.min(lines.length - 1, i + MAX_QUOTED_LINES);
    } else if (BLOCK_START.test(value.replace(NODE_PROPERTIES, ''))) {
      const keyIndent = indentOf(lines[i]);
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') continue;
        if (indentOf(lines[j]) <= keyIndent) break;
        last = j;
      }
    } else continue;
    if (last > i) out.push({ start: starts[i + 1], end: starts[last] + lines[last].length, kind: 'assigned' });
    i = last;
  }
  return out;
}

export function redactLog(input: string, opts: RedactOptions): Redacted {
  const ranges: Range[] = [];

  // This machine's own secrets, wherever they appear. Literal matches: linear.
  for (const [name, value] of Object.entries(opts.env)) {
    if (!SECRET_ENV_NAME.test(name) || typeof value !== 'string' || value.length < MIN_ENV_SECRET_LENGTH) continue;
    const re = new RegExp(escapeRe(value), 'g');
    for (let m = re.exec(input); m; m = re.exec(input)) ranges.push({ start: m.index, end: m.index + value.length, kind: `env:${name}` });
  }

  // A loop, not a spread: a log can hold more blocks than a call takes arguments.
  for (const r of keyBlocks(input)) ranges.push(r);
  for (const r of multilineSecretValues(input)) ranges.push(r);

  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (let m = d.re.exec(input); m; m = d.re.exec(input)) {
      const span = d.group === undefined ? [m.index, m.index + m[0].length] : (m as any).indices?.[d.group];
      if (span && span[1] > span[0]) {
        const [s0, e0] = d.unquote ? unquoted(input, span[0], span[1], d.unquote) : span;
        if (e0 > s0) ranges.push({ start: s0, end: e0, kind: d.kind });
      }
      if (m[0].length === 0) d.re.lastIndex += 1;
    }
  }

  // Merge overlapping ranges; the earliest-starting one names the kind.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  let text = '';
  let at = 0;
  for (const r of merged) {
    text += input.slice(at, r.start) + `[REDACTED:${r.kind}]`;
    at = r.end;
  }
  text += input.slice(at);

  // The username last: a path, not a secret, and never inside a redaction.
  const home = opts.home ? homePattern(opts.home) : null;
  if (home) text = text.replace(home, '~');

  return { text, count: merged.length };
}

/** A credential-named key in the usual syntaxes: `key:`, `key=`, `"key":`, `key =>`, `export KEY=`, aligned with any blanks. */
const CREDENTIAL_KEY = new RegExp(`(?:^|[\\s,;{(\\[])(?:export[ \\t]+)?(["']?)${SECRET_KEY_NAME}\\1[ \\t]*(?:=>|[:=])`, 'im');
/** A table header line (TOML, INI): `[name]`, `[[name]]`, its name quoted or dotted. */
const TABLE_HEADER = /^[ \t]*\[\[?([^\]\n]{1,512})\]/gm;
/** One component of a table name that names a credential. */
const CREDENTIAL_NAME = new RegExp(`^${SECRET_KEY_NAME}$`, 'i');
const credentialTable = (text: string): boolean => {
  TABLE_HEADER.lastIndex = 0;
  for (let m = TABLE_HEADER.exec(text); m; m = TABLE_HEADER.exec(text)) {
    if (m[1].split('.').some((part) => CREDENTIAL_NAME.test(part.trim().replace(/^["']|["']$/g, '')))) return true;
  }
  return false;
};

/**
 * Does the text hold a credential-named key (epic re-review, user decision 2026-10-28)?
 * The Airlock dataset leaves such content out whole rather than redacting inside it:
 * no text redactor follows every file syntax (TOML triple quotes, JSON containers,
 * YAML tags and continuations, INI values...).
 */
export function hasCredentialKey(text: string): boolean {
  if (CREDENTIAL_KEY.test(text) || credentialTable(text)) return true;
  // And however the key is spelled (review): escapes decoded, every quote gone - a shell-quoted
  // document, a quoted dotted key (db."password"), an escaped JSON key ("pass\u0077ord").
  const plain = decodeEscapes(text).replace(/["'`]/g, '');
  return CREDENTIAL_KEY.test(plain) || credentialTable(plain);
}

/** `\uXXXX`, `\u{X..}`, `\xNN` and `%NN` decoded, the rest as it is (one pass, linear). */
function decodeEscapes(text: string): string {
  const ch = (hex: string): string => { const n = parseInt(hex, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; };
  return text.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|%([0-9a-fA-F]{2})/g,
    (_m, a: string | undefined, b: string | undefined, c: string | undefined, d: string | undefined) => ch((a ?? b ?? c ?? d)!));
}
