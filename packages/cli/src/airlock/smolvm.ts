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
import os from 'os';
import path from 'path';
import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';
import type { SandboxSpec } from './spec';
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
}

/** The machine of a workspace folder: one name per folder, stable across sessions. */
export function machineNameOf(workspace: string): string {
  return `agenfk-${crypto.createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 16)}`;
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
  /** Paths inside the mounts bound read-only in the guest. */
  readOnly: string[];
  /** Paths inside the mounts the guest cannot read. */
  hidden: Array<{ path: string; kind: 'file' | 'dir' }>;
  /** Protected paths that do not exist yet, held for the session so nothing can be planted there. */
  placeholders: Placeholder[];
}

/**
 * Protected files held by content git accepts (measured): a commondir of `.` is the repository
 * itself, and an empty config or config.worktree sets nothing. Any other placeholder is an empty dir.
 */
const FILE_PLACEHOLDERS: Record<string, string> = { commondir: '.\n', 'config.worktree': '', config: '' };

/** In the workspace's .git: unwritable, and held when missing. */
const GIT_PROTECTED = ['hooks', 'config'];
/** In a repository's git dir below the workspace: what the spec protects in the top one's, too. */
const NESTED_GIT_PROTECTED = ['hooks', 'config', 'commondir', 'config.worktree', 'modules', 'worktrees'];
/**
 * What ASRT kept unwritable in the working directory without being told (its
 * mandatory denies), kept so here when they exist. Not held when missing: an
 * empty .vscode or .idea would be noticed by the IDE.
 */
const WORKSPACE_PROTECTED = ['.gitmodules', '.vscode', '.idea', '.claude/commands', '.claude/agents', '.mcp.json'];

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
function replaceableLinkOn(start: string, mounted: (p: string) => boolean, readOnly: string[]): string | null {
  const fixed = (q: string) => !mounted(q) || readOnly.some((r) => inside(q, r));
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
function aliasesIn(tree: string, mounted: (p: string) => boolean, readOnly: string[]): string[] {
  const targets: string[] = [];
  let seen = 0;
  const visit = (p: string, depth: number) => {
    if (++seen > ALIAS_SCAN_LIMIT) throw new Error(`Airlock could not check ${tree} for links (over ${ALIAS_SCAN_LIMIT} entries), so nothing was launched.`);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      // Each hop of the chain, and each linked directory on the way, could be swapped by the
      // session for a link to something else: refused unless it is itself protected.
      const swappable = replaceableLinkOn(p, mounted, readOnly);
      if (swappable) throw new Error(`Airlock cannot protect ${p}: it resolves through ${swappable}, a link the session could replace. Nothing was launched.`);
      const lexical = path.resolve(path.dirname(p), fs.readlinkSync(p));
      let target = lexical;
      try { target = fs.realpathSync(p); } catch { /* dangling */ }
      if (!mounted(target) || readOnly.some((r) => inside(target, r))) return;
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
 * finds one above `dir` itself). Reading config runs no hook.
 */
export type GitConfigReader = (dir: string) => GitConfig | null;
const readGitConfig: GitConfigReader = (dir) => {
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0) return null;
  // git expands the paths (`--type=path`); --get-regexp exits 1 when nothing matches.
  const list = git('config', '-z', '--show-origin', '--type=path', '--get-regexp', '^(include\\.path|includeif\\..*\\.path)$');
  const hooks = git('config', '-z', '--show-origin', '--includes', '--type=path', '--get-regexp', '^core\\.hookspath$');
  const included = git('config', '--list', '--show-origin', '--includes', '-z');
  if (![0, 1].includes(list.status ?? -1) || ![0, 1].includes(hooks.status ?? -1) || included.status !== 0) return null;
  return { list: list.stdout, included: included.stdout, hooks: hooks.stdout, top: top.stdout.trim() || null };
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
 * What git's own config makes part of what host git runs in `dir`: the files config was read from,
 * every file an include names (active or not, holding anything or not), and the hooks directory
 * core.hooksPath names. Paths, absolute.
 */
function gitConfigDependencies(dir: string, read: GitConfigReader): { files: string[]; includes: string[]; hooksPaths: string[] } {
  const cfg = read(dir);
  if (!cfg) return { files: [], includes: [], hooksPaths: [] };
  const files: string[] = [];
  const includes: string[] = [];
  const hooksPaths: string[] = [];
  const originFile = (origin: string) => (origin.startsWith('file:') ? path.resolve(dir, origin.slice(5)) : null);
  for (const e of configEntries(cfg.included)) {
    const f = originFile(e.origin);
    if (f) files.push(f);
  }
  // Paths come expanded by git (`~`, `~user`); one still relative is read as git reads it: a hooks
  // path from the top of the working tree, an include from the directory of the file naming it.
  for (const e of configEntries(cfg.hooks)) {
    if (e.key === 'core.hookspath' && e.value) hooksPaths.push(path.resolve(cfg.top ?? dir, e.value));
  }
  for (const e of configEntries(cfg.list)) {
    const f = originFile(e.origin);
    if (f && e.value && (e.key === 'include.path' || /^includeif\..*\.path$/.test(e.key))) includes.push(path.resolve(path.dirname(f), e.value));
  }
  return { files: [...new Set(files)], includes: [...new Set(includes)], hooksPaths: [...new Set(hooksPaths)] };
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
  if (gitKind === 'file') {
    // Its git dir lives in the main checkout, outside the mounts: git in the guest could not work,
    // and the file would name the git dir host git uses.
    throw new Error(`Airlock cannot run in a linked git worktree yet (${workspace}): its git metadata is in the main checkout, outside what the machine mounts. Launch it from the main checkout.`);
  }
  if (gitKind === 'dir') pinned.push(dotGit);
  // No repository here: an empty, read-only .git keeps one from being planted for host git (which
  // passes over an empty .git, measured), for as long as a session runs.
  if (!gitKind && roots.includes(workspace)) {
    placeholders.push({ path: dotGit, kind: 'dir' });
    readOnly.push(dotGit);
  }
  const held = [...spec.filesystem.denyWrite, ...(gitKind === 'dir' ? GIT_PROTECTED.map((p) => path.join(dotGit, p)) : [])];
  // Repositories below the workspace: their metadata is protected as the top one's is, and a
  // pointer file (a submodule's) can never be redirected.
  const repos = [workspace];
  for (const g of nestedGitEntries(workspace)) {
    if (!mounted(g)) continue;
    // A pointer file (or a link, which the symbolic-link check below refuses).
    if (kindOfPath(g) === 'file') readOnly.push(g);
    else {
      pinned.push(g);
      held.push(...NESTED_GIT_PROTECTED.map((n) => path.join(g, n)));
    }
    repos.push(path.dirname(g));
  }
  // What git's config adds to what host git runs, read wherever host git may run (git finds the
  // repository above a workspace with none of its own): the config files, the files includes name,
  // and the hooks dir.
  for (const repo of repos) {
    const git = gitConfigDependencies(repo, readConfig);
    for (const p of [...git.hooksPaths, ...git.includes]) {
      if (mounted(p) && !kindOfPath(p)) {
        throw new Error(`Airlock cannot protect ${p}: git's config (core.hooksPath or an include) names it, it does not exist, and the session could create it. Nothing was launched.`);
      }
    }
    held.push(...[...git.files, ...git.includes, ...git.hooksPaths].filter((f) => mounted(f)));
  }
  const existing = WORKSPACE_PROTECTED.map((p) => path.join(workspace, p));
  for (const p of [...new Set([...held, ...existing].flatMap(expand).map((x) => path.resolve(x)))]) {
    if (!mounted(p) || roots.includes(p) || readOnly.includes(p)) continue;
    if (kindOf(p)) {
      readOnly.push(p);
      continue;
    }
    // Held only directly in a mount root or the pinned .git: the guest cannot swap either for a
    // link while a session runs, so creating the placeholder cannot be steered out of the mounts.
    const parent = path.dirname(p);
    if (!held.some((h) => path.resolve(h) === p) || !(roots.includes(parent) || pinned.includes(parent))) continue;
    const base = path.basename(p);
    placeholders.push(base in FILE_PLACEHOLDERS ? { path: p, kind: 'file', content: FILE_PLACEHOLDERS[base] } : { path: p, kind: 'dir' });
    readOnly.push(p);
  }

  // What a protected tree links to is protected with it, and what that links to, to a fixed point.
  for (const queue = [...readOnly]; queue.length;) {
    const p = queue.shift() as string;
    if (!kindOf(p)) continue;
    for (const t of aliasesIn(p, mounted, readOnly)) {
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
      if (!pinned.includes(a) && !readOnly.some((r) => inside(a, r))) pinned.push(a);
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

  return { mounts: roots.map((r) => ({ host: r, guest: r, readOnly: false as const })), pinned, readOnly, hidden, placeholders };
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** How /proc/self/mountinfo spells a path. */
const mountinfoPath = (p: string): string => p.replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011').replace(/\n/g, '\\012');

const GUEST_RUN = '/run/agenfk';
const GUEST_SESSIONS = `${GUEST_RUN}/sessions`;
const GUEST_HIDE = `${GUEST_RUN}/hide`;

/** The root script that applies the plan in the guest. Idempotent: a second session runs it again. */
export function guestSetupScript(plan: GuestPlan, uid: number, gid: number): string {
  const lines = [
    'set -e',
    `mounted() { P="$1" awk '$5 == ENVIRON["P"] { f = 1 } END { exit !f }' /proc/self/mountinfo; }`,
    // Hidden means a tmpfs over the path: a mount of any other kind there (a read-only bind) is not.
    `hidden() { P="$1" awk '$5 == ENVIRON["P"] { for (i = 7; i < NF; i++) if ($i == "-") { if ($(i + 1) == "tmpfs") f = 1; break } } END { exit !f }' /proc/self/mountinfo; }`,
    // Recursive binds: a pin or read-only bind made over a directory carries the mounts inside it.
    'pin() { mounted "$2" || mount --rbind "$1" "$1"; }',
    // Read-only even when already a mount (an earlier session's): the remount is what protects.
    'ro() { mounted "$2" || mount --rbind "$1" "$1"; mount -o remount,bind,ro "$1"; }',
    `hide_file() { hidden "$2" || { mount --bind ${GUEST_HIDE}/empty "$1"; mount -o remount,bind,ro "$1"; }; }`,
    'hide_dir() { hidden "$2" || mount -t tmpfs -o ro,size=4k,mode=000 tmpfs "$1"; }',
    `mkdir -p ${GUEST_SESSIONS} ${GUEST_HIDE}`,
    `chown ${uid}:${gid} ${GUEST_SESSIONS}`,
    `chmod 700 ${GUEST_SESSIONS}`,
    // The empty file hidden files are bound to, on a tmpfs of its own.
    `hidden ${GUEST_HIDE} || { mount -t tmpfs -o size=4k,mode=0755 tmpfs ${GUEST_HIDE}; : > ${GUEST_HIDE}/empty; chmod 444 ${GUEST_HIDE}/empty; mount -o remount,ro ${GUEST_HIDE}; }`,
    // Hidden first, then pins and read-only binds outer first.
    ...plan.hidden.map((h) => `hide_${h.kind} ${quote(h.path)} ${quote(mountinfoPath(h.path))}`),
    ...[...plan.pinned.map((p) => ['pin', p] as const), ...plan.readOnly.map((p) => ['ro', p] as const)]
      .sort((a, b) => a[1].split(path.sep).length - b[1].split(path.sep).length)
      .map(([op, p]) => `${op} ${quote(p)} ${quote(mountinfoPath(p))}`),
  ];
  return lines.join('\n');
}

/** The host's terminal settings a TUI needs; nothing else of the host's environment goes in. */
const PASSTHROUGH_ENV = ['TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE'];

/** Records its pid where a signal can find it, then becomes the command. */
const SESSION_LEADER = 'echo $$ > "$0" && exec "$@"';

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
  warn?: (message: string) => void;
  readGitConfig?: GitConfigReader;
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

type HeldPlaceholder = Placeholder & { dev: number; ino: number; parent: string };

/** Creating a machine pulls its image, which can take a while. */
const LOCK_TIMEOUT_MS = 300_000;
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
      readGitConfig: deps.readGitConfig ?? readGitConfig,
      warn: deps.warn ?? (() => undefined),
      image: deps.image,
      egress: deps.egress,
    };
  }

  async check(): Promise<RuntimeCheck> {
    const { platform, arch } = this.d;
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
      return { ok: false, reason: `smolvm is not installed. Airlock needs smolvm ${SMOLVM_VERSION}: install it, then launch again.` };
    }
    const found = /(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? 'an unknown version';
    if (r.code !== 0 || found !== SMOLVM_VERSION) {
      return { ok: false, reason: `Airlock needs smolvm ${SMOLVM_VERSION}; found ${found}. Install ${SMOLVM_VERSION}, then launch again.` };
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
      let pid = NaN;
      try { pid = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid); } catch { /* unreadable: stale */ }
      if (Number.isInteger(pid) && pid > 0 && this.d.pidAlive(pid)) return true;
      fs.rmSync(file, { force: true });
      return false;
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
      const st = fs.lstatSync(p.path);
      held.push({ ...p, dev: st.dev, ino: st.ino, parent: fs.realpathSync(path.dirname(p.path)) });
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
        if (st.dev !== p.dev || st.ino !== p.ino) continue;
        if (p.kind === 'dir' && st.isDirectory()) fs.rmdirSync(p.path);
        else if (p.kind === 'file' && st.isFile() && fs.readFileSync(p.path, 'utf8') === p.content) fs.rmSync(p.path);
      } catch { /* gone, or not empty: left alone */ }
    }
    fs.rmSync(path.join(this.machineDir(name), 'placeholders.json'), { force: true });
  }

  /**
   * Removes a lock whose holder is gone. Launchers doing so take turns on a
   * second lock, and each checks again under it that the lock is still that
   * same file and its holder still gone: a live owner's lock is never touched.
   * Returns false when another launcher holds the turn.
   */
  private breakStaleLock(lock: string, ino: number): boolean {
    const turn = `${lock}.break`;
    const mine = `${process.pid} ${crypto.randomBytes(8).toString('hex')}`;
    try {
      fs.writeFileSync(turn, mine, { flag: 'wx' });
    } catch {
      // Held for an instant; one left by a launcher that is gone is cleared - by its owner's
      // liveness, never its age, and only if it is still that same turn.
      try {
        const held = fs.readFileSync(turn, 'utf8');
        const owner = Number(held.split(' ')[0]);
        if (Number.isInteger(owner) && owner > 0 && !this.d.pidAlive(owner) && fs.readFileSync(turn, 'utf8') === held) fs.rmSync(turn);
      } catch { /* gone */ }
      return false;
    }
    try {
      const holder = Number(fs.readFileSync(lock, 'utf8').split(' ')[0]);
      if (fs.statSync(lock).ino === ino && Number.isInteger(holder) && holder > 0 && !this.d.pidAlive(holder)) fs.rmSync(lock);
    } catch { /* released meanwhile */ } finally {
      try { if (fs.readFileSync(turn, 'utf8') === mine) fs.rmSync(turn); } catch { /* not ours any more */ }
    }
    return true;
  }

  /**
   * Runs `fn` holding the machine's lock, across processes: registration,
   * create and start, mounts, setup, release and reset never interleave. The
   * lock names its owner (pid and a token), only its owner removes it, and one
   * whose holder is gone is broken (breakStaleLock).
   */
  private async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const lock = path.join(this.machineDir(name), 'lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const mine = `${process.pid} ${crypto.randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        fs.writeFileSync(lock, mine, { flag: 'wx' });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      let seen: { holder: number; ino: number } | null = null;
      try {
        const ino = fs.statSync(lock).ino;
        seen = { holder: Number(fs.readFileSync(lock, 'utf8').split(' ')[0]), ino };
      } catch { /* released meanwhile */ }
      // An empty lock is being written; only a holder seen to be gone is taken over.
      if (seen && Number.isInteger(seen.holder) && seen.holder > 0 && !this.d.pidAlive(seen.holder) && this.breakStaleLock(lock, seen.ino)) continue;
      if (Date.now() > deadline) throw new Error(`Airlock waited ${LOCK_TIMEOUT_MS / 1000}s for another session to finish starting or stopping the machine ${name}; nothing was launched.`);
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
    try {
      return await fn();
    } finally {
      try { if (fs.readFileSync(lock, 'utf8') === mine) fs.rmSync(lock); } catch { /* not ours any more */ }
    }
  }

  private async ensureMachine(name: string, workspace: string): Promise<MachineInfo> {
    const found = await this.machine(name);
    if (found) {
      const owner = found.labels?.['agenfk.workspace'];
      if (owner !== workspace) {
        throw new Error(`The smolvm machine ${name} belongs to ${owner ?? 'something else'}, not ${workspace}, so nothing was launched. Delete it with: smolvm machine delete --name ${name}`);
      }
      if (found.labels?.['agenfk.image'] === this.d.image) return found;
      if (found.state === 'running') {
        this.d.warn(`Airlock: the machine for ${workspace} runs an older image; it is rebuilt once no session is in it.`);
        return found;
      }
      await this.must(['machine', 'delete', '--name', name, '-f'], 'replace the machine of an older image');
    }
    await this.must([
      'machine', 'create', '--name', name, '-I', this.d.image,
      '--net', '--net-backend', 'virtio-net', '--trust-host-certs',
      '--label', `agenfk.workspace=${workspace}`, '--label', `agenfk.image=${this.d.image}`,
    ], `create the Airlock machine for ${workspace}`);
    return { name, state: 'stopped' };
  }

  /**
   * Attaches the plan's mounts. The guest is one file system, so while another
   * session is in the machine its mounts must be exactly this session's: a
   * mount either one lacks would be seen by the session not allowed it.
   */
  private async attachMounts(name: string, plan: GuestPlan, workspace: string, shared: boolean): Promise<void> {
    const r = await this.must(['machine', 'mount', 'ls', '--name', name, '--json'], 'list the machine\'s mounts');
    const have = JSON.parse(r.stdout || '[]') as Array<{ source: string; target: string }>;
    const key = (source: string, target: string) => `${source}\0${target}`;
    const want = new Set(plan.mounts.map((m) => key(m.host, m.guest)));
    const held = new Set(have.map((h) => key(h.source, h.target)));
    const foreign = have.filter((h) => !want.has(key(h.source, h.target))).map((h) => h.source);
    const extra = shared ? plan.mounts.filter((m) => !held.has(key(m.host, m.guest))).map((m) => m.host) : [];
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
  }

  /** Stops the machine and its interceptor, and takes the placeholders back. Called holding the lock. */
  private async stopMachine(name: string): Promise<void> {
    const r = await this.cli(['machine', 'stop', '--name', name]).catch((e) => ({ code: null, stdout: '', stderr: String((e as Error)?.message ?? e) }));
    // Only a stop smolvm confirms takes the protections down.
    if (r.code !== 0 && (await this.machine(name))?.state === 'running') {
      throw new Error(`Airlock could not stop the machine ${name}, so its protections stay in place (smolvm said: ${said(r) || `exit ${r.code}`}). Stop it with: smolvm machine stop --name ${name}`);
    }
    await this.d.egress.stop(name).catch(() => undefined);
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
  private async prepare(name: string, workspace: string, spec: SandboxSpec, sessionFile: string): Promise<GuestPlan> {
    return this.withLock(name, async () => {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify({ pid: process.pid, workspace }));
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
      const plan = guestPlanOf(spec, workspace, this.d.readGitConfig, new Set(this.readPlaceholders(name).map((p) => p.path)));
      const machine = await this.ensureMachine(name, workspace);
      const network = path.join(this.machineDir(name), 'network.json');
      const protections = path.join(this.machineDir(name), 'protections.json');
      const applied = JSON.stringify({ pinned: plan.pinned, readOnly: plan.readOnly, hidden: plan.hidden });
      const recorded = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
      if (shared && recorded(network) !== JSON.stringify(spec.network)) {
        // One interceptor decides for the whole machine: a session under another network policy waits its turn.
        throw new Error(`Another session is in the Airlock machine for ${workspace} under a different network policy, so nothing was launched. Launch it once that session has ended.`);
      }
      if (shared && recorded(protections) !== applied) {
        // One file system: protections added now would not reach what the session in it already holds open.
        throw new Error(`Another session is in the Airlock machine for ${workspace} with different file protections, so nothing was launched. Launch it once that session has ended.`);
      }
      if (machine.state !== 'running') {
        fs.writeFileSync(network, JSON.stringify(spec.network));
        fs.writeFileSync(protections, applied);
        const icpt = await this.d.egress.ensure(name, spec);
        await this.must(['machine', 'start', '--name', name, '--mediated-egress', '--egress-interceptor', icpt.address],
          `start the machine for ${workspace}`, { SMOLVM_INTERCEPTOR_TOKEN: icpt.token });
      }
      await this.attachMounts(name, plan, workspace, shared);
      this.ensurePlaceholders(name, plan.placeholders);
      await this.must(['machine', 'exec', '--name', name, '-u', 'root', '--', 'sh', '-c', guestSetupScript(plan, this.d.uid, this.d.gid)], 'protect the session\'s files in the machine');
      return plan;
    });
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

    let unwatch: (() => void) | null = null;
    let child: ChildProcess;
    try {
      await this.prepare(name, workspace, spec, sessionFile);
      const tell = hooks.onProxyDecision;
      if (tell) {
        const off = this.d.egress.watch(name, (decision) => { try { tell(decision); } catch { /* the report never decides anything */ } });
        unwatch = () => { off(); this.unwatchers.delete(unwatch!); };
        this.unwatchers.add(unwatch);
      }
      const tty = this.d.isTTY && spec.allowPty;
      const env = [
        ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        `HOME=${spec.home ?? this.d.hostEnv.HOME ?? '/root'}`,
        'TMPDIR=/tmp',
        ...PASSTHROUGH_ENV.filter((k) => this.d.hostEnv[k]).map((k) => `${k}=${this.d.hostEnv[k]}`),
      ];
      const args = [
        'machine', 'exec', '--name', name, '-i', ...(tty ? ['-t'] : []), '-u', user, '-w', command.cwd,
        ...env.flatMap((e) => ['-e', e]),
        '--', 'setsid', ...(tty ? ['-c'] : []), 'sh', '-c', SESSION_LEADER, pidFile, command.file, ...command.args,
      ];
      child = this.d.spawn(this.d.smolvmPath, args, { cwd: command.cwd, stdio: 'inherit' });
    } catch (e) {
      unwatch?.();
      await this.release(name, sessionFile, workspace);
      throw e;
    }

    // As the session's user, bounded: the pid file is the session's own.
    const inGuest = (script: string) => this.cli(['machine', 'exec', '--name', name, '--timeout', SIGNAL_TIMEOUT, '-u', user, '--', 'sh', '-c', READ_PID + script, pidFile]).catch(() => undefined);
    const kill = (signal: NodeJS.Signals): boolean => {
      const sig = signal.replace(/^SIG/, '');
      if (!/^[A-Z0-9]+$/.test(sig)) return false;
      void inGuest(`kill -${sig} -$pid`);
      return true;
    };
    let finishing: Promise<void> | null = null;
    // Once, whichever of exit and error comes: what the command left running in its group ends
    // with it, then the session is released. A release that fails (a stop smolvm did not
    // confirm) rejects `exited`: the machine may still be running.
    const finish = () => finishing ??= (async () => {
      await inGuest('kill -KILL -$pid 2>/dev/null; rm -f "$0"');
      unwatch?.();
      await this.release(name, sessionFile, workspace);
    })();
    const exited = new Promise<SandboxExit>((resolve, reject) => {
      child.once('exit', (code, signal) => { finish().then(() => resolve({ code, signal }), reject); });
      child.once('error', (e) => { finish().then(() => reject(e), reject); });
    });
    return { pid: child.pid, kill, exited };
  }

  /** Deletes the workspace's machine (`agenfk airlock reset`). Refused while a session is in it. */
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
