/**
 * Airlock on smolvm (CGLAB-696): every session runs in a microVM, so every
 * outbound connection - HTTPS, psql, ssh, mongosh - leaves through the host's
 * egress interceptor, which ASRT's proxy-only network could not do.
 *
 * ONE MACHINE PER WORKSPACE: the folder Airlock is launched from has a
 * persistent machine of its own, created on the first launch, started for a
 * session and stopped when the last session in it leaves. What a session
 * installs in the guest (Linux node_modules, apk packages) stays on the
 * machine's disk for the next one. `agenfk airlock reset` deletes it.
 *
 * WHAT THE GUEST SEES is only what is mounted: the spec's write roots (the
 * workspace and the client's state) at their host paths, never the host's temp
 * dirs (the guest has its own /tmp) nor the rest of the home. Inside those
 * mounts, what the spec keeps unwritable is bound read-only in the guest, and
 * what it keeps unreadable is hidden, by a setup script run as root before the
 * session; the session runs as the host user's uid, which cannot undo them.
 * Missing git paths a planted file would turn into config (commondir,
 * config.worktree, modules, worktrees) are held by placeholders git accepts,
 * created on the host for the session and removed after the last one.
 *
 * SIGNALS: signalling `smolvm machine exec` ends only its host side; the
 * command keeps running in the guest (measured, 1.32.4). So the command runs
 * as a session leader that records its pid, and a signal is sent to its
 * process group from inside the guest.
 */
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { AIRLOCK_SANDBOX_MARKER, type SandboxSpec } from './spec';
import { allowListArgs, GATEWAY, networkKey, RESOLVER_REPORT_PORT, type Route } from './egress';
import { processIdentity, sameProcess } from './processIdentity';
import { breakStaleLock, withOwnerLock, type OwnerLockDeps } from './ownerLock';
import { machineCa, placeholderFor, startKeyInjector, type KeyInjector, type KeyInjectorOptions, type MachineCa } from './keyInjector';
import { readRegularFile } from './safeRead';
import type { AirlockRuntime, LaunchHooks, LaunchedSandbox, ProxyDecision, RuntimeCheck, SandboxCommand, SandboxExit } from './runtime';

/** Exactly the version AgEnFK installs (no range): a bump is a reviewed change. */
export const SMOLVM_VERSION = '1.32.4';

export interface SmolvmResult { code: number | null; stdout: string; stderr: string }
export type SmolvmRun = (args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<SmolvmResult>;

/**
 * The host side of the machine's network: smolvm hands it every outbound TCP
 * flow (mediated egress) and it decides. One per running machine.
 */
export interface EgressBroker {
  /** Starts (or finds) the machine's interceptor: the address and token `machine start` is given. */
  ensure(machine: string, spec: SandboxSpec): Promise<{ address: string; token: string }>;
  /** Hands the machine's decisions to `onDecision` until the returned function is called. */
  watch(machine: string, onDecision: (decision: ProxyDecision) => void): () => void;
  /** The machine stopped: its interceptor ends. */
  stop(machine: string): Promise<void>;
  /** A new Unix socket path, private to the user, for a session's route. */
  routeSocket(machine: string): string;
  /** Adds a session's route (its relay, its key injector) for the machine's decider; the returned function takes it away. */
  addRoute(machine: string, route: Route): () => void;
  /** The machine's running decider decides by `network` from now on (story review 2). */
  updateNetwork(machine: string, network: SandboxSpec['network']): Promise<void>;
  /** The token the machine's resolver reports its refusals under (85d37bd5); none: it reports nothing. */
  resolverToken?(machine: string): string | null;
}

const hash16 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Where `pointer` leads from `dir`, walked as the filesystem walks it (review): component by
 * component as written, `..` taken from where the walk has got to, a link followed only where
 * `fixed` says nothing in the session could repoint it - one it could is returned as `{ link }`.
 * The part that does not exist is taken as written. A loop of links leads nowhere (`{ link }`).
 */
function walkPointer(dir: string, pointer: string, fixed: (p: string) => boolean): { path: string } | { link: string } | { refused: string } {
  const split = (p: string) => p.split(path.sep);
  let at = path.isAbsolute(pointer) ? path.parse(pointer).root : dir;
  const queue = split(path.isAbsolute(pointer) ? pointer.slice(at.length) : pointer);
  let hops = 0;
  while (queue.length) {
    const c = queue.shift()!;
    if (c === '' || c === '.') continue;
    if (c === '..') { at = path.dirname(at); continue; }
    const next = path.join(at, c);
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(next);
    } catch (e) {
      // Only absence is taken as such: anything else could hide what git would reach.
      if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return { refused: `${next} cannot be examined` };
    }
    if (!st) {
      // What is not there could be made a link later: a `..` after it is not taken on its text (review).
      if (queue.includes('..')) return { refused: `${next} does not exist, and the path goes back up through it` };
      at = next;
      for (const r of queue) at = r === '' || r === '.' ? at : path.join(at, r);
      return { path: at };
    }
    if (!st.isSymbolicLink()) {
      // Git finds nothing past a file now; the session could make it a link to somewhere later (review).
      if (!st.isDirectory() && queue.some((r) => r !== '' && r !== '.')) return { refused: `${next} is not a directory, and the path goes on through it` };
      at = next;
      continue;
    }
    if (!fixed(next) || ++hops > 40) return { link: next };
    const to = fs.readlinkSync(next);
    if (path.isAbsolute(to)) at = path.parse(to).root;
    queue.unshift(...split(path.isAbsolute(to) ? to.slice(path.parse(to).root.length) : to));
  }
  return { path: at };
}

/** The git dir a `.git` file names, read as git reads one (setup.c): `gitdir: ` then the path, CR/LF ends dropped. */
const MAX_GITFILE = 1 << 20;
function gitfilePointer(file: string): string | null {
  const bytes = readRegularFile(file, MAX_GITFILE);
  let text: string;
  // Git keeps a path's bytes: one that is not UTF-8 would be read here as another path (review).
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes ?? undefined); } catch { return null; }
  if (!bytes || !text.startsWith('gitdir: ')) return null;
  const p = text.slice('gitdir: '.length).replace(/[\r\n]+$/, '');
  // Git reads a C string: a NUL ends the path where Node would not (review).
  return p && !p.includes('\0') ? p : null;
}

/** The machine of a workspace folder: one name per folder, stable across sessions. */
export function machineNameOf(workspace: string): string {
  return `agenfk-${hash16(path.resolve(workspace))}`;
}

export type Placeholder = { path: string; kind: 'file'; content: string } | { path: string; kind: 'dir' };

export interface GuestPlan {
  /** Host directories mounted into the guest at the same path. */
  mounts: Array<{ host: string; guest: string; readOnly: false }>;
  /**
   * Directories bound onto themselves, still writable: a mount point cannot be
   * renamed or removed, so the read-only paths inside it cannot be moved aside
   * and replaced (the workspace's .git: its objects and refs stay writable).
   */
  pinned: string[];
  /**
   * Paths inside a read-only one bound writable again (a linked worktree's own git dir, under the
   * read-only worktrees dir): a bind made below a read-only one is read-only itself (measured).
   */
  writable: string[];
  /** Paths inside the mounts bound read-only in the guest. */
  readOnly: string[];
  /** Paths inside the mounts the guest cannot read. */
  hidden: Array<{ path: string; kind: 'file' | 'dir' }>;
  /** Protected paths that do not exist yet, held for the session so nothing can be planted there. */
  placeholders: Placeholder[];
  /** Why not every install destination could be placed (a workspace pattern beyond Airlock): nothing is installed then. */
  platformIncomplete?: string;
  /**
   * The guest's own platform dirs (node_modules, .venv), each bound over the host's from a store
   * on the machine's disk: what the guest installs is Linux's and stays there, and the host's are
   * never touched. One the host lacks is held by an empty directory to bind onto.
   */
  platform: Array<{ path: string; store: string }>;
}

/**
 * Protected files held by content git accepts (measured): a commondir of `.` is the repository
 * itself, and an empty config or config.worktree sets nothing. Any other placeholder is an empty dir.
 */
const FILE_PLACEHOLDERS: Record<string, string> = {
  commondir: '.\n', 'config.worktree': '', config: '',
  // A client's settings held while missing: a file its client reads as empty, never a dir it cannot read.
  'settings.json': '{}\n', 'opencode.json': '{}\n', 'opencode.jsonc': '{}\n', 'config.json': '{}\n', 'package.json': '{}\n',
};

/** In the workspace's .git: unwritable, and held when missing. */
const GIT_PROTECTED = ['hooks', 'config'];
/** In a repository's git dir below the workspace: what the spec protects in the top one's, too. */
const NESTED_GIT_PROTECTED = ['hooks', 'config', 'commondir', 'config.worktree', 'modules', 'worktrees'];
/**
 * What ASRT kept unwritable in the working directory without being told (its
 * mandatory denies), kept so here when they exist. Not held when missing: an
 * empty .vscode or .idea would be noticed by the IDE.
 */
// The project's pi and OpenCode config and extensions too (fix review 3), which the host's client
// loads on its next launch here. Not .pi itself: pi takes its settings lock in it before reading.
const WORKSPACE_PROTECTED = ['.gitmodules', '.vscode', '.idea', '.claude/commands', '.claude/agents', '.mcp.json',
  'opencode.json', 'opencode.jsonc', '.opencode', '.pi/settings.json', '.pi/extensions'];

/** Where the guest keeps its own platform dirs, on the machine's disk. */
export const GUEST_PLATFORM_ROOT = '/var/lib/agenfk/platform';
/** A directory holding one of the markers gets its own copy of `dir` in the guest. */
const PLATFORM_DIRS: Array<{ markers: string[]; dir: string }> = [
  { markers: ['package.json'], dir: 'node_modules' },
  { markers: ['pyproject.toml', 'requirements.txt'], dir: '.venv' },
];
/** The lockfiles a workspace's dependencies are installed from in the guest, first found wins. */
const INSTALLERS: Array<{ lockfile: string; command: string[] }> = [
  { lockfile: 'package-lock.json', command: ['npm', 'ci'] },
  { lockfile: 'pnpm-lock.yaml', command: ['pnpm', 'install', '--frozen-lockfile'] },
  { lockfile: 'yarn.lock', command: ['yarn', 'install', '--frozen-lockfile'] },
];

/** Directories a `**` search below the workspace does not enter. */
const SEARCH_SKIP = new Set(['node_modules', '.git']);
const SEARCH_DEPTH = 8;
/** Git's object store holds no hooks or config: not walked for links, inside a git dir only. */
const ALIAS_SCAN_SKIP = new Set(['objects', 'lfs']);
const ALIAS_SCAN_LIMIT = 50_000;

type Kind = 'file' | 'dir' | null;
const kindOfPath = (p: string): Kind => {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
};

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Every directory named `name` below `dir` (not following links, not into SEARCH_SKIP). */
function findNamed(dir: string, name: string, depth = 0): string[] {
  if (depth > SEARCH_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    // A link by that name would take the protection to wherever it points.
    if (e.name === name && e.isSymbolicLink()) throw new Error(`Airlock cannot protect ${p}: it is a symbolic link, and the session could replace the link itself. Nothing was launched.`);
    if (!e.isDirectory()) continue;
    if (e.name === name) found.push(p);
    else if (!SEARCH_SKIP.has(e.name)) found.push(...findNamed(p, name, depth + 1));
  }
  return found;
}

/** A pattern in the last segment only (`~/.ssh/id_*`): its directory and a matcher. */
function lastSegmentGlob(p: string): { dir: string; match: RegExp } | null {
  const dir = path.dirname(p);
  const base = path.basename(p);
  if (/[*?]/.test(dir) || !/[*?]/.test(base)) return null;
  const re = base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return { dir, match: new RegExp(`^${re}$`) };
}

/**
 * A spec path as the paths it names now: `<root>/**\/<name>` is every such directory, a pattern in
 * the last segment every matching entry. Any other pattern cannot be matched here, and throws:
 * a deny is never dropped.
 */
function expand(p: string): string[] {
  const glob = /^([^*?]*)\/\*\*\/([^/*?]+)$/.exec(p);
  if (glob) return findNamed(glob[1], glob[2]);
  if (!/[*?]/.test(p)) return [p];
  const last = lastSegmentGlob(p);
  if (!last) throw new Error(`Airlock cannot apply the protection ${p} in a machine, so nothing was launched.`);
  try {
    return fs.readdirSync(last.dir).filter((n) => last.match.test(n)).map((n) => path.join(last.dir, n));
  } catch {
    return [];
  }
}

/** A git dir (`.git`, or a submodule's under .git/modules): it has HEAD and objects. */
function isGitDir(dir: string): boolean {
  return kindOfPath(path.join(dir, 'HEAD')) === 'file' && kindOfPath(path.join(dir, 'objects')) === 'dir';
}

/** The first file at or below `p` with more than one name, or null. Fails closed past the scan limit. */
function hardLinkedIn(p: string): string | null {
  let seen = 0;
  const visit = (q: string, depth: number): string | null => {
    if (++seen > ALIAS_SCAN_LIMIT) throw new Error(`Airlock could not check ${p} for hard links (over ${ALIAS_SCAN_LIMIT} entries), so nothing was launched.`);
    const st = fs.lstatSync(q);
    if (st.isFile()) return st.nlink > 1 ? q : null;
    if (!st.isDirectory()) return null;
    for (const n of fs.readdirSync(q)) {
      const hit = visit(path.join(q, n), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return visit(p, 0);
}

/**
 * The first link a session could replace on the way from the link `start` to what it finally names:
 * any later hop of the chain, or a linked directory in a hop's path, inside the mounts and outside
 * every read-only path. Null when the whole way is fixed.
 */
/**
 * Whether `q` ends up read-only in the guest: the deepest read-only or writable bind holding it
 * decides (a writable one below a read-only one gives it back, review 01a18d52).
 */
function underReadOnly(q: string, readOnly: string[], writable: string[]): boolean {
  let best: { len: number; ro: boolean } | null = null;
  for (const r of readOnly) if (inside(q, r) && (!best || r.length > best.len)) best = { len: r.length, ro: true };
  for (const w of writable) if (inside(q, w) && (!best || w.length > best.len)) best = { len: w.length, ro: false };
  return !!best?.ro;
}

function replaceableLinkOn(start: string, mounted: (p: string) => boolean, readOnly: string[], writable: string[]): string | null {
  const fixed = (q: string) => !mounted(q) || underReadOnly(q, readOnly, writable);
  let cur = start;
  for (let hops = 0; hops < 40; hops++) {
    const next = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
    // A linked directory between the filesystem root and the next hop.
    for (let a = path.dirname(next); a !== path.dirname(a); a = path.dirname(a)) {
      if (kindOfPath(a) && fs.lstatSync(a).isSymbolicLink() && !fixed(a)) return a;
    }
    if (!kindOfPath(next) || !fs.lstatSync(next).isSymbolicLink()) return null;
    if (!fixed(next)) return next;
    cur = next;
  }
  return start;
}

/**
 * Links and hard links in a protected tree that would let it be changed from outside it: a link
 * whose target is in the mounts outside every read-only path (its target is returned, to be made
 * read-only), one that points into the mounts at nothing yet (refused: the session could create
 * it), and a file with another name (refused: the other name may be writable).
 */
function aliasesIn(tree: string, mounted: (p: string) => boolean, readOnly: string[], writable: string[]): string[] {
  const targets: string[] = [];
  let seen = 0;
  const visit = (p: string, depth: number) => {
    if (++seen > ALIAS_SCAN_LIMIT) throw new Error(`Airlock could not check ${tree} for links (over ${ALIAS_SCAN_LIMIT} entries), so nothing was launched.`);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      // Each hop of the chain, and each linked directory on the way, could be swapped by the
      // session for a link to something else: refused unless it is itself protected.
      const swappable = replaceableLinkOn(p, mounted, readOnly, writable);
      if (swappable) throw new Error(`Airlock cannot protect ${p}: it resolves through ${swappable}, a link the session could replace. Nothing was launched.`);
      const lexical = path.resolve(path.dirname(p), fs.readlinkSync(p));
      let target = lexical;
      try { target = fs.realpathSync(p); } catch { /* dangling */ }
      if (!mounted(target) || underReadOnly(target, readOnly, writable)) return;
      if (!kindOfPath(target)) throw new Error(`Airlock cannot protect ${p}: it links to ${target}, which does not exist and the session could create. Nothing was launched.`);
      targets.push(target);
      return;
    }
    if (st.isFile() && st.nlink > 1) throw new Error(`Airlock cannot protect ${p}: it has another name (a hard link), which the session may be able to write. Nothing was launched.`);
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(p)) if (!(ALIAS_SCAN_SKIP.has(n) && isGitDir(p))) visit(path.join(p, n), depth + 1);
    }
  };
  visit(tree, 0);
  return targets;
}

/** What the guest of `workspace` sees, from the spec. Reads the host file system, writes nothing. */
/**
 * The workspace's effective git config as `git config --list --show-origin --includes` prints it
 * (every scope, includes followed), or null where there is no git or no repository. Reading
 * config runs no hook.
 */
export interface GitConfig {
  /** include.path and includeIf.*.path entries (`--get-regexp --show-origin -z`), includes not followed, paths expanded by git (`~`, `~user`). */
  list: string;
  /** `git config --list --show-origin --includes -z`: every scope, includes followed - what was read, and where from. */
  included: string;
  /** core.hooksPath (`--get-regexp --show-origin --includes -z`), expanded by git. */
  hooks: string;
  /** The repository's top (`git rev-parse --show-toplevel`), which relative hook paths are read from. */
  top: string | null;
}
/**
 * Host git's effective config for `dir`, or null where there is no git or no repository (git
 * finds one above `dir` itself); throws when a repository's config cannot be read in full.
 * Reading config runs no hook.
 */
export type GitConfigReader = (dir: string) => GitConfig | null;
const readGitConfig: GitConfigReader = (dir) => {
  // In English whatever the user's locale: "not a git repository" is matched below.
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANGUAGE: '' } });
  const top = git('rev-parse', '--show-toplevel');
  // A repository whose config cannot be read in full is refused, never protected less (story review).
  const unread = (what: string) => new Error(`Airlock could not read git's config for ${dir} (${what}), so it cannot protect what that config runs. Nothing was launched.`);
  // Null only for no git, or no repository; anything else (a broken config git reads first) refuses.
  if (top.error && (top.error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  if (top.status !== 0) {
    // A .git file pointing at no repository is none (Linux's git says so in other words than macOS's).
    if (/not a git repository|gitfile does not point to a valid repository/i.test(top.stderr ?? '')) return null;
    throw unread((top.stderr || top.error?.message || 'git failed').trim());
  }
  // git expands the paths (`--type=path`); --get-regexp exits 1 when nothing matches.
  const list = git('config', '-z', '--show-origin', '--type=path', '--get-regexp', '^(include\\.path|includeif\\..*\\.path)$');
  const hooks = git('config', '-z', '--show-origin', '--includes', '--type=path', '--get-regexp', '^core\\.hookspath$');
  const included = git('config', '--list', '--show-origin', '--includes', '-z');
  if (![0, 1].includes(list.status ?? -1) || ![0, 1].includes(hooks.status ?? -1) || included.status !== 0) throw unread((list.stderr || hooks.stderr || included.stderr || 'git failed').trim());
  // Every file an include names, in effect now or not (an includeIf can come into effect during a
  // session: onbranch), and the includes inside those: their entries, and their includes (story review).
  let lists = list.stdout;
  let entries = included.stdout;
  const seen = new Set<string>();
  const queue = configEntries(list.stdout).map((e) => ({ origin: e.origin, value: e.value }));
  while (queue.length && seen.size < 64) {
    const e = queue.shift()!;
    const from = e.origin.startsWith('file:') ? path.dirname(path.resolve(dir, e.origin.slice(5))) : dir;
    const file = path.resolve(from, e.value);
    if (!e.value || seen.has(file) || kindOfPath(file) !== 'file') continue;
    seen.add(file);
    const own = git('config', '--file', file, '--list', '--show-origin', '-z');
    const nested = git('config', '--file', file, '-z', '--show-origin', '--type=path', '--get-regexp', '^(include\\.path|includeif\\..*\\.path)$');
    if (own.status !== 0 || ![0, 1].includes(nested.status ?? -1)) throw unread(`${file}: ${(own.stderr || nested.stderr || 'git failed').trim()}`);
    entries += own.stdout;
    lists += nested.stdout;
    queue.push(...configEntries(nested.stdout).map((n) => ({ origin: n.origin, value: n.value })));
  }
  if (queue.length) throw unread('over 64 included files');
  return { list: lists, included: entries, hooks: hooks.stdout, top: top.stdout.trim() || null };
};

/** `origin NUL key NEWLINE value NUL` entries of `git config --list --show-origin -z`. */
function configEntries(out: string): Array<{ origin: string; key: string; value: string }> {
  const parts = out.split('\0');
  const entries: Array<{ origin: string; key: string; value: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const nl = parts[i + 1].indexOf('\n');
    entries.push({
      origin: parts[i],
      key: (nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl)).toLowerCase(),
      value: nl < 0 ? '' : parts[i + 1].slice(nl + 1),
    });
  }
  return entries;
}


/**
 * Config keys whose value is a command line host git runs: the ones git documents, and any key named
 * like one (a driver's command, helper, program...) - wider than needed rather than one short.
 */
const GIT_PROGRAM_KEY = /^(core\.(fsmonitor|sshcommand|gitproxy|pager|editor|askpass|alternaterefscommand)|diff\.external|sequence\.editor|interactive\.difffilter|uploadpack\.packobjectshook|(pager|alias)\..+|.+\.(textconv|command|cmd|driver|clean|smudge|process|helper|program|uploadpack|receivepack))$/;

/**
 * The words of a shell command line, quotes and escapes removed, split at operators too; an
 * assignment (`FOO=tools/x`) stands for its value.
 */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let any = false;
  let quote: string | null = null;
  const push = () => {
    if (any) {
      const assigned = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(cur);
      words.push(assigned ? assigned[1] : cur);
    }
    cur = '';
    any = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      any = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      any = true;
    } else if (/[\s;&|()<>`!]/.test(c)) push();
    else {
      cur += c;
      any = true;
    }
  }
  push();
  return words;
}

/**
 * What a command-valued config entry may run from the working tree, failing closed: every word of it
 * that names a path (relative ones from the top of the working tree, where git runs them) - one
 * holding a slash whether or not it exists, a bare word when a file by that name is there. Words
 * holding an expansion (`$`, backquotes) are passed over, and what the programs read in turn is not
 * followed: both accepted limits (user decision 2026-10-30).
 */
function gitProgramPaths(value: string, top: string): string[] {
  const paths: string[] = [];
  for (const w of shellWords(value)) {
    if (!w || w.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) continue;
    const p = path.resolve(top, w.replace(/^~(?=\/|$)/, os.homedir()));
    // A quoted word with spaces in it: a path when there is one by that name, else a command line
    // of its own (`sh -c '...'`), whose words are taken in turn.
    if (/[\s;&|()<>]/.test(w) && !kindOfPath(p)) paths.push(...gitProgramPaths(w, top));
    // An expansion names nothing a scan can know: computed commands are an accepted limit (user
    // decision 2026-10-30, story review).
    else if (/[$`]/.test(w)) continue;
    else if (w.includes('/') || kindOfPath(p) === 'file') paths.push(p);
  }
  return paths;
}

/**
 * What git's own config makes part of what host git runs in `dir`: the files config was read from,
 * every file an include names (active or not, holding anything or not), the hooks directory
 * core.hooksPath names, and the programs config entries name by path (fsmonitor, textconv,
 * credential helpers, `!` aliases...: story review). Paths, absolute.
 */
function gitConfigDependencies(dir: string, read: GitConfigReader): { files: string[]; includes: string[]; hooksPaths: string[]; programs: Array<{ key: string; path: string }> } {
  const cfg = read(dir);
  if (!cfg) return { files: [], includes: [], hooksPaths: [], programs: [] };
  const files: string[] = [];
  const includes: string[] = [];
  const hooksPaths: string[] = [];
  const programs: Array<{ key: string; path: string }> = [];
  const originFile = (origin: string) => (origin.startsWith('file:') ? path.resolve(dir, origin.slice(5)) : null);
  for (const e of configEntries(cfg.included)) {
    const f = originFile(e.origin);
    if (f) files.push(f);
    // An alias is a program only when it is a shell command (`!`); else it is a git subcommand,
    // whose `-c key=value` options can name one all the same.
    const top = cfg.top ?? dir;
    const add = (key: string, value: string) => programs.push(...gitProgramPaths(value, top).map((p) => ({ key, path: p })));
    if (e.key.startsWith('alias.') && !e.value.trim().startsWith('!')) {
      const words = shellWords(e.value);
      for (let i = 0; i < words.length - 1; i++) {
        const set = words[i] === '-c' ? /^([^=]+)=(.*)$/s.exec(words[i + 1]) : null;
        if (set && GIT_PROGRAM_KEY.test(set[1].toLowerCase())) add(`${e.key} -c ${set[1]}`, set[2]);
      }
    } else if (GIT_PROGRAM_KEY.test(e.key)) add(e.key, e.value);
  }
  // Paths come expanded by git (`~`, `~user`); one still relative is read as git reads it: a hooks
  // path from the top of the working tree, an include from the directory of the file naming it.
  for (const e of configEntries(cfg.hooks)) {
    if (e.key === 'core.hookspath' && e.value) hooksPaths.push(path.resolve(cfg.top ?? dir, e.value));
  }
  // And one an include not in effect now sets (unexpanded there: `~` is expanded here).
  for (const e of configEntries(cfg.included)) {
    if (e.key === 'core.hookspath' && e.value) hooksPaths.push(path.resolve(cfg.top ?? dir, e.value.replace(/^~(?=\/|$)/, os.homedir())));
  }
  for (const e of configEntries(cfg.list)) {
    const f = originFile(e.origin);
    if (f && e.value && (e.key === 'include.path' || /^includeif\..*\.path$/.test(e.key))) includes.push(path.resolve(path.dirname(f), e.value));
  }
  return { files: [...new Set(files)], includes: [...new Set(includes)], hooksPaths: [...new Set(hooksPaths)], programs };
}

/** Every entry named `.git` below `dir` (not `dir`'s own), skipping SEARCH_SKIP and the insides of git dirs. */
function nestedGitEntries(dir: string): string[] {
  const found: string[] = [];
  let seen = 0;
  const visit = (d: string, depth: number) => {
    if (++seen > ALIAS_SCAN_LIMIT) throw new Error(`Airlock could not look for git repositories in ${dir} (over ${ALIAS_SCAN_LIMIT} directories), so nothing was launched.`);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.name === '.git') {
        if (depth > 0) found.push(p);
        continue;
      }
      if (e.isDirectory() && !SEARCH_SKIP.has(e.name)) visit(p, depth + 1);
    }
  };
  visit(dir, 0);
  return found;
}

/** The platform dirs of every package below `dir`, not looking inside node_modules or a dot-directory. */
function platformDirsIn(dir: string, depth = 0): string[] {
  if (depth > SEARCH_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  const found = PLATFORM_DIRS.filter((d) => d.markers.some((m) => files.has(m))).map((d) => path.join(dir, d.dir));
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') found.push(...platformDirsIn(path.join(dir, e.name), depth + 1));
  }
  return found;
}

/**
 * Where the workspace's lockfile says its installer writes: npm's `packages` keys, pnpm's
 * importers. These reach what the walk does not (a workspace in a dot-directory, or deeper).
 * Only paths inside the workspace; the lockfile is the session's to write.
 */
function lockfileDestinations(workspace: string): { dests: string[]; incomplete?: string } {
  const out: string[] = [];
  let incomplete: string | undefined;
  const add = (rel: string) => {
    const p = path.resolve(workspace, rel);
    if (inside(p, workspace) && p !== workspace) out.push(p);
  };
  const json = (name: string): unknown => {
    try { return JSON.parse(readRegularFile(path.join(workspace, name), MAX_LOCKFILE)?.toString('utf8') ?? 'null'); } catch { return null; }
  };
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const lock = json(name);
    const packages = (lock as { packages?: unknown } | null)?.packages;
    if (!packages || typeof packages !== 'object') continue;
    for (const key of Object.keys(packages)) {
      const i = `/${key}`.indexOf('/node_modules/');
      if (i >= 0) add(`${key.slice(0, i)}${i ? '/' : ''}node_modules`);
    }
  }
  const yaml = readRegularFile(path.join(workspace, 'pnpm-lock.yaml'), MAX_LOCKFILE)?.toString('utf8') ?? '';
  let importers = false;
  for (const line of yaml.split('\n')) {
    if (/^\S/.test(line)) importers = /^importers:\s*$/.test(line);
    const m = importers ? /^ {2}(['"]?)([^'":\s][^'":]*)\1:\s*$/.exec(line) : null;
    if (m) add(path.join(m[2], 'node_modules'));
  }
  // package.json workspaces (yarn's, and npm's): a literal path, or `*` for one directory level.
  const manifest = json('package.json') as { workspaces?: unknown } | null;
  const ws = manifest?.workspaces;
  const patterns = Array.isArray(ws) ? ws : Array.isArray((ws as { packages?: unknown })?.packages) ? (ws as { packages: unknown[] }).packages : [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    // `*` alone is one directory level; anything else with a wildcard (`**`, `pkg-*`, a brace) is beyond this.
    if (pattern.split('/').some((seg) => seg !== '*' && /[*?[{]/.test(seg))) {
      incomplete ??= `its workspace pattern "${pattern}" is one Airlock cannot follow`;
      continue;
    }
    let dirs = [workspace];
    for (const seg of pattern.split('/').filter((x) => x && x !== '.')) {
      dirs = seg === '*'
        ? dirs.flatMap((d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(d, e.name)); } catch { return []; } })
        : dirs.map((d) => path.join(d, seg));
    }
    for (const d of dirs) if (kindOfPath(path.join(d, 'package.json')) === 'file') add(path.relative(workspace, path.join(d, 'node_modules')));
  }
  return { dests: out, incomplete };
}

/** Is any directory from `dir` up to (not including) `top` a symbolic link? */
function linkedBelow(dir: string, top: string): boolean {
  for (let a = dir; a !== top && inside(a, top); a = path.dirname(a)) {
    try { if (fs.lstatSync(a).isSymbolicLink()) return true; } catch { return true; }
  }
  return false;
}

/** What installs the workspace's dependencies in the guest, from which lockfile, or null when it has none. */
export function platformInstallOf(workspace: string): { lockfile: string; hash: string; command: string[] } | null {
  for (const i of INSTALLERS) {
    const lockfile = path.join(workspace, i.lockfile);
    const content = readRegularFile(lockfile, MAX_LOCKFILE);
    if (!content) continue;
    return { lockfile, hash: crypto.createHash('sha256').update(content).digest('hex'), command: i.command };
  }
  return null;
}

/**
 * Run as `sh -c SCRIPT <stamp> <lockfile hash> <command...>` in the workspace: installs unless the
 * stamp holds the hash. The stamp goes before the install (one that fails half way leaves none) and
 * comes back, by rename, only once it succeeded. Only a regular file is read: the stamps dir is the
 * session user's, and a FIFO planted there would block the read.
 */
export const PLATFORM_INSTALL_SCRIPT = 'stamp="$0"; hash="$1"; shift; '
  + '[ -f "$stamp" ] && [ ! -L "$stamp" ] && [ "$(head -c 128 "$stamp")" = "$hash" ] && exit 0; '
  + 'rm -f "$stamp"; "$@" || exit $?; '
  + 'tmp=$(mktemp "$stamp.XXXXXX") && printf \'%s\\n\' "$hash" > "$tmp" && mv -f "$tmp" "$stamp"';

/**
 * Run by root as `sh -c CONTAINED_INSTALL <cgroup> <uid> <gid> <script> <args...>` (story review 3):
 * the install runs the repository's lifecycle scripts, one of which may daemonize. A child moves
 * itself into a cgroup of its own, then becomes the session user and runs `sh -c <script> <args>`;
 * once that ends, everything still in the cgroup is killed. Root's shell stays outside it. A cgroup
 * that cannot be made runs nothing (125); the install's own status is kept.
 */
export const CONTAINED_INSTALL = 'G="$0"; u="$1"; g="$2"; s="$3"; shift 3; mkdir -p "$G" || exit 125; '
  + 'sh -c \'echo $$ > "$0/cgroup.procs" || exit 125; exec "$@"\' "$G" setpriv --reuid="$u" --regid="$g" --clear-groups -- sh -c "$s" "$@"; rc=$?; '
  + 'echo 1 > "$G/cgroup.kill" || exit 125; i=0; until grep -q "^populated 0" "$G/cgroup.events"; do [ $i -lt 50 ] || exit 125; sleep 0.1; i=$((i+1)); done; '
  + 'rmdir "$G" 2>/dev/null; exit $rc';

/**
 * Root's, after the install exec settles however it ended (`sh -c KILL_INSTALL_CGROUP <cgroup>`):
 * a timeout kills CONTAINED_INSTALL before its own cleanup. Fails unless the cgroup is gone or
 * emptied and removed.
 */
export const KILL_INSTALL_CGROUP = 'G="$0"; [ -d "$G" ] || exit 0; echo 1 > "$G/cgroup.kill" || exit 1; i=0; '
  + 'until grep -q "^populated 0" "$G/cgroup.events"; do [ $i -lt 50 ] || exit 1; sleep 0.1; i=$((i+1)); done; rmdir "$G"';

/** How long the guest's install may take: it runs under the machine's lock. */
export const INSTALL_TIMEOUT = '600s';
/** The largest lockfile read: the session writes it, and the launcher reads it on the host. */
const MAX_LOCKFILE = 64 * 1024 * 1024;
/** The largest client config read (OpenCode's): the host user's file, read on every launch. */
const MAX_CLIENT_CONFIG = 1024 * 1024;

/**
 * A linked worktree's git metadata (CGLAB-696 task 7): its .git file names its git dir, which
 * names (commondir) the repository's common git dir, and sits in that dir's worktrees/. Null when
 * the workspace's .git is not such a file; a throw when it is one that does not lead back.
 */
export function linkedWorktreeGit(workspace: string): { gitDir: string; common: string; name: string } | null {
  const dotGit = path.join(workspace, '.git');
  let st: fs.Stats;
  try { st = fs.lstatSync(dotGit); } catch { return null; }
  if (!st.isFile()) return null;
  const refuse = (why: string): never => {
    throw new Error(`Airlock cannot run in this linked git worktree (${workspace}): ${why}. Nothing was launched.`);
  };
  const pointer = /^gitdir: (.+)$/m.exec(readRegularFile(dotGit, 4096)?.toString('utf8') ?? '')?.[1]?.trim();
  if (!pointer) refuse('its .git file names no git dir');
  let gitDir: string;
  let common: string;
  try {
    const named = path.resolve(workspace, pointer!);
    gitDir = fs.realpathSync(named);
    // Git follows the pointer as written on every run: a link anywhere on its way could be repointed
    // once checked (review 01a18d52). The same for the commondir it names.
    if (gitDir !== named) throw new Error(`${named} runs through a symbolic link`);
    const commondir = readRegularFile(path.join(gitDir, 'commondir'), 4096)?.toString('utf8').trim();
    if (!commondir) throw new Error('it has no commondir');
    const namedCommon = path.resolve(gitDir, commondir);
    common = fs.realpathSync(namedCommon);
    if (common !== namedCommon) throw new Error(`${namedCommon} runs through a symbolic link`);
  } catch (e) {
    return refuse(`its git dir cannot be followed back to its repository (${(e as Error)?.message ?? e})`);
  }
  // Its git dir is the one the common dir keeps for it: nothing else would be mounted for git.
  if (path.dirname(gitDir!) !== path.join(common!, 'worktrees') || !fs.statSync(common!).isDirectory()) {
    refuse(`its git dir ${gitDir!} is not one of ${path.join(common!, 'worktrees')}`);
  }
  // A repository whose git dir lives apart (--separate-git-dir): its main checkout, whose config
  // host git also reads, cannot be found from here, so what that config pulls in cannot be protected.
  if (path.basename(common!) !== '.git') refuse(`its repository keeps its git dir apart (${common!}), and its main checkout cannot be found to protect what its config pulls in`);
  // And it names this worktree back (another worktree's would make its metadata this one's).
  const back = readRegularFile(path.join(gitDir!, 'gitdir'), 4096)?.toString('utf8').trim();
  let backReal: string | null = null;
  try { backReal = back ? fs.realpathSync(path.resolve(gitDir!, back)) : null; } catch { /* names nothing */ }
  if (backReal !== fs.realpathSync(dotGit)) refuse(`its git dir ${gitDir!} belongs to another worktree (${back ?? 'it names none'})`);
  // Linked parts would let what is mounted move: the pointer's git dir and the common dir are real directories.
  for (const p of [gitDir!, common!]) if (fs.lstatSync(p).isSymbolicLink()) refuse(`${p} is a symbolic link`);
  return { gitDir, common, name: path.basename(gitDir) };
}

export function guestPlanOf(spec: SandboxSpec, workspace: string, readConfig: GitConfigReader = readGitConfig, holding: ReadonlySet<string> = new Set()): GuestPlan {
  // A placeholder the machine already holds is planned as what it stands for: missing. So a session
  // joining plans what the first one did.
  const kindOf = (p: string): Kind => (holding.has(p) ? null : kindOfPath(p));
  const privateTemp = new Set((spec.filesystem.privateTemp ?? []).map((p) => path.resolve(p)));
  const candidates = spec.filesystem.allowWrite.map((p) => path.resolve(p)).filter((p) => !privateTemp.has(p) && kindOf(p) === 'dir');
  // Outer roots first; a root inside one already mounted comes through it.
  const roots: string[] = [];
  for (const p of [...new Set(candidates)].sort((a, b) => a.length - b.length)) {
    if (!roots.some((r) => inside(p, r))) roots.push(p);
  }
  // A linked worktree: the repository's common git dir is mounted too, for git in the guest.
  const linked = linkedWorktreeGit(workspace);
  if (linked && !roots.some((r) => inside(linked.common, r))) roots.push(linked.common);
  const mounted = (p: string) => roots.some((r) => inside(p, r));
  // A mount the denies cannot be applied inside: the home itself (or above it) would put all of
  // it in the guest read-write, and a root that is (or is in) a protected path would leave that
  // path writable, a bind on a mount root being no protection.
  const home = spec.home ? path.resolve(spec.home) : null;
  // A pattern's directory guards like a path (`~/.ssh/id_*` guards ~/.ssh); `<workspace>/**` names nothing to guard.
  const guarded = [...spec.filesystem.denyWrite, ...spec.filesystem.denyRead]
    .flatMap((p) => (!/[*?]/.test(p) ? [p] : lastSegmentGlob(p) ? [lastSegmentGlob(p)!.dir] : []))
    .map((p) => path.resolve(p));
  for (const r of roots) {
    if (home && inside(home, r)) throw new Error(`Airlock will not mount ${r}: it holds the whole home folder. Launch it from a project folder. Nothing was launched.`);
    const over = guarded.find((g) => inside(r, g));
    if (over) throw new Error(`Airlock will not mount ${r}: it is inside ${over}, which the session may not write. Launch it from a project folder. Nothing was launched.`);
  }

  const readOnly: string[] = [];
  const pinned: string[] = [];
  const placeholders: Placeholder[] = [];
  const dotGit = path.resolve(workspace, '.git');
  const gitKind = mounted(dotGit) ? kindOf(dotGit) : null;
  // A linked worktree's pointer names the git dir host git uses: read-only. Its own git dir stays
  // writable (index, HEAD), pinned with the common dir; what else names git config is protected.
  const writable: string[] = [];
  const worktreeHeld: string[] = [];
  const worktreesHidden: string[] = [];
  if (gitKind === 'file' && linked) {
    readOnly.push(dotGit);
    pinned.push(linked.common);
    writable.push(linked.gitDir);
    // Everything in the common dir host git reads config, hooks or another repository from (held
    // when missing), and the main checkout's own index, HEAD and reflog (only when there: a held
    // index would be a directory); objects and refs stay writable, as a main checkout's do.
    worktreeHeld.push(...[...GIT_PROTECTED, 'worktrees', 'commondir', 'config.worktree', 'info', 'modules'].map((n) => path.join(linked.common, n)),
      ...['index', 'HEAD', path.join('logs', 'HEAD')].map((n) => path.join(linked.common, n)).filter((f) => kindOfPath(f)),
      ...['commondir', 'gitdir', 'config.worktree'].map((n) => path.join(linked.gitDir, n)));
    // The other worktrees' metadata is theirs.
    for (const name of fs.readdirSync(path.join(linked.common, 'worktrees'))) {
      if (name !== linked.name) worktreesHidden.push(path.join(linked.common, 'worktrees', name));
    }
  }
  if (gitKind === 'dir') pinned.push(dotGit);
  // No repository here: an empty, read-only .git keeps one from being planted for host git (which
  // passes over an empty .git, measured), for as long as a session runs.
  if (!gitKind && roots.includes(workspace)) {
    placeholders.push({ path: dotGit, kind: 'dir' });
    readOnly.push(dotGit);
  }
  const held = [...spec.filesystem.denyWrite, ...(gitKind === 'dir' ? GIT_PROTECTED.map((p) => path.join(dotGit, p)) : []), ...worktreeHeld];
  // Repositories below the workspace: their metadata is protected as the top one's is, and a
  // pointer file (a submodule's) can never be redirected.
  const repos = [workspace];
  for (const g of nestedGitEntries(workspace)) {
    if (!mounted(g)) continue;
    // A pointer file (or a link, which the symbolic-link check below refuses).
    if (kindOfPath(g) === 'file') {
      readOnly.push(g);
      // A link is refused below (the session could replace the link itself): only a file is read.
      if (fs.lstatSync(g).isFile()) checkPointer(g);
    } else {
      pinned.push(g);
      held.push(...NESTED_GIT_PROTECTED.map((n) => path.join(g, n)));
    }
    repos.push(path.dirname(g));
  }
  function checkPointer(g: string): void {
    // Its git dir, as git reaches it, must be where the session cannot make or change a repository -
    // hooks and all: outside the mounts, or under what is held (a submodule's, in the git dir's
    // modules). One git takes for none (missing, empty) is no exception, and a link on its way the
    // session could repoint is refused whatever it leads to now: git follows the pointer on every run.
    const pointer = gitfilePointer(g);
    if (!pointer) throw new Error(`Airlock cannot read the git pointer ${g} as git does (no "gitdir: ", or too large), so it cannot protect what it names. Nothing was launched.`);
    // Inside the mounts, only a submodule's or a linked worktree's place is safe: under a git dir's
    // modules or worktrees (a worktree checked out inside the workspace: BUG 9bdd4d45), protected as
    // named (no pattern: `**` is a name too), and read-only by the deepest bind holding it - a linked
    // worktree's own git dir is bound writable again (review).
    const modules = held.map((h) => path.resolve(h)).filter((h) => ['modules', 'worktrees'].includes(path.basename(h)) && !/[*?[\]{}]/.test(h));
    const covered = (t: string) => modules.some((m) => inside(t, m)) && underReadOnly(t, modules, writable);
    const reached = walkPointer(path.dirname(g), pointer, (l) => !mounted(l));
    if ('refused' in reached) {
      throw new Error(`Airlock cannot protect the repository the git pointer ${g} names: ${reached.refused}. Nothing was launched.`);
    }
    if ('link' in reached) {
      throw new Error(`Airlock cannot protect the repository the git pointer ${g} names: ${reached.link} on its way is a link the session could repoint. Nothing was launched.`);
    }
    if (mounted(reached.path) && !covered(reached.path)) {
      throw new Error(`Airlock cannot protect ${reached.path}: the git pointer ${g} names it as its repository, and the session could make or change one there that host git would run. Nothing was launched.`);
    }
  }
  // What git's config adds to what host git runs, read wherever host git may run (git finds the
  // repository above a workspace with none of its own): the config files, the files includes name,
  // and the hooks dir.
  // A linked worktree's main checkout: what its own config (its config.worktree too) pulls in is
  // in the mounted common dir, and host git reads it there (review 01a18d52).
  if (linked && path.basename(linked.common) === '.git' && kindOfPath(path.dirname(linked.common)) === 'dir') repos.push(path.dirname(linked.common));
  for (const repo of repos) {
    const git = gitConfigDependencies(repo, readConfig);
    for (const p of [...git.hooksPaths, ...git.includes]) {
      if (mounted(p) && !kindOfPath(p)) {
        throw new Error(`Airlock cannot protect ${p}: git's config (core.hooksPath or an include) names it, it does not exist, and the session could create it. Nothing was launched.`);
      }
    }
    for (const prog of git.programs) {
      if (mounted(prog.path) && !kindOfPath(prog.path)) {
        throw new Error(`Airlock cannot protect ${prog.path}: git's config (${prog.key}) names it as a program to run, it does not exist, and the session could create it. Nothing was launched.`);
      }
    }
    held.push(...[...git.files, ...git.includes, ...git.hooksPaths, ...git.programs.map((prog) => prog.path)].filter((f) => mounted(f)));
  }
  const existing = WORKSPACE_PROTECTED.map((p) => path.join(workspace, p));
  for (const p of [...new Set([...held, ...existing].flatMap(expand).map((x) => path.resolve(x)))]) {
    if (!mounted(p) || roots.includes(p) || readOnly.includes(p)) continue;
    if (kindOf(p)) {
      readOnly.push(p);
      continue;
    }
    // Held only directly in a mount root, the pinned .git or a writable bind (a worktree's git dir):
    // the guest cannot swap any of them for a link while a session runs (each is a mount point), so
    // creating the placeholder cannot be steered out of the mounts.
    const parent = path.dirname(p);
    if (!held.some((h) => path.resolve(h) === p) || !(roots.includes(parent) || pinned.includes(parent) || writable.includes(parent))) continue;
    const base = path.basename(p);
    placeholders.push(base in FILE_PLACEHOLDERS ? { path: p, kind: 'file', content: FILE_PLACEHOLDERS[base] } : { path: p, kind: 'dir' });
    readOnly.push(p);
  }

  // What a protected tree links to is protected with it, and what that links to, to a fixed point.
  for (const queue = [...readOnly]; queue.length;) {
    const p = queue.shift() as string;
    if (!kindOf(p)) continue;
    for (const t of aliasesIn(p, mounted, readOnly, writable)) {
      if (roots.includes(t)) throw new Error(`Airlock cannot protect what ${p} links to: ${t} is a whole write root of the session. Nothing was launched.`);
      if (!readOnly.includes(t)) {
        readOnly.push(t);
        queue.push(t);
      }
    }
  }
  // Every directory between a protected path and its mount root is pinned too: renaming one would
  // carry the read-only bind away with it and leave its old place free to plant (the guest cannot
  // rename a pinned directory, so the session cannot move those either).
  for (const p of [...readOnly]) {
    const root = roots.find((r) => inside(p, r)) as string;
    for (let a = path.dirname(p); a !== root && inside(a, root); a = path.dirname(a)) {
      // One that is read-only, or inside one, cannot be renamed already: a pin there would only
      // take the place of its read-only bind.
      // A writable bind below a read-only one gives renaming back: underReadOnly (review 01a18d52).
      if (!pinned.includes(a) && !underReadOnly(a, readOnly, writable)) pinned.push(a);
    }
  }
  // A bind follows a link: it would protect the target and leave the link itself replaceable.
  for (const p of [...pinned, ...readOnly]) {
    if (kindOf(p) && fs.lstatSync(p).isSymbolicLink()) {
      throw new Error(`Airlock cannot protect ${p}: it is a symbolic link, and the session could replace the link itself. Nothing was launched.`);
    }
  }
  // Outer first: a bind over a directory hides the binds already inside it.
  const outerFirst = (a: string, b: string) => a.split(path.sep).length - b.split(path.sep).length;
  pinned.sort(outerFirst);
  readOnly.sort(outerFirst);

  const hidden: GuestPlan['hidden'] = [];
  for (const p of [...new Set(spec.filesystem.denyRead.flatMap(expand).map((x) => path.resolve(x)))]) {
    const kind = kindOf(p);
    if (!kind || !mounted(p) || roots.includes(p)) continue;
    // Hiding a link hides its target under the link's name only, and nothing of the target's other names.
    if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`Airlock cannot hide ${p}: it is a symbolic link. Nothing was launched.`);
    // Hiding a name hides nothing of a file that has another one.
    const linked = hardLinkedIn(p);
    if (linked) throw new Error(`Airlock cannot hide ${linked}: it has another name (a hard link), which the session could read it by. Nothing was launched.`);
    hidden.push({ path: p, kind });
  }
  for (const p of worktreesHidden) {
    if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`Airlock cannot hide ${p}: it is a symbolic link. Nothing was launched.`);
    hidden.push({ path: p, kind: kindOfPath(p) === 'file' ? 'file' : 'dir' });
  }

  const platform: GuestPlan['platform'] = [];
  const fromLockfiles = lockfileDestinations(workspace);
  const destinations = [...new Set([...platformDirsIn(workspace), ...fromLockfiles.dests])];
  for (const p of destinations) {
    // A destination whose package is not in the checkout has nothing to bind onto, and one reached
    // through a link is not taken: root's bind in the guest would follow it. Nor one inside another:
    // its path in the guest runs through that one's store, which the session fills.
    if (!mounted(p) || kindOfPath(path.dirname(p)) !== 'dir' || linkedBelow(path.dirname(p), workspace)) continue;
    if (destinations.some((q) => q !== p && inside(p, q))) continue;
    const kind = kindOf(p);
    if (kind && fs.lstatSync(p).isSymbolicLink()) {
      throw new Error(`Airlock cannot give the guest its own ${p}: it is a symbolic link, and the guest's copy would be bound where it points. Nothing was launched.`);
    }
    if (kind === 'file') throw new Error(`Airlock cannot give the guest its own ${p}: it is a file, not a directory. Nothing was launched.`);
    if (!kind) placeholders.push({ path: p, kind: 'dir' });
    platform.push({ path: p, store: `${GUEST_PLATFORM_ROOT}/${hash16(p)}` });
  }

  return {
    mounts: roots.map((r) => ({ host: r, guest: r, readOnly: false as const })), pinned, writable, readOnly, hidden, placeholders, platform,
    ...(fromLockfiles.incomplete ? { platformIncomplete: fromLockfiles.incomplete } : {}),
  };
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * `rootdir <dir>`: makes `dir` where only root can change it, or fails (review, DEL-1): every part
 * of it that exists must be a directory root owns that nobody else may write - not a link - and the
 * parts missing are made by root. Nothing on its path can then be swapped while root works in it.
 * Split on "/" alone, globbing off: a name with spaces or `*` in it is that name.
 */
export const ROOTDIR_FN = 'rootdir() ( set -f; IFS=/; P=""; for c in $1; do [ -n "$c" ] || continue; P="$P/$c"; '
  + 'if [ -L "$P" ]; then echo "$P is a link" >&2; exit 1; fi; '
  + 'if [ -e "$P" ]; then [ -d "$P" ] && [ "$(stat -c %u "$P")" = 0 ] && [ $(( 0$(stat -c %a "$P") & 022 )) -eq 0 ] || { echo "$P is not root\'s alone" >&2; exit 1; }; '
  + 'else mkdir -m 755 "$P"; fi; done )';

/** `mounted <mountinfo path>`: is something mounted there? (sh, for root's scripts in the guest) */
const MOUNTED_FN = `mounted() { P="$1" awk '$5 == ENVIRON["P"] { f = 1 } END { exit !f }' /proc/self/mountinfo; }`;
/** How /proc/self/mountinfo spells a path. */
const mountinfoPath = (p: string): string => p.replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011').replace(/\n/g, '\\012');

const GUEST_RUN = '/run/agenfk';
const GUEST_SESSIONS = `${GUEST_RUN}/sessions`;
/** Root's marks of sessions reaped: one stays, so a leader that comes late runs nothing (SESSION_LEADER). */
const GUEST_REAPED = `${GUEST_RUN}/reaped`;
const GUEST_HIDE = `${GUEST_RUN}/hide`;
/** bin/agenfk-airlock.mjs's MACHINE_MARKER. */
const GUEST_MACHINE_MARKER = `${GUEST_RUN}/machine`;
/** The session user's: which lockfile each workspace was last installed from, and the package managers' caches. */
const GUEST_PLATFORM_STAMPS = `${GUEST_PLATFORM_ROOT}/stamps`;
const GUEST_PLATFORM_CACHE = `${GUEST_PLATFORM_ROOT}/cache`;

/** The root script that applies the plan in the guest. Idempotent: a second session runs it again. */
/** Where the guest finds the host's trusted roots and the machine's CA together. */
export const GUEST_CA_BUNDLE = '/run/agenfk/ca-bundle.pem';
/** The env vars clients read a CA bundle from. */
const CA_BUNDLE_ENV = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'];

/**
 * The root lines binding each platform dir from its store. Only where the guest resolves the path to
 * itself: nothing runs in the guest yet, but a store keeps what the session left in it, and root's
 * bind would follow a link there.
 */
export function platformBindLines(platform: GuestPlan['platform'], uid: number, gid: number): string[] {
  return platform.map((d) => `mkdir -p ${quote(d.store)}; chown ${uid}:${gid} ${quote(d.store)}; `
    + `if [ -d ${quote(d.path)} ] && [ "$(readlink -f ${quote(d.path)})" = ${quote(d.path)} ]; then mounted ${quote(mountinfoPath(d.path))} || mount --bind ${quote(d.store)} ${quote(d.path)}; fi`);
}

export function guestSetupScript(plan: GuestPlan, uid: number, gid: number, caPem?: string, home = '/'): string {
  // A home a passwd line cannot hold is left out of it (the session's HOME is set either way).
  const pwHome = /^\/[^:\n]*$/.test(home) ? home : '/';
  const lines = [
    'set -e',
    MOUNTED_FN,
    // Hidden means a tmpfs over the path: a mount of any other kind there (a read-only bind) is not.
    `hidden() { P="$1" awk '$5 == ENVIRON["P"] { for (i = 7; i < NF; i++) if ($i == "-") { if ($(i + 1) == "tmpfs") f = 1; break } } END { exit !f }' /proc/self/mountinfo; }`,
    // Recursive binds: a pin or read-only bind made over a directory carries the mounts inside it.
    'pin() { mounted "$2" || mount --rbind "$1" "$1"; }',
    // Read-only even when already a mount (an earlier session's): the remount is what protects.
    'ro() { mounted "$2" || mount --rbind "$1" "$1"; mount -o remount,bind,ro "$1"; }',
    // Writable again below a read-only one (after it: deeper paths come later).
    'rw() { mounted "$2" || mount --rbind "$1" "$1"; mount -o remount,bind,rw "$1"; }',
    `hide_file() { hidden "$2" || { mount --bind ${GUEST_HIDE}/empty "$1"; mount -o remount,bind,ro "$1"; }; }`,
    'hide_dir() { hidden "$2" || mount -t tmpfs -o ro,size=4k,mode=000 tmpfs "$1"; }',
    // The session's uid is the host user's, which the image does not know: ssh refuses a user it cannot look up.
    `getent group ${gid} >/dev/null || echo ${quote(`agenfk:x:${gid}:`)} >> /etc/group`,
    `getent passwd ${uid} >/dev/null || echo ${quote(`agenfk:x:${uid}:${gid}:AgEnFK session:${pwHome}:/bin/sh`)} >> /etc/passwd`,
    `mkdir -p ${GUEST_SESSIONS} ${GUEST_HIDE} ${GUEST_REAPED}`,
    `chown 0:0 ${GUEST_RUN} ${GUEST_REAPED}`,
    `chmod 755 ${GUEST_RUN} ${GUEST_REAPED}`,
    `chown ${uid}:${gid} ${GUEST_SESSIONS}`,
    `chmod 700 ${GUEST_SESSIONS}`,
    // The machine's mark, which the agenfk adapters prove they run in a machine by (CGLAB-696
    // task 9): root's, in a directory only root writes.
    `printf 'smolvm\\n' > ${GUEST_MACHINE_MARKER}.tmp`,
    `chmod 444 ${GUEST_MACHINE_MARKER}.tmp`,
    `mv -f ${GUEST_MACHINE_MARKER}.tmp ${GUEST_MACHINE_MARKER}`,
    // The file hidden files are bound to, on a tmpfs of its own: {} - an empty JSON object, which a
    // client reads as no logins where an empty file could be a broken one (pi's auth.json).
    `hidden ${GUEST_HIDE} || { mount -t tmpfs -o size=4k,mode=0755 tmpfs ${GUEST_HIDE}; printf '{}\\n' > ${GUEST_HIDE}/empty; chmod 444 ${GUEST_HIDE}/empty; mount -o remount,ro ${GUEST_HIDE}; }`,
    // The host's trusted roots (smolvm's --trust-host-certs bundle, else the image's), and the
    // machine's CA, whose certificates the key injector presents. Public: no key is in it.
    ...(caPem ? [
      `{ cat /etc/smolvm-host-trust/ca-bundle.pem 2>/dev/null || cat /etc/ssl/certs/ca-certificates.crt 2>/dev/null || true; printf '%s\\n' ${quote(caPem.trim())}; } > ${GUEST_CA_BUNDLE}.tmp`,
      `chmod 444 ${GUEST_CA_BUNDLE}.tmp`,
      `mv ${GUEST_CA_BUNDLE}.tmp ${GUEST_CA_BUNDLE}`,
    ] : []),
    // The guest's own platform dirs, before the pins: a pin over a directory carries the binds inside it.
    ...(plan.platform.length ? [`mkdir -p ${GUEST_PLATFORM_STAMPS} ${GUEST_PLATFORM_CACHE}`, `chown ${uid}:${gid} ${GUEST_PLATFORM_STAMPS} ${GUEST_PLATFORM_CACHE}`] : []),
    ...platformBindLines(plan.platform, uid, gid),
    // Hidden first, then pins and read-only binds outer first.
    ...plan.hidden.map((h) => `hide_${h.kind} ${quote(h.path)} ${quote(mountinfoPath(h.path))}`),
    ...[...plan.pinned.map((p) => ['pin', p] as const), ...plan.readOnly.map((p) => ['ro', p] as const), ...plan.writable.map((p) => ['rw', p] as const)]
      .sort((a, b) => a[1].split(path.sep).length - b[1].split(path.sep).length)
      .map(([op, p]) => `${op} ${quote(p)} ${quote(mountinfoPath(p))}`),
  ];
  return lines.join('\n');
}

/** Where the machine's resolver answers (guestDns.ts): the guest's resolv.conf names it. */
export const DNS_RESOLVER_ADDRESS = '127.0.0.53';
/** What the DNS setup prints, with what is missing, when the image cannot run the resolver. */
export const DNS_UNPROTECTED_MARK = 'AGENFK_DNS_UNPROTECTED';
/** The resolver's own user, once it has bound: never the session's (whose uid is the host user's). */
const DNS_UID = 997;
const DNS_UID_ALT = 996;
/**
 * The privileged source port the resolver asks smolvm's resolver from, bound while it is root: the
 * guest firewall lets port-53 traffic out from it alone (the guest kernel has no owner match).
 */
const DNS_UPSTREAM_SOURCE_PORT = 54;
const GUEST_DNS = `${GUEST_RUN}/dns`;

/** The deny entries the resolver applies: names only - addresses and ranges are the decider's. */
export function resolverDenyOf(network: SandboxSpec['network']): string[] {
  return network.deny.filter((d) => d.trim() === '*' || (!net.isIP(d.replace(/^\[|\]$/g, '')) && !d.includes('/')));
}

/**
 * The names the resolver alone answers, in enforce (story review 2): the allow list's names, without
 * a port; addresses and ranges are the decider's, loopback names never leave the machine. None in
 * observe, where every name not denied is answered. Given to the resolver only when smolvm's own
 * list (set at the machine's start) is behind the policy: smolvm's refusals are reported, the
 * resolver's are not.
 */
export function resolverAllowOf(network: SandboxSpec['network']): string[] | undefined {
  if (network.mode === 'observe') return undefined;
  const names = network.allow.map((a) => (a.startsWith('[') ? a : a.replace(/:\d+$/, '')).trim().toLowerCase())
    .filter((h) => h && !net.isIP(h.replace(/^\[|\]$/g, '')) && !h.includes('/') && h !== 'localhost' && !h.endsWith('.localhost'));
  return [...new Set(names)];
}

/**
 * The root script that runs the machine's resolver (CGLAB-696 task 8): it records smolvm's
 * resolver, starts ours as its own user (bound, then dropped), and only then redirects every
 * port-53 question the machine sends - to whichever server - to it, the resolver's own (from its
 * privileged source port) excepted, refusing what the redirect does not take and all DNS over
 * IPv6. smolvm supplies resolv.conf to each exec, so repointing it would not hold; the redirect
 * holds whatever resolver is asked. An image without node, iptables, ip6tables or setsid gets
 * none of it: the script prints DNS_UNPROTECTED_MARK with what is missing, and the runtime refuses
 * (enforce) or warns. Idempotent: rules are added once, a running resolver is kept.
 */
export function guestDnsScript(network: SandboxSpec['network'], resolverSource: string, sessionUid: number, allow?: string[], reports = false): string {
  // The session could signal a resolver running under its own uid (review 01a18ddc).
  const uid = sessionUid === DNS_UID ? DNS_UID_ALT : DNS_UID;
  const config = JSON.stringify({
    host: DNS_RESOLVER_ADDRESS, port: 53, upstream: { host: '__UPSTREAM__', port: 53 }, upstreamSourcePort: DNS_UPSTREAM_SOURCE_PORT,
    deny: resolverDenyOf(network), ...(allow ? { allow } : {}), uid, gid: uid,
    ...(reports ? { report: { host: GATEWAY, port: RESOLVER_REPORT_PORT } } : {}),
  });
  return [
    'set -e',
    'missing=""',
    'for t in node iptables ip6tables setsid; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done',
    `if [ -n "$missing" ]; then echo "${DNS_UNPROTECTED_MARK}$missing"; exit 0; fi`,
    `mkdir -p ${GUEST_DNS} && chmod 755 ${GUEST_DNS}`,
    `getent group ${uid} >/dev/null || echo 'agenfk-dns:x:${uid}:' >> /etc/group`,
    `getent passwd ${uid} >/dev/null || echo 'agenfk-dns:x:${uid}:${uid}:AgEnFK resolver:/:/usr/sbin/nologin' >> /etc/passwd`,
    // smolvm's resolver, as resolv.conf names it to the guest: where allowed questions go.
    `if [ ! -s ${GUEST_DNS}/upstream ]; then up=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf); `
      + `case "$up" in ""|${DNS_RESOLVER_ADDRESS}) echo "no resolver of smolvm's in /etc/resolv.conf" >&2; exit 1;; esac; echo "$up" > ${GUEST_DNS}/upstream; fi`,
    'up=$(cat ' + `${GUEST_DNS}/upstream)`,
    `printf '%s' ${quote(resolverSource)} > ${GUEST_DNS}/resolver.js`,
    // Whole: a running resolver follows it (the policy can change while sessions run).
    `printf '%s' ${quote(config)} | sed "s/__UPSTREAM__/$up/" > ${GUEST_DNS}/config.json.tmp`,
    `chmod 444 ${GUEST_DNS}/resolver.js ${GUEST_DNS}/config.json.tmp ${GUEST_DNS}/upstream`,
    `mv -f ${GUEST_DNS}/config.json.tmp ${GUEST_DNS}/config.json`,
    // The token its reports go under (85d37bd5), from smolvm's environment (never a command line):
    // root's alone, read by the resolver before it gives up root.
    ...(reports ? [`(umask 077; printf '%s' "$AGENFK_DNS_REPORT_TOKEN" > ${GUEST_DNS}/report-token.tmp) && mv -f ${GUEST_DNS}/report-token.tmp ${GUEST_DNS}/report-token`] : []),
    // Running already (another session's): kept, if it follows its config and reports its refusals -
    // one an older AgEnFK started does not, and is replaced (review). A pid file, not pgrep -f, which
    // would find this script.
    `if [ -s ${GUEST_DNS}/pid ] && [ ! -e ${GUEST_DNS}/reports ]; then kill "$(cat ${GUEST_DNS}/pid)" 2>/dev/null; rm -f ${GUEST_DNS}/pid; sleep 0.2; fi`,
    `if ! { [ -s ${GUEST_DNS}/pid ] && kill -0 "$(cat ${GUEST_DNS}/pid)" 2>/dev/null; }; then rm -f ${GUEST_DNS}/follows ${GUEST_DNS}/reports ${GUEST_DNS}/log; `
      + `setsid node ${GUEST_DNS}/resolver.js ${GUEST_DNS}/config.json > ${GUEST_DNS}/log 2>&1 < /dev/null & echo $! > ${GUEST_DNS}/pid; `
      + `i=0; until grep -q ready ${GUEST_DNS}/log 2>/dev/null; do i=$((i+1)); [ $i -lt 100 ] || { echo "the resolver did not start: $(tail -c 300 ${GUEST_DNS}/log)" >&2; exit 1; }; sleep 0.1; done; fi`,
    'rule() { t="$1"; tb="$2"; shift 2; "$t" -t "$tb" -C OUTPUT "$@" 2>/dev/null || "$t" -t "$tb" -A OUTPUT "$@"; }',
    // Only root binds below it: the resolver's source port stays the resolver's.
    'echo 1024 > /proc/sys/net/ipv4/ip_unprivileged_port_start',
    // Every DNS question the machine sends, to whichever resolver, is the machine resolver's (smolvm
    // supplies resolv.conf to each exec, so pointing it here would not hold); its own go on.
    `rule iptables nat -p udp --dport 53 ! -d ${DNS_RESOLVER_ADDRESS} -m udp ! --sport ${DNS_UPSTREAM_SOURCE_PORT} -j DNAT --to-destination ${DNS_RESOLVER_ADDRESS}:53`,
    `rule iptables nat -p tcp --dport 53 ! -d ${DNS_RESOLVER_ADDRESS} -j DNAT --to-destination ${DNS_RESOLVER_ADDRESS}:53`,
    // And nothing else leaves on port 53: what the redirect does not take is refused.
    `rule iptables filter -p udp --sport ${DNS_UPSTREAM_SOURCE_PORT} --dport 53 -j ACCEPT`,
    'for p in udp tcp; do',
    `  rule iptables filter -p "$p" --dport 53 -d ${DNS_RESOLVER_ADDRESS} -j ACCEPT`,
    '  rule iptables filter -p "$p" --dport 53 -j REJECT',
    '  rule ip6tables filter -p "$p" --dport 53 -j REJECT',
    'done',
  ].join('\n');
}

/**
 * A machine in use keeps the platform binds the launch that started it made, and gets no new
 * ones: the session in it could swap a platform dir, or a directory above it, for a link between
 * the plan and root's bind in the guest, which would follow it (onto /usr/bin, say). Nor is a
 * platform dir held on the host for it: the session could steer that placeholder the same way.
 */
function withoutPlatform(plan: GuestPlan): GuestPlan {
  const platform = new Set(plan.platform.map((d) => d.path));
  return { ...plan, platform: [], placeholders: plan.placeholders.filter((h) => !platform.has(h.path)) };
}

/**
 * The root script that sends the guest's own loopback port of each inference endpoint on the host
 * loopback (a9bc650c) to the gateway, where the decider carries it to the host: the client's URL
 * names 127.0.0.1 or localhost, which in the machine is the machine. Packets from loopback may then
 * leave (route_localnet), as the guest's own address. localhost's IPv6 answer is reset, so a client
 * trying it first falls back at once. Idempotent; the rules last as long as the machine runs.
 */
export function loopbackRouteScript(endpoints: Array<{ host: string; port: number }>): string {
  const lines = [
    'set -e',
    'rule() { t="$1"; tb="$2"; ch="$3"; shift 3; "$t" -t "$tb" -C "$ch" "$@" 2>/dev/null || "$t" -t "$tb" -A "$ch" "$@"; }',
    'sysctl -w net.ipv4.conf.all.route_localnet=1 >/dev/null',
  ];
  for (const { host, port } of endpoints) {
    const ip = net.isIPv4(host) ? host : '127.0.0.1';
    lines.push(`rule iptables nat OUTPUT -p tcp -d ${ip} --dport ${port} -j DNAT --to-destination ${GATEWAY}:${port}`);
    lines.push(`rule iptables nat POSTROUTING -p tcp -s 127.0.0.0/8 -d ${GATEWAY} --dport ${port} -j MASQUERADE`);
    if (!net.isIP(host)) lines.push(`rule ip6tables filter OUTPUT -p tcp -d ::1 --dport ${port} -j REJECT --reject-with tcp-reset`);
  }
  return lines.join('\n');
}

/** The relay's URL as the guest reaches it: through the gateway, where the decider relays it. */
const throughGateway = (url: string): string => url.replace(/^(https?:\/\/)(?:127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/, `$1${GATEWAY}`);

/** The host's terminal settings a TUI needs; nothing else of the host's environment goes in. */
const PASSTHROUGH_ENV = ['TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE'];

/** Records its pid where a signal can find it, then becomes the command. */
export const SESSION_LEADER = 'R="${0%/sessions/*}/reaped/$(basename "$0" .pid)"; echo $$ > "$0" || exit 125; '
  // Nothing runs before it is in its own cgroup (story review 2): the launcher, as root, moves it.
  + 'i=0; until grep -q "^0::/agenfk/" /proc/self/cgroup; do [ $i -lt 100 ] || exit 125; sleep 0.1; i=$((i+1)); done; '
  // Nor once its session was reaped, whenever that was (review): the reaper marks it, where only
  // root writes, before anything else - and takes the pid file.
  + '[ ! -e "$R" ] && [ "$(cat "$0" 2>/dev/null)" = "$$" ] || exit 125; '
  + 'exec "$@"';

/** A session's cgroup, made by root, which its processes cannot leave (a process group they can). */
const cgroupOf = (id: string): string => `/sys/fs/cgroup/agenfk/${id}`;
/**
 * Root's: the session marked reaped ($2) and its pid file ($0) taken first - a leader still waiting
 * to be contained, or not yet started, then runs nothing and is never moved - then everything in its
 * cgroup ($1) killed and the cgroup removed. Fails unless the cgroup was emptied and removed
 * (cgroup.events says when it is empty: cgroup.procs always reads as size 0).
 */
export const KILL_CGROUP = 'mkdir -p "${2%/*}" && : > "$2" || exit 1; rm -f "$0"; G="$1"; [ -d "$G" ] || exit 0; echo 1 > "$G/cgroup.kill" || exit 1; i=0; '
  + 'until grep -q "^populated 0" "$G/cgroup.events"; do [ $i -lt 50 ] || exit 1; sleep 0.1; i=$((i+1)); done; rmdir "$G"';
/** Root's: the session leader (pid read from $0) moved into its cgroup ($1), unless it was reaped ($2). */
const INTO_CGROUP = '[ -e "$2" ] && exit 1; G="$1"; mkdir -p "$G" && echo "$pid" > "$G/cgroup.procs"';
const reapedMark = (id: string): string => `${GUEST_REAPED}/${id}`;

/**
 * How a command the server runs starts in the guest (CGLAB-696 task 5), as root: in a mount
 * namespace of its own it applies its setup ($0), then becomes the user ($1:$2) and runs the rest
 * as a session leader that records its pid in $3. What the machine holds for the session in it is
 * left as it is. A step that fails exits 125, and the command never ran.
 */
export const COMMAND_IN_NAMESPACE = [
  'for t in unshare setpriv setsid; do command -v "$t" >/dev/null 2>&1 || { echo "[agenfk airlock] The machine image has no $t (util-linux), so the command cannot run under its own protections." >&2; exit 125; }; done',
  `exec unshare --mount --propagation private -- sh -c ${quote([
    'sh -c "$0" || { echo "[agenfk airlock] Airlock could not apply the command\'s protections in the machine." >&2; exit 125; }',
    'u="$1"; g="$2"; shift 2',
    `exec setpriv --reuid="$u" --regid="$g" --clear-groups -- setsid sh -c ${quote(SESSION_LEADER)} "$@"`,
  ].join('; '))} "$0" "$@"`,
].join('; ');

/**
 * Waits for its stdin to close, then runs its arguments (review 01a18ca1): the server kills a
 * command's host process group with SIGKILL, which ends `smolvm machine exec` on the host but not
 * the command in the guest. Started outside that group, it kills the command there. Its stdin is a
 * pipe only the launcher holds: closed however the launcher ends, before any reaping, whatever pid
 * comes next.
 */
export const WATCHDOG = 'cat >/dev/null; exec "$@"';

/**
 * The hook scripts the installer puts in ~/.agenfk/bin, which the agenfk adapters run. The machine
 * gets the running CLI's own (review, task 9): ~/.agenfk/bin may hold an older install's, whose
 * gate cannot prove a machine and would refuse every call.
 */
export const HOOK_SCRIPTS = ['agenfk-airlock.mjs', 'agenfk-gatekeeper.mjs', 'agenfk-mcp-enforcer.mjs', 'agenfk-pr-hook.mjs'];

/**
 * The compiled resolver beside this file (dist/airlock/guestDns.js; the desktop bundle carries it
 * beside its helper), or - run from the source tree, as the tests do - the build's.
 */
function defaultResolverSource(): string {
  for (const f of [path.join(__dirname, 'guestDns.js'), path.resolve(__dirname, '..', '..', 'dist', 'airlock', 'guestDns.js')]) {
    try { return fs.readFileSync(f, 'utf8'); } catch { /* next */ }
  }
  throw new Error('Airlock cannot find its machine resolver (guestDns.js): run `npm run build`. Nothing was launched.');
}

/** Starts WATCHDOG over `args`, detached, its stdin held by this process; stop() ends it. */
function startWatchdog(args: string[], env?: NodeJS.ProcessEnv): { stop(): void } {
  const child = nodeSpawn('/bin/sh', ['-c', WATCHDOG, 'sh', ...args], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, ...(env ? { env } : {}) });
  child.on('error', () => undefined);
  child.stdin?.on('error', () => undefined);
  // Neither keeps this process alive: the pipe is only ever closed, by stop() or by the end of this process.
  child.unref();
  (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  return { stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

interface SmolvmRuntimeDeps {
  /** The guest image (the AgEnFK base image, or the project's own). */
  image: string;
  egress: EgressBroker;
  /** The smolvm binary. */
  smolvmPath?: string;
  smolvm?: SmolvmRun;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  platform?: NodeJS.Platform;
  arch?: string;
  kvmAccessible?: () => boolean;
  /** Where the machines' session records and placeholders are kept. */
  stateDir?: string;
  uid?: number;
  gid?: number;
  isTTY?: boolean;
  hostEnv?: NodeJS.ProcessEnv;
  pidAlive?: (pid: number) => boolean;
  /** Which process a pid is now (processIdentity.ts): a record naming the pid of another is stale. */
  processIdentity?: (pid: number) => string | null;
  warn?: (message: string) => void;
  readGitConfig?: GitConfigReader;
  startInjector?: (o: KeyInjectorOptions) => Promise<KeyInjector>;
  startWatchdog?: (args: string[], env?: NodeJS.ProcessEnv) => { stop(): void };
  /** The machine resolver's source (guestDns.js), written into the guest. */
  resolverSource?: () => string;
  /** The running CLI's own hook scripts (its install's bin/): the session's adapters run them. */
  hookScriptsDir?: string;
  /** How often a running session's copy of the host's policy state is checked against it (ms). */
  policyFollowMs?: number;
  /** The CLI, as the watchdog runs it to reap a session whose launcher is gone (`airlock reap`). */
  reaperCommand?: string[];
  /** Electron's version when this runs in the desktop app (its binary then runs the reaper as Node). */
  electron?: string;
  /** AgEnFK's MCP client, bundled (packages/server/dist/mcp-bundle.js): what an OpenCode session runs. */
  mcpBundle?: string;
}

function runCli(file: string): SmolvmRun {
  return (args, options = {}) => new Promise((resolve, reject) => {
    const child = nodeSpawn(file, args, { env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultKvmAccessible(): boolean {
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** What smolvm said, for an error message. */
const said = (r: SmolvmResult): string => (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ').slice(0, 400);

interface MachineInfo { name: string; state: string; labels?: Record<string, string> }

/**
 * What a session's machine was readied with. `commandSetup`: a command's, the script root runs in
 * its own namespace before it starts (COMMAND_IN_NAMESPACE).
 */
interface Prepared { plan: GuestPlan; ca: MachineCa; placeholders: Record<string, string>; commandSetup?: string }

/** `ctime`: when it was made, to the nanosecond - an inode number alone is reused at once (ext4: CI). */
type HeldPlaceholder = Placeholder & { dev: number; ino: number; ctime?: string; parent: string };

/** Creating a machine pulls its image, and starting it may install the workspace's dependencies: both take a while. */
export const LOCK_TIMEOUT_MS = 900_000;
const LOCK_POLL_MS = 25;

/** Bounds the host's signalling exec: the pid file is the session's, and could be a FIFO. */
const SIGNAL_TIMEOUT = '10s';
/** Reads the session leader's pid from the file in $0, waiting briefly for it; anything but a pid stops here. */
const READ_PID = 'i=0; while [ ! -s "$0" ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done; '
  + 'pid=$(head -c 16 "$0" 2>/dev/null); case "$pid" in ""|*[!0-9]*|0|1) exit 1;; esac; ';

export class SmolvmRuntime implements AirlockRuntime {
  readonly id = `smolvm@${SMOLVM_VERSION}`;
  private readonly d: Required<Omit<SmolvmRuntimeDeps, 'warn'>> & { warn: (m: string) => void };
  private readonly unwatchers = new Set<() => void>();

  constructor(deps: SmolvmRuntimeDeps) {
    const smolvmPath = deps.smolvmPath ?? 'smolvm';
    this.d = {
      smolvmPath,
      smolvm: deps.smolvm ?? runCli(smolvmPath),
      // windowsHide: the guard in windows-hide-guard.test.ts reads it here (GitHub #200).
      spawn: deps.spawn ?? ((file, args, options) => nodeSpawn(file, args, { ...options, windowsHide: true })),
      platform: deps.platform ?? process.platform,
      arch: deps.arch ?? process.arch,
      kvmAccessible: deps.kvmAccessible ?? defaultKvmAccessible,
      stateDir: deps.stateDir ?? path.join(os.homedir(), '.agenfk', 'airlock'),
      uid: deps.uid ?? process.getuid?.() ?? 0,
      gid: deps.gid ?? process.getgid?.() ?? 0,
      isTTY: deps.isTTY ?? !!process.stdin.isTTY,
      hostEnv: deps.hostEnv ?? process.env,
      pidAlive: deps.pidAlive ?? defaultPidAlive,
      processIdentity: deps.processIdentity ?? processIdentity,
      readGitConfig: deps.readGitConfig ?? readGitConfig,
      startInjector: deps.startInjector ?? startKeyInjector,
      startWatchdog: deps.startWatchdog ?? startWatchdog,
      resolverSource: deps.resolverSource ?? defaultResolverSource,
      hookScriptsDir: deps.hookScriptsDir ?? path.resolve(__dirname, '..', '..', '..', '..', 'bin'),
      policyFollowMs: deps.policyFollowMs ?? 1000,
      reaperCommand: deps.reaperCommand ?? [process.execPath, process.argv[1]],
      electron: deps.electron ?? process.versions.electron ?? '',
      mcpBundle: deps.mcpBundle ?? path.resolve(__dirname, '..', '..', '..', 'server', 'dist', 'mcp-bundle.js'),
      warn: deps.warn ?? (() => undefined),
      image: deps.image,
      egress: deps.egress,
    };
  }

  async check(): Promise<RuntimeCheck> {
    const { platform, arch } = this.d;
    // Root in the guest could undo every bind that protects the host's files (story review).
    if (this.d.uid === 0) {
      return { ok: false, reason: 'Airlock will not run sessions as root: root in the machine could undo every protection Airlock applies. Launch it as your own user.' };
    }
    if (platform === 'win32') {
      return { ok: false, reason: 'Windows is not supported by Airlock: its sessions run in a smolvm machine, whose networking Airlock relies on runs on macOS and Linux only.' };
    }
    if (platform === 'darwin' && arch !== 'arm64') {
      return { ok: false, reason: 'Airlock runs sessions in a smolvm machine, which on macOS needs Apple Silicon: this is an Intel Mac.' };
    }
    if (platform === 'linux' && !this.d.kvmAccessible()) {
      return {
        ok: false,
        reason: 'Airlock runs sessions in a smolvm machine, which on Linux needs KVM: /dev/kvm is missing or this user cannot open it. '
          + 'Turn on virtualization (in the firmware, or nested virtualization when this is itself a VM) and add the user to the kvm group.',
      };
    }
    if (platform !== 'darwin' && platform !== 'linux') {
      return { ok: false, reason: `Airlock does not support ${platform} (macOS on Apple Silicon and Linux with KVM only).` };
    }
    let r: SmolvmResult;
    try {
      r = await this.d.smolvm(['--version']);
    } catch {
      return { ok: false, reason: `smolvm is not installed. Airlock needs smolvm ${SMOLVM_VERSION}: install it with \`agenfk airlock install\`, then launch again.` };
    }
    const found = /(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? 'an unknown version';
    if (r.code !== 0 || found !== SMOLVM_VERSION) {
      return { ok: false, reason: `Airlock needs smolvm ${SMOLVM_VERSION}; found ${found}. Install ${SMOLVM_VERSION} with \`agenfk airlock install\`, then launch again.` };
    }
    return { ok: true, warnings: [] };
  }

  private async cli(args: string[], env?: NodeJS.ProcessEnv): Promise<SmolvmResult> {
    return this.d.smolvm(args, env ? { env } : undefined);
  }

  private async must(args: string[], what: string, env?: NodeJS.ProcessEnv): Promise<SmolvmResult> {
    const r = await this.cli(args, env);
    if (r.code !== 0) throw new Error(`Airlock could not ${what}, so nothing was launched (smolvm said: ${said(r) || `exit ${r.code}`}).`);
    return r;
  }

  private async machine(name: string): Promise<MachineInfo | null> {
    const r = await this.must(['machine', 'ls', '--json'], 'list the smolvm machines');
    const all = JSON.parse(r.stdout || '[]') as MachineInfo[];
    return all.find((m) => m.name === name) ?? null;
  }

  private machineDir(name: string): string {
    return path.join(this.d.stateDir, 'machines', name);
  }

  /** The sessions in the machine whose process is alive; records of the dead ones are removed. */
  private liveSessions(name: string): string[] {
    const dir = path.join(this.machineDir(name), 'sessions');
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return files.filter((f) => {
      const file = path.join(dir, f);
      let rec: { pid: number; identity?: string } = { pid: NaN };
      try { const r = JSON.parse(fs.readFileSync(file, 'utf8')); rec = { pid: Number(r.pid), identity: typeof r.identity === 'string' ? r.identity : undefined }; } catch { /* unreadable: stale */ }
      if (this.alive(rec)) return true;
      fs.rmSync(file, { force: true });
      return false;
    });
  }

  /** Is the recorded launcher running (its pid, and the process it was: 6386d4ac)? */
  private alive(rec: { pid: number; identity?: string | null }): boolean {
    return sameProcess(rec, { pidAlive: this.d.pidAlive, identityOf: this.d.processIdentity });
  }


  /** The live sessions' records: what each is (a record from before purposes were kept counts as a client). */
  private liveSessionRecords(name: string): Array<{ purpose: string }> {
    const dir = path.join(this.machineDir(name), 'sessions');
    return this.liveSessions(name).flatMap((f) => {
      try { return [{ purpose: String(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).purpose ?? 'client') }]; } catch { return []; }
    });
  }

  /** Makes the plan's placeholders, each recorded (with its identity) as soon as it exists. */
  private ensurePlaceholders(name: string, placeholders: Placeholder[]): void {
    const record = path.join(this.machineDir(name), 'placeholders.json');
    const held = this.readPlaceholders(name);
    for (const p of placeholders) {
      if (kindOfPath(p.path)) continue;
      // The parent as planned: a real directory, reached through no link.
      const parent = path.dirname(p.path);
      if (fs.lstatSync(parent).isSymbolicLink() || fs.realpathSync(parent) !== parent) {
        throw new Error(`${parent} is not the directory Airlock planned to hold ${path.basename(p.path)} in, so nothing was launched.`);
      }
      if (p.kind === 'dir') fs.mkdirSync(p.path);
      else fs.writeFileSync(p.path, p.content, { flag: 'wx' });
      const st = fs.lstatSync(p.path, { bigint: true });
      held.push({ ...p, dev: Number(st.dev), ino: Number(st.ino), ctime: st.ctimeNs.toString(), parent: fs.realpathSync(path.dirname(p.path)) });
      fs.writeFileSync(record, JSON.stringify(held));
    }
  }

  private readPlaceholders(name: string): HeldPlaceholder[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.machineDir(name), 'placeholders.json'), 'utf8')) as HeldPlaceholder[];
    } catch {
      return [];
    }
  }

  /**
   * Removes the placeholders still exactly as they were made - the same object,
   * in the same real directory, unchanged - and nothing else: one the session
   * replaced, or reached through a link, is left alone.
   */
  private removePlaceholders(name: string): void {
    for (const p of this.readPlaceholders(name)) {
      try {
        if (fs.realpathSync(path.dirname(p.path)) !== p.parent) continue;
        const st = fs.lstatSync(p.path);
        // The same object: a directory removed and made again can get the very inode number back.
        if (st.dev !== p.dev || st.ino !== p.ino || (p.ctime && fs.lstatSync(p.path, { bigint: true }).ctimeNs.toString() !== p.ctime)) continue;
        if (p.kind === 'dir' && st.isDirectory()) fs.rmdirSync(p.path);
        else if (p.kind === 'file' && st.isFile() && fs.readFileSync(p.path, 'utf8') === p.content) fs.rmSync(p.path);
      } catch { /* gone, or not empty: left alone */ }
    }
    fs.rmSync(path.join(this.machineDir(name), 'placeholders.json'), { force: true });
  }

  /** What the machine's lock (ownerLock.ts) judges its owners by. */
  private lockDeps(timedOut: () => Error = () => new Error('timed out')): OwnerLockDeps {
    return { pidAlive: this.d.pidAlive, identityOf: this.d.processIdentity, timeoutMs: LOCK_TIMEOUT_MS, pollMs: LOCK_POLL_MS, timedOut };
  }

  private breakStaleLock(lock: string, ino: number): boolean {
    return breakStaleLock(lock, ino, this.lockDeps());
  }

  /**
   * Runs `fn` holding the machine's lock, across processes: registration,
   * create and start, mounts, setup, release and reset never interleave.
   */
  private async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const lock = path.join(this.machineDir(name), 'lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    return withOwnerLock(lock, fn, this.lockDeps(() => new Error(`Airlock waited ${LOCK_TIMEOUT_MS / 1000}s for another session to finish starting or stopping the machine ${name}; nothing was launched.`)));
  }

  private async ensureMachine(name: string, workspace: string, image: string): Promise<MachineInfo> {
    const found = await this.machine(name);
    if (found) {
      const owner = found.labels?.['agenfk.workspace'];
      if (owner !== workspace) {
        throw new Error(`The smolvm machine ${name} belongs to ${owner ?? 'something else'}, not ${workspace}, so nothing was launched. Delete it with: smolvm machine delete --name ${name}`);
      }
      if (found.labels?.['agenfk.image'] === image) return found;
      if (found.state === 'running') {
        // Only another session keeps it running here (prepare stops one no session is in).
        throw new Error(`Another session is in the Airlock machine for ${workspace}, which runs ${found.labels?.['agenfk.image'] ?? 'another image'}; this launch needs ${image}, so nothing was launched. Launch it once that session has ended.`);
      }
      await this.must(['machine', 'delete', '--name', name, '-f'], 'replace the machine of an older image');
    }
    await this.must([
      'machine', 'create', '--name', name, '-I', image,
      '--net', '--net-backend', 'virtio-net', '--trust-host-certs',
      '--label', `agenfk.workspace=${workspace}`, '--label', `agenfk.image=${image}`,
      // An inert workload in place of the image's own command: nothing runs as root before the protections.
      '--', 'true',
    ], `create the Airlock machine for ${workspace}`);
    return { name, state: 'stopped' };
  }

  /**
   * Attaches the plan's mounts. The guest is one file system, so while another
   * session is in the machine its mounts must be exactly this session's: a
   * mount either one lacks would be seen by the session not allowed it. A command
   * joining (`joining`) takes the machine's mounts as they are, and is given back
   * those it may not see, to hide in its own namespace.
   */
  private async attachMounts(name: string, plan: GuestPlan, workspace: string, shared: boolean, joining = false): Promise<string[]> {
    const r = await this.must(['machine', 'mount', 'ls', '--name', name, '--json'], 'list the machine\'s mounts');
    const have = JSON.parse(r.stdout || '[]') as Array<{ source: string; target: string }>;
    const key = (source: string, target: string) => `${source}\0${target}`;
    const want = new Set(plan.mounts.map((m) => key(m.host, m.guest)));
    const held = new Set(have.map((h) => key(h.source, h.target)));
    const foreign = have.filter((h) => !want.has(key(h.source, h.target))).map((h) => h.source);
    const extra = shared ? plan.mounts.filter((m) => !held.has(key(m.host, m.guest))).map((m) => m.host) : [];
    if (joining) {
      // Hiding a mount above one the command needs would hide that one too.
      const over = foreign.find((f) => plan.mounts.some((m) => inside(m.guest, f)));
      if (extra.length || over) {
        const why = extra.length
          ? `would have to mount ${extra.join(', ')}, which the session already in it may not see`
          : `cannot hide ${over}, which the session in it has mounted, without hiding what the command needs`;
        throw new Error(`Another session is in the Airlock machine for ${workspace}, and this command ${why}, so nothing was launched. Run it once that session has ended.`);
      }
      return foreign;
    }
    if (foreign.length || extra.length) {
      const why = foreign.length
        ? `has ${foreign.join(', ')} mounted, which this session may not see`
        : `would have to mount ${extra.join(', ')}, which the session already in it may not see`;
      throw new Error(`Another session is in the Airlock machine for ${workspace}, and this one ${why}, so nothing was launched. Launch it once that session has ended.`);
    }
    for (const m of plan.mounts) {
      if (held.has(key(m.host, m.guest))) continue;
      await this.must(['machine', 'mount', 'add', '--name', name, '-v', `${m.host}:${m.guest}`], `mount ${m.host} in the machine`);
    }
    return [];
  }

  /** Stops the machine and its interceptor, and takes the placeholders back. Called holding the lock. */
  private async stopMachine(name: string): Promise<void> {
    const r = await this.cli(['machine', 'stop', '--name', name]).catch((e) => ({ code: null, stdout: '', stderr: String((e as Error)?.message ?? e) }));
    // Only a stop smolvm confirms takes the protections down.
    if (r.code !== 0 && (await this.machine(name))?.state === 'running') {
      throw new Error(`Airlock could not stop the machine ${name}, so its protections stay in place (smolvm said: ${said(r) || `exit ${r.code}`}). Stop it with: smolvm machine stop --name ${name}`);
    }
    await this.d.egress.stop(name).catch((e) => {
      this.d.warn(`Airlock: the machine ${name} stopped, but its network interceptor did not (${(e as Error)?.message ?? e}). It decides nothing without the machine; agenfk airlock reset clears it.`);
    });
    this.removePlaceholders(name);
  }

  /** Ends a session; the last one out stops the machine - only ever this workspace's own. */
  private async release(name: string, sessionFile: string, workspace: string): Promise<void> {
    await this.withLock(name, async () => {
      fs.rmSync(sessionFile, { force: true });
      if (this.liveSessions(name).length) return;
      const m = await this.machine(name);
      if (m && m.labels?.['agenfk.workspace'] !== workspace) return;
      await this.stopMachine(name);
    });
  }

  /** Starts the session's machine and readies it, holding the machine's lock. Returns the plan applied. */
  private async prepare(name: string, workspace: string, spec: SandboxSpec, sessionFile: string): Promise<Prepared> {
    return this.withLock(name, async () => {
      // The CA and the placeholders are the machine's, made under its lock: two launchers at once
      // would each make their own.
      const ca = machineCa(path.join(this.machineDir(name), 'ca'));
      const placeholders = this.placeholdersOf(name, spec.maskedEnv.map((m) => m.name));
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify({ pid: process.pid, identity: this.d.processIdentity(process.pid), workspace, purpose: spec.purpose ?? 'client' }));
      const shared = this.liveSessions(name).length > 1;
      if (!shared) {
        // No session but this one. A machine still running was left so by a session that is gone,
        // and so is its interceptor: stopped, to start fresh. Placeholders a crashed launcher left
        // are taken back either way, before the plan is made.
        const left = await this.machine(name);
        if (left?.state === 'running' && left.labels?.['agenfk.workspace'] === workspace) await this.stopMachine(name);
        else this.removePlaceholders(name);
      }
      // Planned only now: what the cleanup above removed is planned as missing.
      let plan = guestPlanOf(spec, workspace, this.d.readGitConfig, new Set(this.readPlaceholders(name).map((p) => p.path)));
      if (shared) plan = withoutPlatform(plan);
      // A command the server runs joins the session in the machine on the session's terms: its
      // network (one decider per machine cannot tell their flows apart), its mounts and
      // protections, plus its own in a namespace of its own. ACCEPTED LIMIT (user decision
      // 2026-10-30, review 01a18ca1): beside a session the command reaches what the session does.
      // It shares the session's uid and pids, so /proc/<pid>/root and /environ show the session's
      // view - pi's state, the relay's address - and the relay reaches the AgEnFK server. Hiding
      // pi's state in the command's namespace is no boundary: the command is the session's code.
      const joining = shared && spec.purpose === 'command';
      const machine = await this.ensureMachine(name, workspace, spec.machineImage ?? this.d.image);
      const network = path.join(this.machineDir(name), 'network.json');
      const protections = path.join(this.machineDir(name), 'protections.json');
      const applied = JSON.stringify({ pinned: plan.pinned, writable: plan.writable, readOnly: plan.readOnly, hidden: plan.hidden });
      const recorded = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
      // The machine's policy, not the session's relay port (each launch has its own): story review.
      if (shared && !joining && recorded(network) !== networkKey(spec.network)) {
        // One interceptor decides for the whole machine: a session under another network policy waits its turn.
        throw new Error(`Another session is in the Airlock machine for ${workspace} under a different network policy, so nothing was launched. Launch it once that session has ended.`);
      }
      // Key injection: every session's injector must know the same placeholders for the same hosts,
      // whichever of them the decider sends a flow to.
      const injection = path.join(this.machineDir(name), 'injection.json');
      // And the same key: a keyed fingerprint of each value (story review 2), never the value - the
      // same name with another value is another account, which the shared placeholders would mix.
      const secret = this.machineSecret(name);
      const keyOf = (n: string) => { const v = this.d.hostEnv[n]; return v ? crypto.createHmac('sha256', secret).update(v).digest('hex') : null; };
      const injecting = JSON.stringify(spec.maskedEnv.map((m) => [m.name, [...m.injectHosts].sort(), keyOf(m.name)]).sort());
      // A command joining the session injects nothing, or exactly what the session does (review): the
      // decider may hand a session's flow to the command's injector, which must swap all its keys.
      const foreign = joining && spec.maskedEnv.length > 0 && recorded(injection) !== injecting;
      if ((shared && !joining && recorded(injection) !== injecting) || foreign) {
        throw new Error(`Another session is in the Airlock machine for ${workspace} with other model keys or inference hosts, so nothing was launched. Launch it once that session has ended.`);
      }
      if (shared && !joining && recorded(protections) !== applied) {
        // One file system: protections added now would not reach what the session in it already holds open.
        throw new Error(`Another session is in the Airlock machine for ${workspace} with different file protections, so nothing was launched. Launch it once that session has ended.`);
      }
      if (machine.state !== 'running') {
        fs.writeFileSync(network, networkKey(spec.network));
        fs.writeFileSync(protections, applied);
        fs.writeFileSync(injection, injecting);
        // smolvm's own allow list (enforce: only allowed names resolve), set while it is stopped.
        await this.must(['machine', 'update', '--name', name, ...allowListArgs(spec.network)], `set the network policy of the machine for ${workspace}`);
        // What smolvm's own list says until the machine stops: a later policy is held to it by the resolver.
        fs.writeFileSync(path.join(this.machineDir(name), 'smolvm-network.json'), JSON.stringify(spec.network));
        const icpt = await this.d.egress.ensure(name, spec);
        await this.must(['machine', 'start', '--name', name, '--mediated-egress', '--egress-interceptor', icpt.address],
          `start the machine for ${workspace}`, { SMOLVM_INTERCEPTOR_TOKEN: icpt.token });
      }
      const unseen = await this.attachMounts(name, plan, workspace, shared, joining);
      this.ensurePlaceholders(name, plan.placeholders);
      if (!joining) {
        await this.must(['machine', 'exec', '--name', name, '-u', 'root', '--', 'sh', '-c', guestSetupScript(plan, this.d.uid, this.d.gid, ca.certPem, this.homeOf(spec))], 'protect the session\'s files in the machine');
        await this.startResolver(name, workspace, spec);
        if (spec.loopbackInference?.length) {
          await this.must(['machine', 'exec', '--name', name, '-u', 'root', '--', 'sh', '-c', loopbackRouteScript(spec.loopbackInference)], 'route the session\'s model server on the host loopback');
        }
        if (spec.purpose !== 'command') await this.provisionAgenfk(name, spec);
        if (spec.env[AIRLOCK_SANDBOX_MARKER] === 'opencode') await this.provisionMcp(name, spec);
      }
      // Not under a session already in the machine: its dependencies would change beneath it.
      if (!shared && plan.platform.length) await this.installPlatform(name, workspace, spec, plan.platformIncomplete);
      // The platform binds and the CA bundle are the machine's, made above or by the session in it.
      const commandSetup = spec.purpose === 'command'
        ? guestSetupScript({ ...plan, platform: [], hidden: [...plan.hidden, ...unseen.map((p) => ({ path: p, kind: 'dir' as const }))] }, this.d.uid, this.d.gid, undefined, this.homeOf(spec))
        : undefined;
      return { plan, ca, placeholders, commandSetup };
    });
  }

  /**
   * The machine's resolver and the firewall around it (guestDnsScript). An image that cannot run
   * them leaves DNS lookups of denied names leaving the machine: enforce refuses, observe warns.
   */
  private async startResolver(name: string, workspace: string, spec: SandboxSpec): Promise<void> {
    // smolvm refuses (and reports) a name off the allow list it was started with; the resolver
    // refuses names only when the policy has changed since (story review 2).
    let started: SandboxSpec['network'] | null = null;
    try { started = JSON.parse(fs.readFileSync(path.join(this.machineDir(name), 'smolvm-network.json'), 'utf8')) as SandboxSpec['network']; } catch { /* none */ }
    const allow = resolverAllowOf(spec.network);
    // Not knowing what smolvm's list was set to (a machine an older AgEnFK started): taken as behind (review).
    const behind = !!allow && (!started || started.mode !== 'enforce' || JSON.stringify([...(resolverAllowOf(started) ?? [])].sort()) !== JSON.stringify([...allow].sort()));
    // What it refuses goes to the decider under a token of the machine's (85d37bd5), given through
    // smolvm's environment.
    const token = this.d.egress.resolverToken?.(name) ?? null;
    const script = guestDnsScript(spec.network, this.d.resolverSource(), this.d.uid, behind ? allow : undefined, !!token);
    const r = await this.must(['machine', 'exec', '--name', name, '-u', 'root',
      ...(token ? ['--secret-env', 'AGENFK_DNS_REPORT_TOKEN=AGENFK_DNS_REPORT_TOKEN'] : []), '--', 'sh', '-c', script],
    'start the machine\'s resolver', token ? { AGENFK_DNS_REPORT_TOKEN: token } : undefined);
    const mark = r.stdout.split('\n').find((l) => l.startsWith(DNS_UNPROTECTED_MARK));
    if (!mark) return;
    const missing = mark.slice(DNS_UNPROTECTED_MARK.length).trim();
    const why = `DNS lookups of denied names cannot be refused in the machine for ${workspace}, whose image has no ${missing}: they would leave the machine`;
    if (spec.network.mode !== 'observe') throw new Error(`Airlock cannot enforce here: ${why}. Use an image with them (the AgEnFK base image has them). Nothing was launched.`);
    this.d.warn(`Airlock: ${why}.`);
  }

  /**
   * The session's ~/.agenfk in the machine (CGLAB-696 task 9): the agenfk adapters there read the
   * hook scripts, the policy state and the workflow token from it, as on the host. A tmpfs root
   * owns, so the session can read it and never write it (the adapters check that), holding the
   * running CLI's hook scripts and copies of the host's policy state and token (what the host has
   * of them, regular files only), and nothing else of the host's ~/.agenfk (its config, the proxy
   * reports' token). Copied again by each session, so a session starts with the current policy state.
   */
  private async provisionAgenfk(name: string, spec: SandboxSpec): Promise<void> {
    const dir = path.join(this.homeOf(spec), '.agenfk');
    // Made where it is, never through a link the session left in the machine's disk.
    await this.must(['machine', 'exec', '--name', name, '-u', 'root', '--', 'sh', '-c', [
      'set -e',
      MOUNTED_FN,
      ROOTDIR_FN,
      `D=${quote(dir)}`,
      `if ! mounted ${quote(mountinfoPath(dir))}; then`,
      '  rootdir "$D"',
      '  mount -t tmpfs -o size=4m,mode=0755 tmpfs "$D"',
      'fi',
      'mkdir -p "$D/bin"',
    ].join('\n')], 'give the session its ~/.agenfk in the machine');
    const regular = (p: string) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
    const give = (from: string, to: string, owner: string[]) =>
      this.must(['machine', 'cp', ...owner, from, `${name}:${to}`], `copy ${from} into the machine`);
    const missing = HOOK_SCRIPTS.find((f) => !regular(path.join(this.d.hookScriptsDir, f)));
    if (missing) {
      throw new Error(`Airlock cannot find its hook script ${path.join(this.d.hookScriptsDir, missing)}, without which the session's gate refuses every tool call. Reinstall AgEnFK (agenfk upgrade). Nothing was launched.`);
    }
    for (const f of HOOK_SCRIPTS) await give(path.join(this.d.hookScriptsDir, f), path.join(dir, 'bin', f), ['--mode', '444']);
    const state = path.join(dir, 'airlock-state.json');
    if (regular(state)) await give(state, state, ['--mode', '444']);
    // The session's group may read it; nobody in the machine may write it.
    const token = path.join(dir, 'verify-token');
    if (regular(token)) await give(token, token, ['--mode', '440', '--uid', '0', '--gid', String(this.d.gid)]);
  }

  /**
   * Keeps the session's copy of the host's policy state current while it runs (review, task 9):
   * the adapters take the state file over an answer they cached when it is newer, as the server
   * rewrites it on every change - a copy that never changed would let a cached permissive answer
   * stand after the policy turned to enforce. Each tick compares the host's file with what this
   * follower last delivered, so a change made while the session started is caught by the first
   * tick and a copy that failed is tried again (said once per run of failures). The stop waits for
   * a copy under way: none lands after the session ended.
   */
  private followPolicyState(name: string, spec: SandboxSpec): () => Promise<void> {
    const file = path.join(this.homeOf(spec), '.agenfk', 'airlock-state.json');
    let delivered: string | null = null;
    let copying: Promise<void> | null = null;
    let failing = false;
    const tick = () => {
      if (copying) return;
      let now: string;
      try {
        if (!fs.lstatSync(file).isFile()) return;
        now = fs.readFileSync(file, 'utf8');
      } catch { return; }
      if (now === delivered) return;
      copying = (async () => {
        const r = await this.cli(['machine', 'cp', '--mode', '444', file, `${name}:${file}`]).catch((e) => ({ code: 1, stdout: '', stderr: String(e?.message ?? e) }));
        if (r.code === 0) {
          // What was read before the copy: one that changed meanwhile is copied again next tick.
          delivered = now;
          failing = false;
        } else if (!failing) {
          failing = true;
          this.d.warn(`Airlock: the session's copy of the policy state could not be brought up to date (${said(r)}); trying again, and its gate may decide by the old one until the server answers.`);
        }
      })().finally(() => { copying = null; });
    };
    const timer = setInterval(tick, this.d.policyFollowMs);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await copying;
    };
  }

  /** The machine's own secret, which key fingerprints are made with: the user's alone. Made under the machine's lock. */
  private machineSecret(name: string): Buffer {
    const file = path.join(this.machineDir(name), 'key-secret');
    try {
      const s = fs.readFileSync(file);
      if (s.length === 32) return s;
    } catch { /* made below */ }
    const s = crypto.randomBytes(32);
    fs.writeFileSync(`${file}.tmp`, s, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return s;
  }

  /**
   * AgEnFK's MCP for an OpenCode session (story review 2): the installer has OpenCode run it as
   * `node <install>/packages/server/dist/index.js`, an install the machine does not have. The bundled
   * MCP is put at that path, on a tmpfs root owns over its directory - only a path outside the mounts
   * (a path in them is the host's own, and none of root's to cover). It reaches the server through
   * the relay, as everything in the machine does (AGENFK_API_URL).
   */
  private async provisionMcp(name: string, spec: SandboxSpec): Promise<void> {
    let command: unknown;
    // Read bounded and never blocking (a FIFO, story review 3); a link (dotfiles) is followed to its file.
    try {
      const cfg = readRegularFile(fs.realpathSync(path.join(this.homeOf(spec), '.config', 'opencode', 'opencode.json')), MAX_CLIENT_CONFIG);
      command = cfg ? JSON.parse(cfg.toString('utf8'))?.mcp?.agenfk?.command : undefined;
    } catch { return; }
    if (!Array.isArray(command) || command.length !== 2 || command[0] !== 'node' || typeof command[1] !== 'string') return;
    const target = command[1];
    if (!path.isAbsolute(target) || path.normalize(target) !== target || !target.endsWith('/packages/server/dist/index.js')) return;
    if (spec.filesystem.allowWrite.some((r) => inside(target, path.resolve(r)))) return;
    let bundled = false;
    try { bundled = fs.lstatSync(this.d.mcpBundle).isFile(); } catch { /* none */ }
    if (!bundled) {
      this.d.warn(`Airlock: this install has no bundled MCP (${this.d.mcpBundle}), so OpenCode's AgEnFK MCP does not run in the machine; the agenfk CLI does. Rebuild or reinstall AgEnFK.`);
      return;
    }
    const dir = path.dirname(target);
    // The path comes from a config the session can write: root works only where nothing on it is the session's.
    const made = await this.cli(['machine', 'exec', '--name', name, '-u', 'root', '--', 'sh', '-c', [
      'set -e',
      MOUNTED_FN,
      ROOTDIR_FN,
      `D=${quote(dir)}`,
      `if ! mounted ${quote(mountinfoPath(dir))}; then`,
      '  rootdir "$D"',
      '  mount -t tmpfs -o size=16m,mode=0755 tmpfs "$D"',
      'fi',
    ].join('\n')]).catch((e) => ({ code: 1, stdout: '', stderr: String(e?.message ?? e) }));
    const copied = made.code === 0 ? await this.cli(['machine', 'cp', '--mode', '444', this.d.mcpBundle, `${name}:${target}`]).catch((e) => ({ code: 1, stdout: '', stderr: String(e?.message ?? e) })) : made;
    // Optional: the session runs without it (the agenfk CLI is there), said so.
    if (copied.code !== 0) this.d.warn(`Airlock: OpenCode's AgEnFK MCP was not put in the machine at ${target} (${said(copied)}); the agenfk CLI is there.`);
  }

  /** The session's HOME in the guest: the host user's path. */
  private homeOf(spec: SandboxSpec): string {
    return spec.home ?? this.d.hostEnv.HOME ?? '/root';
  }

  /**
   * Installs the workspace's dependencies in the guest, as the session user, when its lockfile
   * changed since the last install (or there was none). A failure is said, and the session starts
   * with what the machine has: the next launch tries again.
   */
  private async installPlatform(name: string, workspace: string, spec: SandboxSpec, incomplete?: string): Promise<void> {
    const install = platformInstallOf(workspace);
    if (!install) return;
    if (incomplete) {
      this.d.warn(`Airlock: ${workspace}: ${incomplete}, so its dependencies are not installed in the machine (the install could write the host's own node_modules). Install them in the session if it needs them.`);
      return;
    }
    const env = [
      `HOME=${this.homeOf(spec)}`,
      'TMPDIR=/tmp',
      `npm_config_cache=${GUEST_PLATFORM_CACHE}/npm`,
      `YARN_CACHE_FOLDER=${GUEST_PLATFORM_CACHE}/yarn`,
      `XDG_CACHE_HOME=${GUEST_PLATFORM_CACHE}`,
      ...CA_BUNDLE_ENV.map((k) => `${k}=${GUEST_CA_BUNDLE}`),
    ];
    // Root contains it in a cgroup of its own, killed when it ends; it runs as the session user.
    const cgroup = `/sys/fs/cgroup/agenfk/install-${crypto.randomBytes(8).toString('hex')}`;
    const r = await this.cli([
      'machine', 'exec', '--name', name, '--timeout', INSTALL_TIMEOUT, '-u', 'root', '-w', workspace, ...env.flatMap((e) => ['-e', e]),
      '--', 'sh', '-c', CONTAINED_INSTALL, cgroup, String(this.d.uid), String(this.d.gid),
      PLATFORM_INSTALL_SCRIPT, `${GUEST_PLATFORM_STAMPS}/${hash16(workspace)}`, install.hash, ...install.command,
    ]).catch((e) => ({ code: null, stdout: '', stderr: String((e as Error)?.message ?? e) }));
    // Whatever ended it (a timeout kills the wrapper before its own cleanup): nothing it started runs on.
    const ended = await this.cli(['machine', 'exec', '--name', name, '--timeout', SIGNAL_TIMEOUT, '-u', 'root', '--', 'sh', '-c', KILL_INSTALL_CGROUP, cgroup])
      .catch((e) => ({ code: null, stdout: '', stderr: String((e as Error)?.message ?? e) }));
    if (ended.code !== 0) {
      throw new Error(`Airlock could not end what the dependency install started in the machine (${said(ended) || `exit ${ended.code}`}), so no session was started: it could run on beside it. agenfk airlock reset clears the machine.`);
    }
    if (r.code !== 0) {
      this.d.warn(`Airlock: \`${install.command.join(' ')}\` failed in the machine for ${workspace}, so the session starts with the dependencies the machine already has; it runs again on the next launch. A registry it needs must be on the policy's allowed hosts. It said: ${said(r) || `exit ${r.code}`}`);
    }
  }

  /** The machine's placeholder for each key name: one per name, kept, so every session's injector swaps the same one. */
  private placeholdersOf(name: string, keys: string[]): Record<string, string> {
    const file = path.join(this.machineDir(name), 'placeholders.keys.json');
    let held: Record<string, string> = {};
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
    let changed = false;
    for (const k of keys) {
      if (typeof held[k] !== 'string') { held[k] = placeholderFor(k); changed = true; }
    }
    if (changed) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(held), { mode: 0o600 });
    }
    return Object.fromEntries(keys.map((k) => [k, held[k]]));
  }

  async launch(spec: SandboxSpec, command: SandboxCommand, hooks: LaunchHooks = {}): Promise<LaunchedSandbox> {
    const ready = await this.check();
    if (!ready.ok) throw new Error(ready.reason);
    const workspace = path.resolve(spec.workspace ?? command.cwd);
    const name = machineNameOf(workspace);
    const user = `${this.d.uid}:${this.d.gid}`;
    const id = crypto.randomBytes(8).toString('hex');
    const pidFile = `${GUEST_SESSIONS}/${id}.pid`;
    // Registered before anything starts, so a session beside this one never stops the machine under it.
    const sessionFile = path.join(this.machineDir(name), 'sessions', `${id}.json`);

    // Watching from now (review): a launcher that dies anywhere from here on has its session reaped.
    // Electron runs the reaper only as Node, and the desktop app's exec env no longer says so.
    const watchdog = this.d.startWatchdog([...this.d.reaperCommand, 'airlock', 'reap', '--machine', name, '--session', id, '--workspace', workspace],
      this.d.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : undefined);
    let unwatch: (() => void) | null = null;
    // Taken back once the session ends, or its launch fails: route files first, then the services.
    const undo: Array<() => void | Promise<void>> = [];
    const unroute = async () => {
      for (const u of undo.splice(0).reverse()) { try { await u(); } catch { /* gone */ } }
    };
    let child: ChildProcess;
    try {
      const { ca, placeholders, commandSetup } = await this.prepare(name, workspace, spec, sessionFile);
      const keyEnv = await this.routeSession(name, spec, ca, placeholders, undo);
      if (spec.purpose !== 'command') undo.push(this.followPolicyState(name, spec));
      const tell = hooks.onProxyDecision;
      if (tell) {
        const off = this.d.egress.watch(name, (decision) => { try { tell(decision); } catch { /* the report never decides anything */ } });
        unwatch = () => { off(); this.unwatchers.delete(unwatch!); };
        this.unwatchers.add(unwatch);
      }
      const tty = this.d.isTTY && spec.allowPty;
      const env = [
        ...Object.entries(spec.env).map(([k, v]) => `${k}=${k === 'AGENFK_API_URL' ? throughGateway(v) : v}`),
        ...keyEnv,
        ...CA_BUNDLE_ENV.map((k) => `${k}=${GUEST_CA_BUNDLE}`),
        `HOME=${this.homeOf(spec)}`,
        'TMPDIR=/tmp',
        ...PASSTHROUGH_ENV.filter((k) => this.d.hostEnv[k]).map((k) => `${k}=${this.d.hostEnv[k]}`),
      ];
      // A key no injector can mask (plain http): from smolvm's own environment, never on a command line.
      const plain = (spec.plainEnv ?? []).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && this.d.hostEnv[n]);
      const exec = (as: string, ...rest: string[]) => ['machine', 'exec', '--name', name, '-i', ...rest, '-u', as, '-w', command.cwd, ...env.flatMap((e) => ['-e', e]),
        ...plain.flatMap((n) => ['--secret-env', `${n}=${n}`]), '--'];
      const args = commandSetup !== undefined
        // A command: root first, for its namespace, then the user (no terminal: the server runs it).
        ? [...exec('root'), 'sh', '-c', COMMAND_IN_NAMESPACE, commandSetup, String(this.d.uid), String(this.d.gid), pidFile, command.file, ...command.args]
        : [...exec(user, ...(tty ? ['-t'] : [])), 'setsid', ...(tty ? ['-c'] : []), 'sh', '-c', SESSION_LEADER, pidFile, command.file, ...command.args];
      child = this.d.spawn(this.d.smolvmPath, args, {
        cwd: command.cwd, stdio: 'inherit',
        ...(plain.length ? { env: { ...process.env, ...Object.fromEntries(plain.map((n) => [n, this.d.hostEnv[n] as string])) } } : {}),
      });
    } catch (e) {
      unwatch?.();
      await unroute();
      await this.release(name, sessionFile, workspace);
      // Only once released (review): the launcher killed meanwhile still has its watchdog.
      watchdog.stop();
      throw e;
    }

    // As the session's user, bounded: the pid file is the session's own.
    const inGuestArgs = (script: string) => ['machine', 'exec', '--name', name, '--timeout', SIGNAL_TIMEOUT, '-u', user, '--', 'sh', '-c', READ_PID + script, pidFile];
    const inGuest = (script: string) => this.cli(inGuestArgs(script)).catch(() => undefined);
    const kill = (signal: NodeJS.Signals): boolean => {
      const sig = signal.replace(/^SIG/, '');
      if (!/^[A-Z0-9]+$/.test(sig)) return false;
      void inGuest(`kill -${sig} -$pid`);
      return true;
    };
    let finishing: Promise<void> | null = null;
    // Once, whichever of exit and error comes: everything in the session's cgroup ends with it,
    // then the session is released. A release that fails (a stop smolvm did not confirm) rejects
    // `exited`: the machine may still be running.
    const finish = () => finishing ??= (async () => {
      const ended = await this.killCgroup(name, id);
      await unroute();
      try {
        if (!ended) {
          // Its record and watchdog stay (review): once this process is gone, the reaper tries again.
          this.d.warn(`Airlock could not end everything the session left running in the machine for ${workspace}; it is tried again when this process ends.`);
          return;
        }
        await this.release(name, sessionFile, workspace);
        // Only now (review): the launcher killed while the session was released still has its watchdog.
        watchdog.stop();
      } finally {
        // After the release: a last session's stop has the decider write its last decisions.
        unwatch?.();
      }
    })();
    const exited = new Promise<SandboxExit>((resolve, reject) => {
      child.once('exit', (code, signal) => { finish().then(() => resolve({ code, signal }), reject); });
      child.once('error', (e) => { finish().then(() => reject(e), reject); });
    });
    // Into its cgroup, which its leader waits for (story review 2): one that cannot be contained never runs.
    const moved = await this.cli(['machine', 'exec', '--name', name, '--timeout', SIGNAL_TIMEOUT, '-u', 'root', '--', 'sh', '-c', READ_PID + INTO_CGROUP, pidFile, cgroupOf(id), reapedMark(id)])
      .catch((e) => ({ code: 1, stdout: '', stderr: String(e?.message ?? e) }));
    if (moved.code !== 0) {
      await inGuest('kill -KILL -$pid');
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      await Promise.race([exited.catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))]);
      throw new Error(`Airlock could not put the session in a cgroup of its own in the machine (${said(moved) || `exit ${moved.code}`}), so nothing was run: what it started could outlive it.`);
    }
    return { pid: child.pid, kill, exited };
  }

  /**
   * The session's routes through the machine's decider: its relay to the AgEnFK server, and, for
   * each model key the host holds, the key injector on the inference hosts. Each listens on its own
   * Unix socket. The env the guest gets for the keys: the machine's placeholders, never the keys.
   */
  private async routeSession(name: string, spec: SandboxSpec, ca: MachineCa, placeholders: Record<string, string>,
    undo: Array<() => void | Promise<void>>): Promise<string[]> {
    if (spec.relayPort) {
      // The relay itself listens on the loopback (the launcher's, SX-1): carried to it from its socket.
      const socket = await this.forwardSocket(name, spec.relayPort, '127.0.0.1', undo);
      undo.push(this.d.egress.addRoute(name, { kind: 'relay', port: spec.relayPort, socket }));
    }
    const secrets = spec.maskedEnv.flatMap((m) => {
      const value = this.d.hostEnv[m.name];
      return value ? [{ name: m.name, placeholder: placeholders[m.name], value, hosts: m.injectHosts }] : [];
    });
    // A model server on the host loopback (a9bc650c) the injector does not take: carried as it is.
    const injected = new Set(secrets.flatMap((s) => s.hosts));
    for (const e of spec.loopbackInference ?? []) {
      if (injected.has(e.host)) continue;
      const socket = await this.forwardSocket(name, e.port, e.host, undo);
      undo.push(this.d.egress.addRoute(name, { kind: 'forward', host: e.host, port: e.port, socket }));
    }
    if (!secrets.length) return [];
    // An inference endpoint on its own port keeps it (the spec's allow entry `host:port`).
    const portOf = (host: string) => {
      const e = spec.network.allow.find((a) => a.startsWith(`${host}:`));
      return e ? Number(e.slice(host.length + 1)) : 443;
    };
    const routes = [...new Set(secrets.flatMap((s) => s.hosts))].map((host) => ({ host, port: portOf(host) }));
    const socket = this.d.egress.routeSocket(name);
    const injector = await this.d.startInjector({ ca, routes, secrets: secrets.map(({ placeholder, value }) => ({ placeholder, value })), socketPath: socket });
    undo.push(() => injector.close());
    for (const r of routes) undo.push(this.d.egress.addRoute(name, { kind: 'inject', host: r.host, port: r.port, socket }));
    return secrets.map((s) => `${s.name}=${s.placeholder}`);
  }

  /**
   * A route socket of the session's that carries each connection to `host:port` on the host loopback;
   * closed by `undo`, cutting what is still open (another session may hold a connection through it).
   */
  private async forwardSocket(name: string, port: number, host: string, undo: Array<() => void | Promise<void>>): Promise<string> {
    const socket = this.d.egress.routeSocket(name);
    const open = new Set<net.Socket>();
    const forwarder = net.createServer((c) => {
      const t = net.connect({ port, host, autoSelectFamily: true });
      for (const x of [c, t]) { open.add(x); x.on('close', () => open.delete(x)); }
      c.on('error', () => t.destroy());
      t.on('error', () => c.destroy());
      c.on('close', () => t.destroy());
      t.on('close', () => c.destroy());
      c.pipe(t);
      t.pipe(c);
    });
    await new Promise<void>((resolve, reject) => { forwarder.once('error', reject); forwarder.listen(socket, () => resolve()); });
    undo.push(() => new Promise<void>((r) => { for (const x of open) x.destroy(); forwarder.close(() => r()); }));
    return socket;
  }

  /** Deletes the workspace's machine (`agenfk airlock reset`). Refused while a session is in it. */
  /**
   * The policy changed while the session runs (story review 2): the machine's decider and resolver
   * follow the new network, and joiners compare with it. smolvm's own allow list changes only while
   * the machine is stopped, so a newly allowed name resolves from the machine's next start.
   */
  async updateNetwork(workspaceDir: string, next: () => Promise<SandboxSpec | null>): Promise<'applied' | 'unchanged'> {
    const workspace = path.resolve(workspaceDir);
    const name = machineNameOf(workspace);
    return this.withLock(name, async () => {
      // Asked for holding the lock (fourth pass): no clock or revision orders the server's answers,
      // so what is applied last is what was fetched last.
      const spec = await next();
      if (!spec) return 'unchanged';
      // A client session in the machine owns its network (second pass): a command's, built without
      // the client's inference host, would take it away.
      if (spec.purpose === 'command' && this.liveSessionRecords(name).some((r) => r.purpose !== 'command')) return 'unchanged';
      const file = path.join(this.machineDir(name), 'network.json');
      let before: SandboxSpec['network'] | null = null;
      try { before = JSON.parse(fs.readFileSync(file, 'utf8')) as SandboxSpec['network']; } catch { /* none */ }
      if (before && networkKey(before) === networkKey(spec.network)) return 'unchanged';
      if ((await this.machine(name))?.state !== 'running') return 'unchanged';
      await this.d.egress.updateNetwork(name, spec.network);
      await this.startResolver(name, workspace, spec);
      fs.writeFileSync(file, networkKey(spec.network));
      const had = new Set(before ? resolverAllowOf(before) ?? [] : []);
      const added = before?.mode === 'enforce' ? (resolverAllowOf(spec.network) ?? []).filter((h) => !had.has(h)) : [];
      if (added.length) this.d.warn(`Airlock: the policy now allows ${added.join(', ')}; in the machine for ${workspace} that resolves from its next start (end every session in it, and launch again).`);
      return 'applied';
    });
  }

  /**
   * Kills everything in the session's cgroup in the machine, as root. True once it is ended, or
   * there is no running machine for anything to be left in.
   */
  private async killCgroup(name: string, id: string): Promise<boolean> {
    const r = await this.cli(['machine', 'exec', '--name', name, '--timeout', SIGNAL_TIMEOUT, '-u', 'root', '--', 'sh', '-c', KILL_CGROUP, `${GUEST_SESSIONS}/${id}.pid`, cgroupOf(id), reapedMark(id)])
      .catch((e) => ({ code: 1, stdout: '', stderr: String(e?.message ?? e) }));
    if (r.code === 0) return true;
    // Nothing is left only in a machine smolvm says is not running: one it could not say is (review).
    try { return (await this.machine(name))?.state !== 'running'; } catch { return false; }
  }

  /**
   * Reaps a session whose launcher is gone (story review 2), as its watchdog has it done: what the
   * session left running is killed, its record dropped, and the machine stopped when no session is
   * left in it - what the launcher's own finish would have done.
   */
  async reap(o: { machine: string; session: string; workspace: string }): Promise<void> {
    if (!/^agenfk-[0-9a-f]{16}$/.test(o.machine)) throw new Error(`Not an Airlock machine: ${o.machine}`);
    if (!/^[0-9a-f]{16}$/.test(o.session)) throw new Error(`Not an Airlock session: ${o.session}`);
    // The workspace's own machine, and no other (review): nothing is touched before this holds.
    if (machineNameOf(path.resolve(o.workspace)) !== o.machine) throw new Error(`The Airlock machine ${o.machine} is not the machine of ${o.workspace}.`);
    if (!(await this.killCgroup(o.machine, o.session))) {
      // Its record stays: a later reap, or the next launch, tries again.
      throw new Error(`Airlock could not end what session ${o.session} left running in the machine ${o.machine}.`);
    }
    await this.release(o.machine, path.join(this.machineDir(o.machine), 'sessions', `${o.session}.json`), o.workspace);
  }

  async reset(workspace: string): Promise<'deleted' | 'absent'> {
    const name = machineNameOf(path.resolve(workspace));
    return this.withLock(name, async () => {
      if (this.liveSessions(name).length) {
        throw new Error(`A session is running in the Airlock machine for ${workspace}: end it first.`);
      }
      const m = await this.machine(name);
      if (!m) return 'absent';
      if (m.labels?.['agenfk.workspace'] !== workspace) {
        throw new Error(`The smolvm machine ${name} belongs to ${m.labels?.['agenfk.workspace'] ?? 'something else'}, not ${workspace}: not deleted.`);
      }
      await this.stopMachine(name);
      await this.must(['machine', 'delete', '--name', name, '-f'], `delete the machine for ${workspace}`);
      return 'deleted';
    });
  }

  async dispose(): Promise<void> {
    for (const off of [...this.unwatchers]) off();
  }
}

/** `agenfk airlock reset`: the exit code, after saying what happened. */
export async function runAirlockReset(
  workspace: string,
  d: { reset: (workspace: string) => Promise<'deleted' | 'absent'>; log: (message: string) => void },
): Promise<number> {
  try {
    const r = await d.reset(workspace);
    d.log(r === 'deleted'
      ? `Deleted the Airlock machine for ${workspace}; the next session starts a fresh one.`
      : `There is no Airlock machine for ${workspace}.`);
    return 0;
  } catch (e) {
    d.log(`Could not reset the Airlock machine: ${(e as Error)?.message ?? e}`);
    return 1;
  }
}
