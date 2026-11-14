/**
 * Who the machine is signed in to GitHub as.
 *
 * The settings screen wants an avatar, a name and an email. `GET /github/status`
 * has none of those — it is project-scoped and answers which REPO a card maps
 * to, which is a different question with a different answer.
 *
 * The temptation is to fill the gap with an OAuth app: a client id, a callback
 * URL, a token in the database. That would give one machine two GitHub
 * identities that can disagree, and the first time they did, `agenfk github
 * setup` (which checks `gh`) and the settings screen (which would check ours)
 * would tell the user opposite things about the same account.
 *
 * So there is no second credential. `gh` already holds one, the import flow
 * already depends on it, and `gh api user` is that credential asked about
 * itself. This module is the translation, nothing more.
 *
 * Everything runs through an injected runner, the way `worktrees.ts` does, so
 * the cases worth testing — gh absent, gh present but logged out, gh answering
 * an upgrade notice instead of JSON — can be written down rather than waited
 * for.
 */

/** Runs `gh` with an ARGUMENT ARRAY and returns stdout, or throws. */
export type GhRunner = (args: readonly string[]) => string;

export type GitHubAccount =
  | {
      connected: true;
      login: string;
      /** Null where GitHub itself has none; never the string "null". */
      name: string | null;
      email: string | null;
      avatarUrl: string | null;
    }
  | { connected: false; reason: 'gh_missing' | 'not_authenticated' | 'unreadable' };

/**
 * Why the lookup failed, in terms the screen can turn into an instruction.
 *
 * "Install the GitHub CLI" and "run gh auth login" are different sentences and
 * only one of them is useful at a time. Showing the wrong one sends somebody
 * after a fix they already have, or after a command they do not.
 */
function reasonFor(err: unknown): 'gh_missing' | 'not_authenticated' | 'unreadable' {
  const e = err as NodeJS.ErrnoException & { stderr?: unknown };
  if (e?.code === 'ENOENT') return 'gh_missing';
  const stderr = typeof e?.stderr === 'string' ? e.stderr : String(e?.stderr ?? '');
  const message = `${stderr}\n${e?.message ?? ''}`;
  if (/not logged in|auth login|authentication|credentials|401/i.test(message)) {
    return 'not_authenticated';
  }
  return 'unreadable';
}

/**
 * An avatar URL that is safe to hand to an `<img src>`.
 *
 * The value comes from a remote API. Treating it as trusted because it arrived
 * through "our own gh" is how a `javascript:` or `data:` URL reaches the DOM —
 * the credential being ours says nothing about what the other end returned.
 */
function safeAvatar(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const url = new URL(raw);
    // https only. In practice this is always avatars.githubusercontent.com, so
    // allowing http costs nothing to refuse and buys the guarantee that a value
    // from a remote API cannot turn into a cleartext beacon to an arbitrary
    // host the moment somebody stands between us and GitHub.
    return url.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/** A field GitHub may legitimately leave empty. */
const optional = (raw: unknown): string | null =>
  typeof raw === 'string' && raw !== '' ? raw : null;

export function readGitHubAccount(run: GhRunner): GitHubAccount {
  let raw: string;
  try {
    raw = run(['api', 'user']);
  } catch (err) {
    return { connected: false, reason: reasonFor(err) };
  }
  let user: Record<string, unknown>;
  try {
    user = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // gh prints release notices and deprecation warnings on stdout. A parse
    // failure has to read as "we could not tell", never as connected.
    return { connected: false, reason: 'unreadable' };
  }
  // `{}` parses, and so does `{"message":"Bad credentials"}`. An account with
  // no login is not an account.
  if (typeof user.login !== 'string' || user.login === '') {
    return { connected: false, reason: 'unreadable' };
  }
  return {
    connected: true,
    login: user.login,
    name: optional(user.name),
    email: optional(user.email),
    avatarUrl: safeAvatar(user.avatar_url),
  };
}

/**
 * Log the GitHub CLI out.
 *
 * `--hostname` AND `--user` together are what make this non-interactive. With
 * either missing, `gh` prompts — and a prompt on a process with no TTY is a
 * request that hangs rather than one that fails.
 *
 * Which is also why the login is read first: there is no way to name the
 * account without asking, and running the logout blind would be the hanging
 * case. The host comes from GH_HOST so an enterprise user is not logged out of
 * the wrong one.
 */
export function signOutGitHub(
  run: GhRunner,
  // Indexed rather than a named optional field: `process.env` is a
  // `ProcessEnv`, which TypeScript refuses to assign to `{ GH_HOST?: string }`
  // because the two have no declared property in common.
  env: Record<string, string | undefined>,
): { signedOut: boolean; error?: string } {
  const account = readGitHubAccount(run);
  if (!account.connected) {
    return { signedOut: false, error: `Not signed in (${account.reason}).` };
  }
  const host = env.GH_HOST && env.GH_HOST.trim() !== '' ? env.GH_HOST.trim() : 'github.com';
  try {
    run(['auth', 'logout', '--hostname', host, '--user', account.login]);
    return { signedOut: true };
  } catch (err) {
    // The message, verbatim, because the useful ones are specific: gh refuses
    // to log out of a host whose token came from the environment, and the
    // screen showing "Not connected" over a credential that is still there and
    // still works would be a lie the user cannot debug.
    const e = err as Error & { stderr?: unknown };
    const stderr = typeof e?.stderr === 'string' ? e.stderr : String(e?.stderr ?? '');
    return { signedOut: false, error: (stderr || e?.message || 'gh auth logout failed').trim() };
  }
}
