/**
 * Create a repository on GitHub, then clone it, then make it a project.
 *
 * THE ONLY DOOR THAT WRITES OUTSIDE THIS MACHINE, which is why it is the only
 * one that names the account it is acting as. A folder picked wrongly is
 * undone by deleting a row; a repository created in the wrong organisation is
 * a thing other people can already see.
 *
 * ORDER IS THE DESIGN. Remote first, then clone, then the project row: any
 * other order leaves rubbish behind when the far end refuses. A project
 * pointing at an empty directory, or a directory with no repository above it,
 * are both states somebody has to diagnose — whereas a refused creation with
 * nothing else attempted explains itself.
 *
 * ONE CREDENTIAL, and it is `gh`'s. The same reasoning githubAccount.ts writes
 * down: a second OAuth token would give one machine two GitHub identities that
 * can disagree, and the first time they did, `agenfk github setup` and this
 * dialog would tell the user opposite things about the same account.
 */

/** Runs `gh` with an ARGUMENT ARRAY — never a command string. */
export type GhRunner = (args: readonly string[]) => Promise<string>;

export interface Owner {
  readonly login: string;
  readonly avatarUrl: string | null;
  /** The signed-in user, as opposed to an organisation they belong to. */
  readonly self: boolean;
}

export interface CreateRepoRequest {
  readonly owner: string;
  readonly repo: string;
  readonly visibility: 'private' | 'public';
  /** What to call the PROJECT. The repository is named by `repo`. */
  readonly name?: string;
}

export interface CreateRepoDeps {
  readonly gh: GhRunner;
  /** Where the clone lands. Main's value; never the renderer's. */
  readonly into: string;
  readonly exists: (path: string) => boolean;
  readonly clone: (url: string, target: string, onLine: (line: string) => void) => Promise<void>;
  readonly addProject: (root: string, name: string) => Promise<{ id: string; name: string }>;
}

/** GitHub's rules for a repository name, as far as they are ours to enforce. */
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Who this machine can create repositories as: the user, then their orgs.
 *
 * Failure is not an error here — a machine with no `gh`, or a `gh` that is
 * logged out, has no owners, and the screen says so rather than showing an
 * empty menu that looks broken.
 */
export async function listOwners(gh: GhRunner): Promise<Owner[]> {
  let self: Owner | null = null;
  try {
    const me = JSON.parse(await gh(['api', 'user']));
    if (me?.login) self = { login: String(me.login), avatarUrl: me.avatar_url ?? null, self: true };
  } catch {
    return [];
  }
  let orgs: Owner[] = [];
  try {
    /*
     * Organisations the token can actually act in. `/user/orgs` answers with
     * membership, which is the closest thing to "may create here" that does
     * not cost a request per org — GitHub refuses the create itself if the
     * membership does not carry the right, and that refusal is reported in
     * its own words.
     */
    const list = JSON.parse(await gh(['api', 'user/orgs', '--paginate']));
    if (Array.isArray(list)) {
      orgs = list
        .filter(o => o?.login)
        .map(o => ({ login: String(o.login), avatarUrl: o.avatar_url ?? null, self: false }));
    }
  } catch {
    // An account with no orgs and an account whose org lookup failed look the
    // same from here, and both can still create under the user themselves.
  }
  return self ? [self, ...orgs] : orgs;
}

/**
 * Create it, clone it, and hand back the project.
 *
 * @throws with GitHub's own words when it refuses — a taken name is GitHub's
 * answer, not ours to paraphrase.
 */
export async function createRepository(
  req: CreateRepoRequest,
  deps: CreateRepoDeps,
  onLine: (line: string) => void = () => {},
): Promise<{ id: string; name: string }> {
  const owner = req.owner.trim();
  const repo = req.repo.trim();
  if (!owner) throw new Error('Choose who the repository belongs to.');
  if (!repo) throw new Error('A repository name is required.');
  /*
   * Checked here as well as by GitHub, because this value becomes a DIRECTORY
   * on the way back: a name carrying a slash or a `..` would place the clone
   * somewhere the person never chose. GitHub would refuse it too — but only
   * after the folder question is already decided.
   */
  if (!REPO_NAME.test(repo)) {
    throw new Error('A repository name can only contain letters, numbers, dot, dash and underscore.');
  }

  const target = `${deps.into.replace(/\/+$/, '')}/${repo}`;
  // Refused BEFORE the remote is created: otherwise the repository exists on
  // GitHub and the clone has nowhere to go.
  if (deps.exists(target)) throw new Error(`${target} already exists.`);

  // 1. The remote. If this fails, nothing else has happened yet.
  await deps.gh(['repo', 'create', `${owner}/${repo}`, `--${req.visibility}`]);

  // 2. The clone. The repository is real now, so a failure here names it —
  //    telling somebody their repository was created is the difference between
  //    a retry and a duplicate.
  const url = `https://github.com/${owner}/${repo}.git`;
  try {
    await deps.clone(url, target, onLine);
  } catch (e: any) {
    throw new Error(
      `${e?.message ?? e}\n${owner}/${repo} WAS created on GitHub. Clone it again rather than creating it twice.`,
    );
  }

  // 3. The project row, last, because it is the only step this app can redo
  //    on its own.
  return deps.addProject(target, (req.name ?? '').trim() || repo);
}
