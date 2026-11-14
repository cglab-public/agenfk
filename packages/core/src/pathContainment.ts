/**
 * Is this path inside that root?
 *
 * Separated from the filesystem so the cases can be written down, but the
 * CALLER must hand in paths that have already been resolved through
 * `fs.realpathSync` — this function cannot follow a symlink, and a symlink is
 * the thing a lexical check misses. Git worktrees and node_modules are full of
 * them, so that is not a theoretical gap.
 *
 * Why the containment matters more here than it might elsewhere: the server
 * listens on loopback with no authentication, and its CORS allowlist trusts
 * any localhost origin. A listing endpoint that accepts an arbitrary path is
 * filesystem read access for any page open in the user's browser.
 */
export function isInsideRoot(root: string, candidate: string | null | undefined): boolean {
  if (typeof root !== 'string' || !root.trim()) return false;
  if (typeof candidate !== 'string' || !candidate.trim()) return false;

  const normalise = (p: string): string => {
    const parts = p.replace(/\\/g, '/').split('/');
    const out: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      // Resolved, not rejected: the question is where the path ENDS UP, and a
      // `..` in the middle of an otherwise-contained path is legitimate.
      if (part === '..') { out.pop(); continue; }
      out.push(part);
    }
    return '/' + out.join('/');
  };

  const base = normalise(root);
  const target = normalise(candidate);
  if (target === base) return true;
  // The separator is the whole point: without it `/tmp/wt/repo-secrets`
  // passes as inside `/tmp/wt/repo`, which is a different directory.
  return target.startsWith(base === '/' ? '/' : `${base}/`);
}

/**
 * The contained path, or null.
 *
 * THE VALUE, NOT A VERDICT, and that is the whole difference from
 * `isInsideRoot`. A boolean leaves the caller holding the UNCHECKED variable:
 *
 *     if (!isInsideRoot(root, target)) return res.status(403)...
 *     fs.readdirSync(target)            // <- the one that was never checked
 *
 * Correct as written, and the shape that rots. The check and the use are two
 * separate mentions of one name, so nothing stops an edit landing between them
 * or a second `fs` call being added below without the guard. Returning the path
 * removes the second variable: what reaches the filesystem is what passed.
 *
 * It also happens to be what makes the containment legible to static analysis,
 * which is how these came to light - but that is a consequence. Silencing the
 * tool with an inline suppression would have left the defect shape untouched
 * and the next sink just as unguarded.
 *
 * Returns null rather than a "sanitised" fallback on purpose. Null is not a
 * path, so a caller who ignores it fails loudly on the first `fs` call; a
 * plausible-looking string would be used in silence.
 */
export function containedPath(
  root: string,
  candidate: string | null | undefined,
): string | null {
  return isInsideRoot(root, candidate) ? (candidate as string) : null;
}

/**
 * A path with its symlinks resolved, including one that does not exist yet.
 *
 * `path.resolve` collapses `..` and stops there, which is why a containment
 * check built on it is defeated by a single link. `fs.realpathSync` follows
 * links but throws on a path that is not there - and the interesting case is
 * exactly a target about to be CREATED. So this resolves the deepest ancestor
 * that does exist and re-attaches the rest.
 *
 * ONE COPY. This lived twice: `canonical` in worktrees.ts and `realBase` in
 * server.ts, identical line for line, with a comment on the second claiming
 * they were separate because they "answer for different trust boundaries".
 * That was a rationalisation of a copy-paste - both answer the same question,
 * and two copies of a security primitive is two places for it to drift.
 *
 * NOT A SANITISER, and deliberately not modelled as one. It resolves; it does
 * not decide. What comes out is where the caller's path LANDS, which is the
 * input to a containment check rather than the result of one. Anything that
 * treats this return value as safe has skipped the actual check.
 *
 * `deps` is injected so this stays testable without a filesystem, and so the
 * two callers cannot quietly diverge on which fs they mean.
 */
export function resolveThroughLinks(
  p: string,
  deps: {
    readonly resolve: (x: string) => string;
    readonly dirname: (x: string) => string;
    readonly basename: (x: string) => string;
    readonly join: (...xs: string[]) => string;
    readonly exists: (x: string) => boolean;
    readonly realpath: (x: string) => string;
  },
): string {
  const abs = deps.resolve(p);
  const tail: string[] = [];
  let head = abs;
  while (!deps.exists(head)) {
    const parent = deps.dirname(head);
    // The filesystem root: nothing above it to resolve, and without this the
    // walk never moves and never ends.
    if (parent === head) return abs;
    tail.unshift(deps.basename(head));
    head = parent;
  }
  try {
    return deps.join(deps.realpath(head), ...tail);
  } catch {
    // An unreadable ancestor is not evidence of anything. The unresolved
    // absolute path is the honest answer, and the containment check that
    // follows still has to pass.
    return abs;
  }
}
