/**
 * A repository becomes a project.
 *
 * The door that writes to the user's disk, which is what separates it from
 * picking a folder. Three things follow from that and each is a test here: the
 * destination is known before anything runs, a failure leaves no project
 * behind, and the partial directory is named so it can be removed on purpose.
 */
import { describe, it, expect, vi } from 'vitest';
import { cloneRepository, folderNameFor } from '../main/cloneRepository';

const deps = (over: Record<string, unknown> = {}) => ({
  exists: vi.fn(() => false),
  clone: vi.fn(async () => {}),
  addProject: vi.fn(async (root: string) => ({ id: 'p9', name: root.split('/').pop()! })),
  ...over,
});

const req = { url: 'git@github.com:cglab-public/horizon-ds.git', into: '/Users/me/GitHub' };

describe('the folder a URL becomes', () => {
  it.each([
    ['git@github.com:cglab-public/horizon-ds.git', 'horizon-ds'],
    ['https://github.com/cglab-public/horizon-ds.git', 'horizon-ds'],
    ['https://github.com/cglab-public/horizon-ds', 'horizon-ds'],
    ['https://github.com/cglab-public/horizon-ds/', 'horizon-ds'],
    ['ssh://git@host:2222/team/horizon-ds.git', 'horizon-ds'],
  ])('%s → %s', (url, folder) => {
    expect(folderNameFor(url)).toBe(folder);
  });

  it('is empty for something that names nothing', () => {
    expect(folderNameFor('   ')).toBe('');
  });
});

describe('cloning', () => {
  it('clones into the destination and hands back the project', async () => {
    const d = deps();
    const project = await cloneRepository(req, d as never);
    expect(d.clone).toHaveBeenCalledWith(req.url, '/Users/me/GitHub/horizon-ds', expect.anything());
    // And it carries the name the screen offered — the repository's own,
    // unless somebody typed over it.
    expect(d.addProject).toHaveBeenCalledWith('/Users/me/GitHub/horizon-ds', 'horizon-ds');
    expect(project).toMatchObject({ id: 'p9' });
  });

  it('refuses a URL that would become a git flag', async () => {
    /*
     * `--upload-pack=...` as a "URL" is an argument to git, not an address.
     * execFile keeps it out of a shell, and this keeps it out of argv.
     */
    const d = deps();
    await expect(cloneRepository({ ...req, url: '--upload-pack=touch /tmp/x' }, d as never))
      .rejects.toThrow(/not a repository/i);
    expect(d.clone).not.toHaveBeenCalled();
  });

  it('refuses an empty URL and an empty destination', async () => {
    const d = deps();
    await expect(cloneRepository({ ...req, url: '  ' }, d as never)).rejects.toThrow(/repository/i);
    await expect(cloneRepository({ ...req, into: '  ' }, d as never)).rejects.toThrow(/folder/i);
    expect(d.clone).not.toHaveBeenCalled();
  });

  it('refuses to clone over something that is already there', async () => {
    // Cloning into an existing directory either fails halfway or merges into
    // somebody's work. Both are worse than saying so first.
    const d = deps({ exists: () => true });
    await expect(cloneRepository(req, d as never)).rejects.toThrow(/already exists/i);
    expect(d.clone).not.toHaveBeenCalled();
  });

  it('creates no project when the clone fails, and names what was left behind', async () => {
    const d = deps({ clone: async () => { throw new Error('Permission denied (publickey).'); } });
    await expect(cloneRepository(req, d as never)).rejects.toThrow(/publickey/);
    // The git words survive — an auth failure is git's to explain — and the
    // path is named so the leftovers can be removed deliberately.
    await expect(cloneRepository(req, d as never)).rejects.toThrow(/\/Users\/me\/GitHub\/horizon-ds/);
    expect(d.addProject).not.toHaveBeenCalled();
  });

  it('reports progress while it runs, because a big repository takes minutes', async () => {
    const lines: string[] = [];
    const d = deps({
      clone: async (_u: string, _t: string, onLine: (l: string) => void) => {
        onLine('Receiving objects:  42% (4200/10000)');
      },
    });
    await cloneRepository(req, d as never, line => lines.push(line));
    expect(lines).toEqual(['Receiving objects:  42% (4200/10000)']);
  });
});

/*
 * Refusals added after an adversarial review. Both are about a "URL" that is
 * not an address at all — the same class as the leading dash above, found in
 * two more disguises.
 */
describe('URLs that are not addresses', () => {
  it('refuses the ext:: transport, which runs a command instead of fetching', async () => {
    // git-remote-ext executes what it names. Today's git refuses it unless
    // the config says otherwise — which makes the protection somebody else's
    // ~/.gitconfig. This makes it ours.
    await expect(cloneRepository({ url: 'ext::sh -c whoami', into: '/tmp/x' }, deps()))
      .rejects.toThrow(/runs a command/i);
  });

  it('refuses a name that would land outside the chosen directory', async () => {
    // Splitting on / and : leaves a backslash alone, and on Windows that
    // walks out of `into`. The existence check cannot save us: the target
    // does not exist yet, which is exactly why it is allowed to be created.
    await expect(cloneRepository({ url: 'https://h/a/..\\..\\Startup\\x', into: '/tmp/x' }, deps()))
      .rejects.toThrow(/outside the chosen directory/i);
  });

  it('still accepts the ordinary shapes, so the guards did not eat the feature', async () => {
    const d = deps();
    await cloneRepository({ url: 'git@github.com:team/repo.git', into: '/tmp/x' }, d);
    expect(d.clone).toHaveBeenCalledWith('git@github.com:team/repo.git', '/tmp/x/repo', expect.any(Function));
  });
});

describe('the project’s name', () => {
  it('is whatever the screen sent, not always the folder', async () => {
    const d = deps();
    await cloneRepository({ ...req, name: 'Horizon DS' }, d);
    expect(d.addProject).toHaveBeenCalledWith('/Users/me/GitHub/horizon-ds', 'Horizon DS');
  });

  it('falls back to the repository rather than refusing the clone', async () => {
    // An empty name is a field somebody cleared, not a reason to throw away a
    // clone that has already succeeded.
    const d = deps();
    await cloneRepository({ ...req, name: '   ' }, d);
    expect(d.addProject).toHaveBeenCalledWith('/Users/me/GitHub/horizon-ds', 'horizon-ds');
  });
});
