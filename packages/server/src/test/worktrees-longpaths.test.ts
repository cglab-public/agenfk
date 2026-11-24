/**
 * GitHub #269: Windows `git worktree add` fails with "Filename too long".
 *
 * Three contracts, all about what worktrees.ts asks git and tells the user:
 *   1. every git call it makes carries `-c core.longpaths=true` (a no-op off
 *      Windows, and scoped to the one invocation - no global config touched);
 *   2. a failed `worktree add` is reported without git's progress noise, and a
 *      too-long path is named as such - without telling the user to set the
 *      option we already pass;
 *   3. a rollback that itself fails never hides the original error.
 *
 * child_process is wrapped, not replaced: git really runs against a temp repo,
 * the wrapper only records argv and, when a test asks, injects a failure. A
 * real long-path checkout is not attempted - it would only fail on Windows
 * without LongPathsEnabled, which is exactly the machine-dependence a test
 * must not have.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Handler = (args: string[], runReal: () => unknown) => unknown;

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  /** Return undefined to let the call through to real git. */
  inject: null as null | Handler,
}));

vi.mock('child_process', async (importOriginal) => {
  const real: any = await importOriginal();
  const execFileSync = (...a: any[]) => {
    const [cmd, args] = a;
    if (cmd === 'git' && Array.isArray(args)) {
      h.calls.push([...args]);
      if (h.inject) {
        const out = h.inject(args, () => real.execFileSync(...a));
        if (out !== undefined) return out;
      }
    }
    return real.execFileSync(...a);
  };
  return { ...real, execFileSync, default: { ...real, execFileSync } };
});

import * as worktrees from '../worktrees.js';
import { createWorktree, listWorktrees, removeWorktree } from '../worktrees.js';

// Fixture git goes around the recorder, so only the module's own calls are seen.
const realCp = await vi.importActual<typeof import('child_process')>('child_process');
const git = (cwd: string, ...args: string[]): string =>
  realCp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const LONGPATHS = ['-c', 'core.longpaths=true'];

const isWorktreeAdd = (args: string[]): boolean => {
  const i = args.indexOf('worktree');
  return i >= 0 && args[i + 1] === 'add';
};
const isBranchDelete = (args: string[]): boolean => {
  const i = args.indexOf('branch');
  return i >= 0 && (args.includes('-D') || args.includes('--delete'));
};

/** An error shaped like the one execFileSync throws for a non-zero git exit. */
function gitFailure(stderr: string): Error {
  const e: any = new Error(`Command failed: git worktree add\n${stderr}`);
  e.status = 128;
  e.stderr = stderr;
  e.stdout = '';
  return e;
}

const FILE_1 = 'docs/spec/api/postman/CG-content article read API (DataService integration)/Articles/List published articles, a page at a time.request.yaml';
const FILE_2 = 'docs/spec/api/postman/CG-content article read API (DataService integration)/Articles/Read one article, every property decoded.request.yaml';
const FILE_3 = 'docs/spec/api/postman/CG-content article read API (DataService integration)/Service/Check whose session the cookie carries.request.yaml';

/** The issue's stderr, with git's real `\r` progress redraws. */
const WINDOWS_STDERR = (branch: string): string =>
  `Preparing worktree (new branch '${branch}')\n`
  + 'Updating files:  62% (620/989)\rUpdating files:  91% (900/989)\r'
  + `error: unable to create file ${FILE_1}: Filename too long\n`
  + `error: unable to create file ${FILE_2}: Filename too long\n`
  + `error: unable to create file ${FILE_3}: Filename too long\n`
  + 'Updating files: 100% (989/989)\rUpdating files: 100% (989/989), done.\n'
  + "fatal: Could not reset index file to revision 'HEAD'.\n";

const GLIBC_FILE = 'deep/a/b/c/some-very-long-generated-name.txt';
const GLIBC_STDERR = (branch: string): string =>
  `Preparing worktree (new branch '${branch}')\n`
  + 'Updating files:  40% (4/10)\rUpdating files:  80% (8/10)\r'
  + `error: unable to create file ${GLIBC_FILE}: File name too long\n`
  + 'Updating files: 100% (10/10), done.\n'
  + "fatal: Could not reset index file to revision 'HEAD'.\n";

const OTHER_STDERR = (branch: string): string =>
  `Preparing worktree (new branch '${branch}')\n`
  + 'Updating files:  50% (1/2)\rUpdating files: 100% (2/2), done.\n'
  + "fatal: unable to write new index file\n";

/** "...the path is too long", in our words rather than git's "Filename too long". */
const SAYS_PATH_TOO_LONG = /\bpath\b[^]*too long|too long[^]*\bpath\b/i;
/** The message says the rollback happened, so the user knows a retry starts clean. */
const SAYS_NOTHING_LEFT = /left behind|rolled back|cleaned up/i;
/** Advice to set the option we already pass is wrong advice. */
const LONGPATHS_ADVICE = /core\.longpaths\s*(=\s*)?true|git config/i;
/** The specific claim that the rollback was complete. */
const CLAIMS_CLEAN_SLATE = /nothing was left behind/i;

let repo: string;
let root: string;

beforeEach(() => {
  h.calls = [];
  h.inject = null;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wtlp-repo-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wtlp-root-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
});

afterEach(() => {
  h.inject = null;
  for (const dir of [repo, root]) {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('every git call carries -c core.longpaths=true (#269)', () => {
  it('T1: createWorktree, listWorktrees and removeWorktree all lead with the option', () => {
    git(repo, 'branch', 'feature/existing');
    const a = createWorktree({ repoRoot: repo, root, branchName: 'feature/new' });
    createWorktree({ repoRoot: repo, root, branchName: 'feature/new' }); // reuse path
    createWorktree({ repoRoot: repo, root, branchName: 'feature/existing' }); // existing-branch path
    createWorktree({ repoRoot: repo, root, branchName: 'feature/started', startPoint: 'main' });
    fs.rmSync(a.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    createWorktree({ repoRoot: repo, root, branchName: 'feature/new' }); // prune path
    listWorktrees(repo);
    removeWorktree(repo, a.path);
    removeWorktree(repo, a.path); // fallback path: remove fails, prune runs

    expect(h.calls.length, 'the recorder saw no git calls - fixture is wrong').toBeGreaterThan(0);
    expect(h.calls.some(isWorktreeAdd), 'fixture never reached worktree add').toBe(true);
    const missing = h.calls.filter(args => args[0] !== LONGPATHS[0] || args[1] !== LONGPATHS[1]);
    expect(missing.map(a => a.join(' ')), 'git calls without -c core.longpaths=true').toEqual([]);
  });

  it('T1b: the rollback\'s own git calls carry it too', () => {
    h.inject = (args, runReal) => {
      if (isWorktreeAdd(args)) { runReal(); throw gitFailure(OTHER_STDERR('feature/rolled')); }
      return undefined;
    };
    expect(() => createWorktree({ repoRoot: repo, root, branchName: 'feature/rolled' })).toThrow();
    const missing = h.calls.filter(args => args[0] !== LONGPATHS[0] || args[1] !== LONGPATHS[1]);
    expect(missing.map(a => a.join(' '))).toEqual([]);
  });
});

describe('a failed worktree add is reported legibly (#269)', () => {
  it('T2: the issue\'s Windows stderr becomes a "path too long" message naming the first file', () => {
    const branch = 'feature/long';
    h.inject = (args) => { if (isWorktreeAdd(args)) throw gitFailure(WINDOWS_STDERR(branch)); return undefined; };

    let message = '';
    try { createWorktree({ repoRoot: repo, root, branchName: branch }); } catch (e: any) { message = e.message; }

    expect(message.startsWith(`git worktree add failed for branch '${branch}':`), message).toBe(true);
    expect(message).toMatch(SAYS_PATH_TOO_LONG);
    expect(message).toContain(FILE_1);
    expect(message).not.toContain('Updating files');
    expect(message).not.toContain('Preparing worktree');
    expect(message).not.toMatch(LONGPATHS_ADVICE);
    expect(message).toMatch(SAYS_NOTHING_LEFT);
  });

  it('T3: glibc\'s "File name too long" is classified the same way', () => {
    const branch = 'feature/long-linux';
    h.inject = (args) => { if (isWorktreeAdd(args)) throw gitFailure(GLIBC_STDERR(branch)); return undefined; };

    let message = '';
    try { createWorktree({ repoRoot: repo, root, branchName: branch }); } catch (e: any) { message = e.message; }

    expect(message.startsWith(`git worktree add failed for branch '${branch}':`), message).toBe(true);
    expect(message).toMatch(SAYS_PATH_TOO_LONG);
    expect(message).toContain(GLIBC_FILE);
    expect(message).not.toContain('Updating files');
    expect(message).not.toMatch(LONGPATHS_ADVICE);
  });

  it('T4: any other failure keeps git\'s detail, minus the progress lines', () => {
    const branch = 'feature/other';
    h.inject = (args) => { if (isWorktreeAdd(args)) throw gitFailure(OTHER_STDERR(branch)); return undefined; };

    let message = '';
    try { createWorktree({ repoRoot: repo, root, branchName: branch }); } catch (e: any) { message = e.message; }

    expect(message.startsWith(`git worktree add failed for branch '${branch}':`), message).toBe(true);
    expect(message).toContain('fatal: unable to write new index file');
    expect(message).not.toContain('Updating files');
    expect(message).not.toContain('Preparing worktree');
    expect(message).not.toMatch(/too long/i);
  });

  it('T5: a rollback that fails never replaces the original error', () => {
    const branch = 'feature/rollback-breaks';
    h.inject = (args, runReal) => {
      // Real add first, so the branch and worktree exist and the rollback has work to do.
      if (isWorktreeAdd(args)) { runReal(); throw gitFailure(OTHER_STDERR(branch)); }
      if (isBranchDelete(args)) throw new Error('rollback exploded: branch -D failed');
      return undefined;
    };

    let message = '';
    try { createWorktree({ repoRoot: repo, root, branchName: branch }); } catch (e: any) { message = e.message; }

    expect(h.calls.some(isBranchDelete), 'the rollback never tried to delete the branch it created').toBe(true);
    expect(message.startsWith(`git worktree add failed for branch '${branch}':`), message).toBe(true);
    expect(message).toContain('fatal: unable to write new index file');
    expect(message).not.toContain('rollback exploded');
    // The steps before the failing one still ran.
    expect(listWorktrees(repo).map(w => w.branchName)).not.toContain(branch);
  });

  it('T6: a too-long failure whose rollback could not delete the branch does not claim a clean slate, and names the branch', () => {
    const branch = 'feature/long-and-stuck';
    h.inject = (args, runReal) => {
      if (isWorktreeAdd(args)) { runReal(); throw gitFailure(WINDOWS_STDERR(branch)); }
      if (isBranchDelete(args)) throw new Error('branch -D failed: file held by another process');
      return undefined;
    };

    let message = '';
    try { createWorktree({ repoRoot: repo, root, branchName: branch }); } catch (e: any) { message = e.message; }

    expect(h.calls.some(isBranchDelete), 'the rollback never tried to delete the branch it created').toBe(true);
    expect(git(repo, 'branch', '--list', branch).trim(), 'fixture: the branch should really still be there').not.toBe('');
    expect(message.startsWith(`git worktree add failed for branch '${branch}':`), message).toBe(true);
    expect(message).toMatch(SAYS_PATH_TOO_LONG);
    expect(message).not.toMatch(CLAIMS_CLEAN_SLATE);
    expect(message).toContain(`'${branch}'`);
    expect(message).toMatch(/still there|by hand|remains/i);
    expect(message).not.toMatch(LONGPATHS_ADVICE);
    expect(message).not.toContain('file held by another process');
  });

  it('T7: any other failure with an incomplete rollback says what remains, keeping git\'s detail', () => {
    const branch = 'feature/other-and-stuck';
    h.inject = (args, runReal) => {
      if (isWorktreeAdd(args)) { runReal(); throw gitFailure(OTHER_STDERR(branch)); }
      if (isBranchDelete(args)) throw new Error('branch -D failed');
      return undefined;
    };

    let message = '';
    try { createWorktree({ repoRoot: repo, root, branchName: branch }); } catch (e: any) { message = e.message; }

    expect(message).toContain('fatal: unable to write new index file');
    expect(message).not.toMatch(CLAIMS_CLEAN_SLATE);
    expect(message).toMatch(/still there|by hand|remains/i);
    expect(message).not.toMatch(/too long/i);
  });
});

describe('describeWorktreeAddFailure (pure)', () => {
  const describeFailure = (b: string, s: string): string =>
    (worktrees as any).describeWorktreeAddFailure(b, s);

  it('is exported', () => {
    expect(typeof (worktrees as any).describeWorktreeAddFailure).toBe('function');
  });

  it('turns the issue\'s stderr into a path-too-long message naming the first file', () => {
    const msg = describeFailure('feature/x', WINDOWS_STDERR('feature/x'));
    expect(msg.startsWith("git worktree add failed for branch 'feature/x':")).toBe(true);
    expect(msg).toMatch(SAYS_PATH_TOO_LONG);
    expect(msg).toContain(FILE_1);
    expect(msg).not.toContain('Updating files');
    expect(msg).not.toContain('Preparing worktree');
    expect(msg).not.toMatch(LONGPATHS_ADVICE);
    expect(msg).toMatch(SAYS_NOTHING_LEFT);
  });

  it('classifies glibc\'s "File name too long" the same way', () => {
    const msg = describeFailure('feature/y', GLIBC_STDERR('feature/y'));
    expect(msg.startsWith("git worktree add failed for branch 'feature/y':")).toBe(true);
    expect(msg).toMatch(SAYS_PATH_TOO_LONG);
    expect(msg).toContain(GLIBC_FILE);
    expect(msg).not.toMatch(LONGPATHS_ADVICE);
  });

  it('classifies a too-long failure even when git names no file', () => {
    const msg = describeFailure('feature/z', "fatal: cannot create directory at 'a/b': Filename too long\n");
    expect(msg.startsWith("git worktree add failed for branch 'feature/z':")).toBe(true);
    expect(msg).toMatch(SAYS_PATH_TOO_LONG);
    expect(msg).not.toMatch(LONGPATHS_ADVICE);
  });

  it('keeps any other failure\'s detail, minus progress lines, CRLF included', () => {
    const stderr = "Preparing worktree (new branch 'feature/w')\r\nUpdating files:  50% (1/2)\rUpdating files: 100% (2/2), done.\r\nfatal: '/x' already exists\r\n";
    const msg = describeFailure('feature/w', stderr);
    expect(msg.startsWith("git worktree add failed for branch 'feature/w':")).toBe(true);
    expect(msg).toContain("fatal: '/x' already exists");
    expect(msg).not.toContain('Updating files');
    expect(msg).not.toContain('Preparing worktree');
    expect(msg).not.toMatch(/too long/i);
  });

  it('still carries the prefix when git said nothing', () => {
    expect(describeFailure('feature/q', '').startsWith("git worktree add failed for branch 'feature/q':")).toBe(true);
  });

  it('with a clean rollback outcome passed explicitly, still says nothing was left behind', () => {
    const msg = (worktrees as any).describeWorktreeAddFailure('feature/x', WINDOWS_STDERR('feature/x'), { clean: true, remains: [] });
    expect(msg).toMatch(CLAIMS_CLEAN_SLATE);
    expect(msg).toMatch(SAYS_NOTHING_LEFT);
    expect(msg).not.toMatch(LONGPATHS_ADVICE);
  });

  it('with an unclean rollback outcome, does not claim a clean slate and names what remains', () => {
    const dir = '/wt/agenfk/feature-x-1a2b3c';
    const msg = (worktrees as any).describeWorktreeAddFailure('feature/x', WINDOWS_STDERR('feature/x'), {
      clean: false,
      remains: [{ kind: 'branch', name: 'feature/x' }, { kind: 'directory', name: dir }],
    });
    expect(msg).toMatch(SAYS_PATH_TOO_LONG);
    expect(msg).not.toMatch(CLAIMS_CLEAN_SLATE);
    expect(msg).toContain("'feature/x'");
    expect(msg).toContain(dir);
    expect(msg).toMatch(/by hand/i);
    expect(msg).not.toMatch(LONGPATHS_ADVICE);
  });

  it('with an unclean outcome on a non-too-long failure, keeps git\'s detail and names what remains', () => {
    const msg = (worktrees as any).describeWorktreeAddFailure('feature/w', 'fatal: unable to write new index file\n', {
      clean: false, remains: [{ kind: 'registration', name: '/wt/x' }],
    });
    expect(msg).toContain('fatal: unable to write new index file');
    expect(msg).toContain('/wt/x');
    expect(msg).not.toMatch(CLAIMS_CLEAN_SLATE);
    expect(msg).not.toMatch(/too long/i);
    expect(msg).not.toMatch(LONGPATHS_ADVICE);
  });

  it('does not diagnose the OS long-path setting as a certainty', () => {
    const msg = describeFailure('feature/x', WINDOWS_STDERR('feature/x'));
    expect(msg).not.toMatch(/switched off at the OS level/i);
    expect(msg).toMatch(/may still exceed/i);
  });
});
