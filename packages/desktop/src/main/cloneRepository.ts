/**
 * A repository becomes a project.
 *
 * The difference from picking a folder is that this WRITES TO THE USER'S DISK,
 * and everything else here follows from that: the destination is settled
 * before anything runs, a failure creates no project, and the directory left
 * behind is named in the error so it can be removed on purpose rather than
 * discovered later.
 *
 * Credentials are git's own. The clone runs as the user's git, so keys and
 * helpers behave exactly as they do in a terminal — and an authentication
 * failure arrives in git's words instead of translated into ours.
 */

export interface CloneRequest {
  /** What to clone. Text from the renderer; never a path it invented. */
  readonly url: string;
  /** The directory the clone lands IN. Chosen by the native picker, in main. */
  readonly into: string;
  /**
   * What to call the project. Text, like the URL — the screen offers the
   * repository's own name and lets it be changed, and an empty one falls back
   * to the folder the clone made rather than refusing the whole clone.
   */
  readonly name?: string;
}

export interface CloneDeps {
  readonly exists: (path: string) => boolean;
  readonly clone: (url: string, target: string, onLine: (line: string) => void) => Promise<void>;
  readonly addProject: (root: string, name: string) => Promise<{ id: string; name: string }>;
}

/**
 * The folder a repository URL becomes.
 *
 * Every shape git accepts ends in the repository's name, optionally with
 * `.git` and a trailing slash: scp-style `git@host:team/repo.git`, https, and
 * ssh:// with a port.
 */
export function folderNameFor(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const last = trimmed.split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

export async function cloneRepository(
  req: CloneRequest,
  deps: CloneDeps,
  onLine: (line: string) => void = () => {},
): Promise<{ id: string; name: string }> {
  const url = (req.url ?? '').trim();
  const into = (req.into ?? '').trim().replace(/\/+$/, '');

  if (!url) throw new Error('A repository URL is required.');
  if (!into) throw new Error('A folder to clone into is required.');
  /*
   * A "URL" beginning with a dash is an ARGUMENT to git, not an address:
   * `--upload-pack=<command>` runs that command. execFile already keeps this
   * out of a shell; this keeps it out of argv.
   */
  if (url.startsWith('-')) throw new Error('That is not a repository URL.');
  /*
   * `ext::<command>` is a git TRANSPORT that runs the command it names
   * (git-remote-ext). Modern git refuses it unless the config says otherwise,
   * which means today's protection is somebody else's ~/.gitconfig — and the
   * caller here is a paste into a text field. Refused by name as well, so the
   * guarantee is ours; the clone also runs with the transport disabled.
   */
  if (/^ext::/i.test(url)) throw new Error('That transport runs a command instead of fetching a repository.');

  const folder = folderNameFor(url);
  if (!folder) throw new Error('That is not a repository URL — it names no repository.');
  /*
   * The name has to be ONE segment. Splitting on / and : leaves a backslash
   * untouched, and on Windows `https://h/a/..\..\Startup\x` would name a
   * folder that walks out of the chosen directory — the existence check below
   * cannot refuse what does not exist yet. `.` and `..` are the same escape by
   * a shorter road.
   */
  if (/[\\/]/.test(folder) || folder === '.' || folder === '..') {
    throw new Error('That URL names a folder that would land outside the chosen directory.');
  }

  const target = `${into}/${folder}`;
  // Cloning into something that exists either fails halfway or merges into
  // somebody else's work. Saying so first is cheaper than either.
  if (deps.exists(target)) throw new Error(`${target} already exists.`);

  try {
    await deps.clone(url, target, onLine);
  } catch (e: any) {
    // git's own words, plus where the leftovers are.
    throw new Error(`${e?.message ?? e}\nNothing was added. Anything left in ${target} can be removed.`);
  }

  return deps.addProject(target, (req.name ?? '').trim() || folder);
}
