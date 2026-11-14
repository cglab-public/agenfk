/**
 * @vitest-environment node
 *
 * The door that writes outside this machine.
 *
 * What is pinned here is ORDER and REFUSAL. A repository that exists on GitHub
 * with nothing on disk is recoverable and says so; a project row pointing at a
 * directory nobody fetched is a puzzle. So the remote is attempted first, the
 * clone second, the row last — and every refusal happens before the step that
 * cannot be undone.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRepository, listOwners } from '../main/createRepository';

const deps = (over: Record<string, unknown> = {}) => ({
  gh: vi.fn(async () => ''),
  into: '/Users/me/agenfk',
  exists: vi.fn(() => false),
  clone: vi.fn(async () => {}),
  addProject: vi.fn(async (root: string, name: string) => ({ id: 'p9', name })),
  ...over,
});

const req = { owner: 'cglab-PRIVATE', repo: 'horizon-ds', visibility: 'private' as const };

describe('creating a repository on GitHub', () => {
  it('creates the remote, clones it, then makes the project — in that order', async () => {
    const order: string[] = [];
    const d = deps({
      gh: vi.fn(async () => { order.push('remote'); return ''; }),
      clone: vi.fn(async () => { order.push('clone'); }),
      addProject: vi.fn(async (root: string, name: string) => { order.push('project'); return { id: 'p9', name }; }),
    });
    await createRepository(req, d);
    expect(order).toEqual(['remote', 'clone', 'project']);
  });

  it('asks gh for exactly owner/name and the visibility chosen', async () => {
    const d = deps();
    await createRepository(req, d);
    expect(d.gh).toHaveBeenCalledWith(['repo', 'create', 'cglab-PRIVATE/horizon-ds', '--private']);
  });

  it('passes public through, because the choice is the point of the control', async () => {
    const d = deps();
    await createRepository({ ...req, visibility: 'public' }, d);
    expect(d.gh).toHaveBeenCalledWith(['repo', 'create', 'cglab-PRIVATE/horizon-ds', '--public']);
  });

  it('clones the repository it just created, into the folder main chose', async () => {
    const d = deps();
    await createRepository(req, d);
    expect(d.clone).toHaveBeenCalledWith(
      'https://github.com/cglab-PRIVATE/horizon-ds.git',
      '/Users/me/agenfk/horizon-ds',
      expect.any(Function),
    );
  });

  it('names the project as asked, and after the repository when the field was left empty', async () => {
    const named = deps();
    await createRepository({ ...req, name: 'Horizon DS' }, named);
    expect(named.addProject).toHaveBeenCalledWith('/Users/me/agenfk/horizon-ds', 'Horizon DS');

    const bare = deps();
    await createRepository(req, bare);
    expect(bare.addProject).toHaveBeenCalledWith('/Users/me/agenfk/horizon-ds', 'horizon-ds');
  });

  it('reports GitHub’s refusal in GitHub’s words, and creates nothing locally', async () => {
    // A taken name is GitHub's answer. Translating it into ours would lose the
    // one sentence that says what to do about it.
    const d = deps({
      gh: vi.fn(async () => { throw new Error('GraphQL: Name already exists on this account (createRepository)'); }),
    });
    await expect(createRepository(req, d)).rejects.toThrow(/already exists on this account/);
    expect(d.clone).not.toHaveBeenCalled();
    expect(d.addProject).not.toHaveBeenCalled();
  });

  it('says the repository WAS created when the clone is what failed', async () => {
    // The dangerous half-state: retrying blindly would create a second
    // repository, or fail confusingly on the name that is now taken.
    const d = deps({ clone: vi.fn(async () => { throw new Error('Permission denied (publickey).'); }) });
    await expect(createRepository(req, d)).rejects.toThrow(/WAS created on GitHub/);
    expect(d.addProject).not.toHaveBeenCalled();
  });

  it('refuses a destination that exists BEFORE creating anything remote', async () => {
    const d = deps({ exists: vi.fn(() => true) });
    await expect(createRepository(req, d)).rejects.toThrow(/already exists/);
    expect(d.gh).not.toHaveBeenCalled();
  });

  it('refuses a repository name that would move the clone somewhere else', async () => {
    // The name becomes a directory on the way back. GitHub would refuse it
    // too — but only after this side has already decided where to write.
    const d = deps();
    await expect(createRepository({ ...req, repo: '../../Startup/x' }, d)).rejects.toThrow(/letters, numbers/);
    expect(d.gh).not.toHaveBeenCalled();
  });

  it('refuses an empty owner or name rather than asking GitHub to', async () => {
    await expect(createRepository({ ...req, owner: '  ' }, deps())).rejects.toThrow(/who the repository belongs to/i);
    await expect(createRepository({ ...req, repo: '' }, deps())).rejects.toThrow(/name is required/i);
  });
});

describe('who this machine can create as', () => {
  const user = JSON.stringify({ login: 'devleor', avatar_url: 'https://a/u.png' });
  const orgs = JSON.stringify([
    { login: 'cglab-PRIVATE', avatar_url: 'https://a/c.png' },
    { login: 'cargroup-private' },
  ]);

  it('puts the person first, then the organisations they belong to', async () => {
    const gh = vi.fn(async (args: readonly string[]) => (args[1] === 'user' ? user : orgs));
    expect(await listOwners(gh)).toEqual([
      { login: 'devleor', avatarUrl: 'https://a/u.png', self: true },
      { login: 'cglab-PRIVATE', avatarUrl: 'https://a/c.png', self: false },
      { login: 'cargroup-private', avatarUrl: null, self: false },
    ]);
  });

  it('still offers the person when the org lookup fails', async () => {
    // No orgs and a failed org lookup look the same from here, and both can
    // still create under the user themselves.
    const gh = vi.fn(async (args: readonly string[]) => {
      if (args[1] === 'user') return user;
      throw new Error('HTTP 403');
    });
    expect(await listOwners(gh)).toEqual([{ login: 'devleor', avatarUrl: 'https://a/u.png', self: true }]);
  });

  it('answers with nobody when gh is missing or logged out', async () => {
    // Not an error: the screen says "not signed in", which is a state with an
    // instruction, rather than showing an empty menu that looks broken.
    expect(await listOwners(vi.fn(async () => { throw new Error('gh: command not found'); }))).toEqual([]);
  });
});


/*
 * Argv, not text.
 *
 * Found by an adversarial review of this commit. `owner` is the START of an
 * argv element, so it decides whether `gh` reads the token as a positional or
 * as a FLAG — and `--public` is already fixed in that command line.
 */
describe('refusing an owner that is really a flag', () => {
  it('refuses --source, which would publish a local checkout the user never chose', async () => {
    // `gh repo create --source <path> --public` creates the remote FROM that
    // directory. One injected token turns "make me a repo" into "publish that".
    const d = deps();
    await expect(createRepository(
      { ...req, owner: '--source=/Users/victim/work/secrets' }, d,
    )).rejects.toThrow(/not a GitHub account name/i);
    expect(d.gh).not.toHaveBeenCalled();
  });

  it.each([
    ['a slash', 'devleor/evil'],
    ['a space and a second flag', 'devleor --public'],
    ['a leading dash', '-devleor'],
    ['a trailing dash', 'devleor-'],
    ['a dot, which GitHub logins cannot contain', 'dev.leor'],
  ])('refuses %s', async (_why, owner) => {
    await expect(createRepository({ ...req, owner }, deps())).rejects.toThrow(/not a GitHub account name/i);
  });

  it('still accepts the shapes GitHub actually issues', async () => {
    const d = deps();
    await createRepository({ ...req, owner: 'cglab-PRIVATE' }, d);
    expect(d.gh).toHaveBeenCalledWith(['repo', 'create', 'cglab-PRIVATE/horizon-ds', '--private']);
  });

  it('refuses a visibility outside the closed set, next to the argv it becomes', async () => {
    // The border checks this too. This one keeps the guarantee when a second
    // caller appears: a TypeScript union is erased at runtime.
    const d = deps();
    await expect(createRepository(
      { ...req, visibility: 'public --delete-branch-on-merge' as never }, d,
    )).rejects.toThrow(/private or public/i);
    expect(d.gh).not.toHaveBeenCalled();
  });

  it('refuses .. as a repository name, which the existence check cannot catch', async () => {
    // existsSync('/Users/me/agenfk/..') is FALSE on a machine where ~/agenfk
    // does not exist yet, so only the name check stands between this and a
    // clone into the parent directory.
    await expect(createRepository({ ...req, repo: '..' }, deps())).rejects.toThrow(/letters, numbers/i);
  });
});

describe('when only the project row fails', () => {
  it('names BOTH the repository and the checkout, because both already exist', async () => {
    // The most expensive half-state there is, and it used to produce the least
    // informative message: the inner error knows about the checkout and says
    // nothing about the repository that is now on GitHub.
    const d = deps({
      addProject: vi.fn(async () => { throw new Error('The server refused to create the project (500).'); }),
    });
    await expect(createRepository(req, d)).rejects.toThrow(/was created on GitHub and cloned to/);
    await expect(createRepository(req, d)).rejects.toThrow(/refused to create the project/);
  });
});
