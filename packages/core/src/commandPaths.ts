/**
 * Paths inside a command that came from the repository (RFC-002).
 *
 * A verify command claimed on the hub runs on EVERY machine that clones the
 * repository, always from the repository root. So a command that names a path on
 * one person's machine — `/Users/ana/code/app/scripts/verify.sh` — is a bug the
 * hub must never hear about: it runs on Ana's laptop and nowhere else.
 *
 * The rule, applied before the command goes anywhere:
 *   - an absolute path INSIDE the checkout becomes repo-relative;
 *   - an absolute path OUTSIDE it, or a home-relative one, is refused whole.
 *
 * "Inside" is decided by RESOLVING the path (`path.resolve`), never by comparing
 * string prefixes: `/work/app-old/run.sh` starts with `/work/app` and is a
 * different directory, and `/work/app/../other/x.js` resolves outside the
 * checkout while its prefix looks clean. That is `#264`, and it is the mistake
 * this whole file exists to not make.
 *
 * What this is NOT: a sandbox. It reads the command as written, so it catches the
 * paths a person names by accident; a command can still reach outside the checkout
 * through what the shell expands (`$HOME/x.sh`, `eval`, a symlink `cd`), and no
 * static reading can stop that. A CI receipt's reuse rests on the exact tree, the
 * pinned command revision and trusted producers - not on this file (RFC-002 review).
 *
 * Refusing is all of it or none of it: a command mixing one in-checkout path with
 * one outside path is refused whole, so a caller never gets a command
 * half-rewritten into something that means something else.
 */
import * as path from 'path';

export type CommandPathResult =
  | { ok: true; command: string; rewritten: Array<{ from: string; to: string }> }
  | { ok: false; reason: string; paths: string[] };

/**
 * The conventional device paths. They are the same on every machine, which is
 * exactly why they are not machine-specific and not anybody's checkout.
 */
const DEVICE_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

/** How the path is spelled decides which platform's rules resolve it. */
type Platform = 'posix' | 'win32';

const plat = (p: Platform): path.PlatformPath => (p === 'win32' ? path.win32 : path.posix);

/**
 * A Windows path: a drive letter (`C:\`, `C:/`, and the drive-relative `C:x`,
 * which a Windows shell still resolves), or a leading `\\` UNC share. A colon
 * anywhere but offset 1 (`npm:run`) is not a drive.
 */
const WINDOWS_PATH = /^(([A-Za-z]:)|\\\\)/;

/** A POSIX absolute path or a Windows drive/share path. */
const ABSOLUTE_PATH = /^(\/|([A-Za-z]:)|\\\\)/;

/** A home-relative path: exactly `~`, or `~/...`. */
const HOME_PATH = /^~(\/|\\|$)/;

/** Both spellings of a path separator, for splitting the body of a path. */
const SEPARATORS = /[/\\]/;

/** The platform a string is spelled for: Windows only for a drive or a share. */
const spellPlatform = (text: string): Platform => (WINDOWS_PATH.test(text) ? 'win32' : 'posix');

/**
 * Does the word look like a filesystem path at all (before anyone's root)?
 *
 * Two shapes are ruled out before anything is resolved, and they are ruled out for
 * both sides of the rule — the client's rewrite and the hub's refusal ask the same
 * words the same way, or `npm test > /dev/null` would be refused twice for naming
 * `/dev/null`:
 *
 *   - A URL is a network address, not a file: `https://example.com/x` holds `//`
 *     and names no directory on any machine.
 *   - The conventional device paths — `/dev/null`, `/dev/stdout`, `/dev/stderr` —
 *     are the same on every machine, which is exactly why they are not
 *     machine-specific and not anybody's checkout.
 */
function looksLikePath(text: string): boolean {
  if (!text) return false;
  if (text.includes('://')) return false;
  if (DEVICE_PATHS.has(text)) return false;
  return ABSOLUTE_PATH.test(text) || HOME_PATH.test(text);
}

/**
 * A word of the command: the run of characters the shell hands to the program,
 * with the offset in the ORIGINAL string of every character it holds.
 */
interface Word {
  /** Start offset in the ORIGINAL command string. */
  start: number;
  /** End offset in the ORIGINAL command string (exclusive). */
  end: number;
  /**
   * Was any character of the word taken in inside a quote — single or double?
   *
   * The word's quoting is what tells a replacement how to spell itself. Inside
   * quotes the shell splits nothing, so `"./scripts/run all.sh"` is one argument
   * and stays exactly as it is written. Outside quotes a space ends the word,
   * and the only way to keep it is a backslash — which is why an unquoted path
   * whose own space was escaped (`/work/app/run\ all.sh`) has to come back with
   * that escape rebuilt, or the rewritten command is two words and no file.
   */
  quoted: boolean;
  /**
   * The offset in the ORIGINAL string of every character the shell sees. A word's
   * text and the string it came from are two different things once quotes and
   * escapes are in play, and a replacement has to move the second to change the
   * first — hence an offset per character rather than one per word.
   */
  src: number[];
}

/**
 * Split a command into words the way a POSIX shell roughly does: words are
 * separated by unquoted whitespace and by the operators `&&`, `||`, `;`, `|`,
 * `(`, `)`. Single quotes are literal; double quotes allow `\"`; a backslash
 * outside quotes escapes the next character.
 */
function words(command: string): Word[] {
  const out: Word[] = [];
  const n = command.length;
  let i = 0;

  while (i < n) {
    // Every branch of this loop moves the offset, and it has to: a character that
    // is looked at and skipped is the loop reading the same character forever.
    if (isSpace(command[i]!)) { i += 1; continue; }
    if (isWordBoundary(command, i)) { i += operatorLen(command, i); continue; }

    const start = i;
    const src: number[] = [];
    let quote: '"' | "'" | null = null;
    let quoted = false;

    while (i < n) {
      const c = command[i]!;
      if (quote === "'") {
        // Single quotes are literal: everything up to the closing one is the word,
        // which is why `'/repo/run all.sh'` is one word with a space in it.
        if (c === "'") { quote = null; i += 1; continue; }
        src.push(i); i += 1; continue;
      }
      if (quote === '"') {
        if (c === '"') { quote = null; i += 1; continue; }
        // Inside double quotes a backslash escapes a quote or another backslash,
        // which is exactly the spelling of a Windows path with a space in it.
        if (isBackslash(c) && (command[i + 1] === '"' || isBackslash(command[i + 1]))) { i += 2; continue; }
        src.push(i); i += 1; continue;
      }
      if (isBackslash(c)) {
        // A backslash outside quotes escapes the next character — except the one a
        // Windows path brings with itself. `C:\work\app` names a directory called
        // `work`, not one called "escape-w, ork", so only a backslash that escapes
        // a space is an escape; the space is the character and it keeps its offset.
        if (i + 1 >= n) { src.push(i); i += 1; continue; }
        if (!isSpace(command[i + 1]!)) { src.push(i); i += 1; continue; }
        src.push(i + 1); i += 2; continue;
      }
      if (c === "'" || c === '"') { quote = c; quoted = true; i += 1; continue; }
      if (isSpace(c) || isWordBoundary(command, i)) break;
      // An unquoted redirection attached to a word (`npm test>/tmp/x`) starts a
      // word of its own, so the file it opens is looked at like any other path.
      // A word that is still only redirection characters (`>>`, `2>&`) goes on.
      // `>>`, `&>` and `2>&1` stay whole; the `>` of `2>&1>/tmp/x` that opens a
      // file after a duplication starts a word of its own (Codex review).
      if ((c === '<' || c === '>') && src.length > 0 && !/[<>&]/.test(command[src[src.length - 1]!]!)) break;
      src.push(i); i += 1; continue;
    }

    out.push({ start, end: i, src, quoted });
    // A word that stopped before taking any character in (an operator, the end of
    // the command) is not a word: move past what stopped it or read it forever.
    if (i === start) i += 1;
  }
  return out;
}

/** The backslash code point, compared by number: see `isBackslash`. */
const BACKSLASH = 0x5c;

/**
 * Is this character a backslash?
 *
 * Compared by code point rather than against a literal because this file's whole
 * job turns on which characters of a Windows path survive the trip from the
 * command to the filesystem, and a comparison that quietly matches more than it
 * should turns `C:\work\app` into `C:workapp` — a word that resolves nowhere and
 * gets refused as somebody's private path. A number cannot be mis-written that
 * way, and the failure is invisible: the tests that notice are the Windows ones.
 */
const isBackslash = (c: string | undefined): boolean => (c?.charCodeAt(0) ?? -1) === BACKSLASH;

/** Is this character a space, tab, newline or the like? */
const isSpace = (c: string): boolean => /\s/.test(c);

/**
 * Is an operator that ENDS a word at this offset? `&&`, `||`, `;`, a single `|`,
 * `(` and `)` — the ones the spec lists. A `>` is not one: a redirection is not
 * an operator here, so `npm test >"/dev/null"` keeps its `>` attached to the word
 * it precedes, and `2> /dev/stderr` keeps the `>` off the path entirely.
 */
function isWordBoundary(command: string, at: number): boolean {
  const c = command[at]!;
  if (c === '&' || c === '|') return command[at + 1] === c;
  return c === ';' || c === '|' || c === '(' || c === ')';
}

/** How many characters the operator at this offset takes. */
const operatorLen = (command: string, at: number): number => {
  const c = command[at]!;
  return (c === '&' || c === '|') && command[at + 1] === c ? 2 : 1;
};

/** A word's visible text: its own characters, with the quote characters out. */
const visibleOf = (word: Word, command: string): string => word.src.map((at) => command[at]).join('');

/**
 * A redirection in front of a path: `<`, `>`, `>>`, `2>`, `&>`. The shell opens
 * the file that follows, so `bash </opt/tools/check.sh` names a file exactly as
 * `bash /opt/tools/check.sh` does (Codex review of RFC-002).
 */
const REDIRECTION = /^\d*(?:&>>?|<>|>\||>>|>&|<&|<|>)/;

interface Piece {
  start: number;
  end: number;
  text: string;
  quoted: boolean;
  /** A quote character sits INSIDE the piece (`/work/app/"scripts/x.js"`): no splice can keep it a valid word. */
  embeddedQuote: boolean;
}

/**
 * The parts of a word that may name a file: the whole word, the part after a
 * redirection, and the part after the first `=` (`--config=/repo/vitest.config.ts`).
 *
 * `start` and `end` bracket the path's characters only: a quote around them is
 * not one of them, because the replacement moves the path and leaves the quoting
 * where it is — `bash "/repo/run all.sh"` has to come back with its quotes, or it
 * is two arguments and not one.
 */
function pieces(word: Word, command: string): Piece[] {
  const visible = visibleOf(word, command);
  const from = new Set<number>([0]);
  const redir = REDIRECTION.exec(visible);
  if (redir) from.add(redir[0].length);
  const eq = firstEquals(visible);
  if (eq >= 0) from.add(eq + 1);
  const out: Piece[] = [];
  for (const at of from) {
    const first = word.src[at];
    const last = word.src[visible.length - 1];
    if (first === undefined || last === undefined) continue;
    out.push({
      start: first, end: last + 1, text: visible.slice(at), quoted: word.quoted,
      embeddedQuote: /["']/.test(command.slice(first, last + 1)),
    });
  }
  return out;
}

/** The path a word names, in the ORIGINAL string, or null when the word names none. */
function pathPart(word: Word, command: string): Piece | null {
  for (const p of pieces(word, command)) if (looksLikePath(p.text)) return p;
  return null;
}

/**
 * Where a relative path ends up, counted in directories below the repository
 * root, starting from `depth` (where an earlier `cd` left the shell). Negative
 * means it climbed out: `../tools/check.sh` from the root names a file beside
 * the checkout, which no other clone has — the same machine-specific file an
 * absolute path would name, written without a single `/` up front.
 */
function depthAfter(text: string, depth: number): number {
  let d = depth;
  for (const seg of text.split(SEPARATORS)) {
    if (seg === '..') { d -= 1; if (d < 0) return d; } else if (seg && seg !== '.') d += 1;
  }
  return d;
}

/** The relative piece of a word that climbs out of the checkout, or null. */
function climbingPiece(word: Word, command: string, depth: number): string | null {
  for (const p of pieces(word, command)) {
    if (looksLikePath(p.text) || p.text.includes('://') || !p.text.split(SEPARATORS).includes('..')) continue;
    if (depthAfter(p.text, depth) < 0) return p.text;
  }
  return null;
}

/**
 * Walk the command's words, tracking how deep a relative `cd` moved the shell
 * below the root, and hand each word with that depth. A `cd` into a relative
 * directory is itself checked for climbing; any other `cd` leaves the depth as
 * it was, which only ever refuses more, never less.
 */
function* wordsWithDepth(command: string): Generator<{ word: Word; depth: number }> {
  // A `cd` moves the shell's directory only where it surely ran and nothing can
  // undo it: as the FIRST word of the command, followed straight by `&&` (a
  // failed cd stops everything after it), the only `cd` in the command, and no
  // other control operator anywhere (`;`, `||`, a lone `&`, `|`, a subshell, a
  // newline). Every other shape is judged from the repository root, which only
  // ever refuses more. Chasing each shell construct one by one kept missing the
  // next one (Codex review, three passes); this is the whole of the rule.
  const all = words(command);
  const texts = all.map((w) => visibleOf(w, command));
  const leading = texts[0] === 'cd' && all.length >= 3
    && command.slice(all[1]!.end, all[2]!.start).trim() === '&&'
    && texts.filter((t) => t === 'cd').length === 1
    && !/;|\|\||(^|[^&])&([^&]|$)|\||[()\n]/.test(command.replace(/&&/g, ''));
  // Only a literal relative directory: `$PWD`, `-`, a glob or a backquote is
  // expanded by the shell into somewhere this scanner cannot follow.
  const target = texts[1] ?? '';
  const literal = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(target) && !all[1]!.quoted;
  const credited = leading && literal ? depthAfter(target, 0) : 0;
  for (let k = 0; k < all.length; k += 1) {
    yield { word: all[k]!, depth: k >= 2 && credited > 0 ? credited : 0 };
  }
}

/** Offset of the first `=` in the visible text, or -1. */
function firstEquals(text: string): number {
  for (let k = 0; k < text.length; k += 1) if (text[k] === '=') return k;
  return -1;
}

/**
 * Is `target` under `root`? Decided by resolving, never by comparing prefixes:
 * an empty rel is the root itself, a rel that climbs with `..` or that resolves
 * to another root (`/work/app-old`) is outside, and the comparison ignores case
 * on Windows because a Windows path does.
 *
 * Two paths on different drives have no root in common, so `relative` hands back
 * the target itself rather than a route to it — and a path handed back whole is a
 * path that is not under anything.
 */
function inside(root: string, target: string, platform: path.PlatformPath): boolean {
  if (platform === path.win32 && root.slice(0, 1).toLowerCase() !== target.slice(0, 1).toLowerCase()) return false;
  const rel = platform.relative(root, target);
  if (rel === '') return true;
  if (platform.isAbsolute(rel)) return false;
  return rel.split(SEPARATORS)[0] !== '..';
}

/**
 * The text that replaces a path inside the checkout: `.` for the root itself,
 * otherwise `./` + the relative path. The separator follows the platform whose
 * rules resolved the path, so a POSIX command keeps `/`.
 */
function relativeText(root: string, target: string, platform: path.PlatformPath): string {
  const rel = platform.relative(root, target);
  return rel === '' ? '.' : `.${platform.sep}` + rel;
}

/** Escape every space in replacement text for a word outside quotes. */
const escapeSpaces = (text: string): string => text.replace(/ /g, '\\ ');

/** A refusal naming every offending path, in the order the command names them. */
function refusal(paths: string[]): { ok: false; reason: string; paths: string[] } {
  const listed = paths.map((p) => `\`${p}\``).join(', ');
  return {
    ok: false,
    paths,
    reason:
      'The verify command runs from the repository root on every machine that clones the repository, '
      + `so it cannot name a path that only exists on one machine: ${listed}. `
      + 'Name the file relative to the repository instead (for example `./scripts/verify.sh`), '
      + 'or put the logic in a script committed to the repository.',
  };
}

/**
 * Rewrite in-checkout absolute paths to repo-relative; refuse machine-specific
 * ones.
 *
 * `checkoutRoot` is the checkout the command came from — the one the caller can
 * see and the hub cannot. With null there is nothing to make a path relative to,
 * so every absolute or home path is refused.
 */
export function normalizeCommandPaths(command: string, checkoutRoot: string | null): CommandPathResult {
  // The root is spelled for one platform and stays on it: `C:\work\app` resolves
  // with Windows rules and `/work/app` with POSIX ones whatever machine runs the
  // code, so a test never depends on the machine it runs on.
  const rootPlatform: Platform | null = checkoutRoot === null ? null : spellPlatform(checkoutRoot);
  const root = checkoutRoot === null || rootPlatform === null
    ? null
    : plat(rootPlatform).normalize(checkoutRoot);

  // Every word is decided before anything is rewritten: one refusal throws the
  // whole command away, so a caller never gets a half-rewritten command.
  const refused: string[] = [];
  const replace: Array<{ start: number; end: number; from: string; to: string }> = [];
  for (const { word, depth } of wordsWithDepth(command)) {
    const climbing = climbingPiece(word, command, depth);
    if (climbing) { refused.push(climbing); continue; }
    const part = pathPart(word, command);
    if (!part) continue;

    // A quote INSIDE the path (`/work/app/"scripts/x.js"`) cannot survive a
    // splice that moves only the path's characters: the opening quote would go
    // with them and leave the closing one unmatched. Refused, not guessed at.
    if (part.embeddedQuote) {
      refused.push(part.text);
      continue;
    }

    // With no checkout there is nothing to make the path relative to.
    if (root === null || rootPlatform === null) {
      refused.push(part.text);
      continue;
    }

    // A home path names a different directory on every machine whatever the
    // checkout is; it is never made relative to somebody else's home.
    if (HOME_PATH.test(part.text)) {
      refused.push(part.text);
      continue;
    }

    // A path spelled for another platform (a `C:\` path handed to a POSIX
    // checkout) cannot be compared to the root at all: it is outside it.
    const pathPlatform = spellPlatform(part.text);
    if (pathPlatform !== rootPlatform) {
      refused.push(part.text);
      continue;
    }

    const platform = plat(pathPlatform);
    // The target is already absolute, so passing the root to `resolve` only
    // settles a relative spelling; Windows comparison ignores case by itself.
    const resolved = platform.resolve(root, part.text);
    if (!inside(root, resolved, platform)) {
      refused.push(part.text);
      continue;
    }
    replace.push({
      start: part.start,
      end: part.end,
      from: part.text,
      // The replacement is written for the quoting it lands in. Inside quotes the
      // shell splits nothing, so the text goes in as it is. Outside them a space
      // ends the word, and the relative path has to carry its own escape — the
      // original word escaped its space the same way, and the splice below
      // replaces those characters with the new text, so the escape would
      // otherwise be gone and `./run all.sh` would be two arguments.
      to: part.quoted ? relativeText(root, resolved, platform) : escapeSpaces(relativeText(root, resolved, platform)),
    });
  }

  if (refused.length) return refusal(refused);
  if (!replace.length) return { ok: true, command, rewritten: [] };

  // Splice from the END backwards so the earlier offsets stay valid, and only the
  // path characters move: the quotes around them are never touched.
  let out = command;
  for (const r of [...replace].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.to + out.slice(r.end);
  }
  return { ok: true, command: out, rewritten: replace.map((r) => ({ from: r.from, to: r.to })) };
}

/**
 * The machine-specific paths a command names, with no checkout to compare to
 * (the hub's view), in order and without repeats.
 *
 * One rule, seen from the side that cannot see the checkout. The client has it,
 * and the checkout is what tells a repository's own file from Ana's directory next
 * door — and what lets the first be written `./scripts/verify.js`, the only
 * spelling that names the same file on every machine that clones the repository.
 *
 * The hub has nobody's disk, so it refuses every absolute path and every
 * home-relative one: `bash "C:\Users\ana\app\run.sh"`, `node /work/app/x.js`,
 * `bash ~/bin/check.sh` each name a file on one machine, and a command that still
 * carries one never went through a client that could have made it relative.
 *
 * And that is the shape the hub is actually handed. The client's pass is
 * all-or-nothing — every path inside the checkout rewritten, the command refused
 * whole if any lay outside — so what arrives reads
 * `bash "./scripts/run all.sh" --ci`, the quoting of the word it came from kept so
 * the shell still reads one argument. Rewritten on the side that knows the
 * checkout, refused on the side that does not; one rule, seen twice, and nothing
 * in between that has to guess at a disk.
 */
export function machineSpecificPaths(command: string): string[] {
  const refused: string[] = [];
  for (const { word, depth } of wordsWithDepth(command)) {
    // A relative path that climbs above the root names a file beside the
    // checkout, which is as machine-specific as an absolute one.
    const climbing = climbingPiece(word, command, depth);
    if (climbing) { refused.push(climbing); continue; }
    // `pathPart` is the shared judgement of which words are paths at all — a URL
    // and `/dev/null` are not, on either side. Everything left is a filesystem
    // path, and a filesystem path with no checkout to be relative to belongs to
    // the machine it was written on and nowhere else: `bash
    // "C:\Users\ana\app\run.sh"`, `node /work/app/x.js`, `bash ~/bin/check.sh`.
    //
    // The client, which does have a checkout, is the side that turns the ones
    // inside it into `./scripts/verify.js` and refuses the rest, so the command
    // the hub holds reads `bash "./scripts/run all.sh" --ci` — the quoting of the
    // word it came from kept, so the shell still reads one argument. Rewritten on
    // the side that knows the checkout, refused on the side that does not: one
    // rule, seen twice, and nothing in between guessing at a disk.
    const part = pathPart(word, command);
    if (!part) continue;
    refused.push(part.text);
  }
  return [...new Set(refused)];
}
