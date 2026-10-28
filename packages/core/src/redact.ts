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

/** A key name that announces a secret value. Bounded on both sides of the word. */
const SECRET_KEY_NAME = '[A-Za-z0-9_.-]{0,40}(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]{0,40}';
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
  // name=value / name: value, the value quoted or bare
  {
    kind: 'assigned',
    re: new RegExp(`(?:^|[\\s,;{(])${SECRET_KEY_NAME}[ \\t]{0,8}[=:][ \\t]{0,8}(${DQ}|${SQ}|${BARE})`, 'dgim'),
    group: 1,
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
