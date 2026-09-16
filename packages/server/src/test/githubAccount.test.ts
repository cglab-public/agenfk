/**
 * @vitest-environment node
 *
 * Who the settings screen says you are signed in as.
 *
 * The screen wants an avatar, a name and an email. `GET /github/status` has
 * none of those — it is project-scoped and answers which REPO a card maps to,
 * which is a different question. The temptation is to invent a second auth
 * path to fill the gap; the right answer is that the machine already has one.
 * `gh` holds the credential, `agenfk github setup` already depends on it, and
 * `gh api user` is that same credential asked about itself.
 *
 * Everything here goes through an injected runner rather than `execFileSync`,
 * for the reason worktrees.ts does the same: the interesting cases are the
 * failures — gh absent, gh present but logged out, gh answering something that
 * is not JSON — and none of them can be produced on a developer's machine on
 * demand.
 *
 * The arguments are an ARRAY in every call. `gh` is being asked about a user
 * account, so nothing here is interpolated from a request; passing argv anyway
 * is what keeps that true after the next edit.
 */
import { describe, it, expect, vi } from 'vitest';
import { readGitHubAccount, signOutGitHub } from '../githubAccount';

const USER_JSON = JSON.stringify({
  login: 'leozin',
  name: 'Leonardo Rosa',
  email: 'leonardo.silva@cglab.com',
  avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
});

/** What execFileSync throws when the binary is not on PATH. */
const enoent = (): never => {
  const err = new Error('spawnSync gh ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
};

/** What gh prints when it is installed and nobody is logged in. */
const loggedOut = (): never => {
  const err = new Error('exited with 1') as Error & { stderr: string };
  err.stderr = 'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n'
    + 'error: You are not logged into any GitHub hosts. Run gh auth login to authenticate.';
  throw err;
};

describe('reading the connected account', () => {
  it('asks gh about the credential it already holds', () => {
    const run = vi.fn(() => USER_JSON);
    readGitHubAccount(run);
    // argv, never a shell string, and never a second login flow.
    expect(run).toHaveBeenCalledWith(['api', 'user']);
  });

  it('reports the name, login, email and avatar the screen draws', () => {
    // Every field the Account block renders has to come from here. A field the
    // screen shows and this function never produces is the defect this branch
    // keeps finding.
    expect(readGitHubAccount(() => USER_JSON)).toEqual({
      connected: true,
      login: 'leozin',
      name: 'Leonardo Rosa',
      email: 'leonardo.silva@cglab.com',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    });
  });

  it('says null for the fields GitHub itself leaves empty', () => {
    // A GitHub account with a private email answers `"email": null`, and a
    // brand new one has no display name. Rendering the string "null" under the
    // avatar is worse than rendering nothing.
    const run = () => JSON.stringify({ login: 'ghost', name: null, email: null, avatar_url: null });
    expect(readGitHubAccount(run)).toEqual({
      connected: true, login: 'ghost', name: null, email: null, avatarUrl: null,
    });
  });

  it('refuses an avatar URL that is not http(s)', () => {
    // It goes straight into an <img src>. The value comes from a remote API, so
    // treating it as trusted because "it is our own gh" is how a javascript:
    // or data: URL reaches the DOM.
    const run = () => JSON.stringify({ login: 'x', name: null, email: null, avatar_url: 'javascript:alert(1)' });
    expect(readGitHubAccount(run)).toMatchObject({ connected: true, avatarUrl: null });
  });

  it('distinguishes gh missing from gh logged out', () => {
    // Different sentences on the screen. "Install the GitHub CLI" shown to
    // somebody who has it installed sends them after a fix they already have.
    expect(readGitHubAccount(enoent)).toEqual({ connected: false, reason: 'gh_missing' });
    expect(readGitHubAccount(loggedOut)).toEqual({ connected: false, reason: 'not_authenticated' });
  });

  it('does not claim a connection when gh answers something that is not JSON', () => {
    // gh prints upgrade notices and deprecation warnings on stdout. Parsing
    // failure must read as "we could not tell", never as connected.
    expect(readGitHubAccount(() => 'A new release of gh is available!')).toEqual({
      connected: false, reason: 'unreadable',
    });
  });

  it('does not claim a connection when gh answers JSON with no login in it', () => {
    // `{}` parses. An account with no login is not an account.
    expect(readGitHubAccount(() => '{"message":"Bad credentials"}')).toEqual({
      connected: false, reason: 'unreadable',
    });
  });
});

describe('signing out', () => {
  it('logs out of the host gh is actually using', () => {
    // --hostname and --user together are what make this non-interactive. Without
    // them gh prompts, and a prompt on a process with no TTY hangs the request.
    const run = vi.fn((args: readonly string[]) => (args[0] === 'api' ? USER_JSON : ''));
    expect(signOutGitHub(run, {})).toEqual({ signedOut: true });
    expect(run).toHaveBeenCalledWith(['auth', 'logout', '--hostname', 'github.com', '--user', 'leozin']);
  });

  it('follows GH_HOST, so an enterprise user is not logged out of the wrong host', () => {
    const run = vi.fn((args: readonly string[]) => (args[0] === 'api' ? USER_JSON : ''));
    signOutGitHub(run, { GH_HOST: 'github.cglab.com' });
    expect(run).toHaveBeenCalledWith(
      ['auth', 'logout', '--hostname', 'github.cglab.com', '--user', 'leozin'],
    );
  });

  it('does nothing when there is nobody to sign out', () => {
    // Running `gh auth logout` with no account makes gh prompt for one, which
    // is a hung request rather than an error.
    expect(signOutGitHub(enoent, {})).toMatchObject({ signedOut: false });
    expect(signOutGitHub(loggedOut, {})).toMatchObject({ signedOut: false });
  });

  it('reports why it failed instead of claiming success', () => {
    // gh refuses to log out of a host with a token from the environment. The
    // screen must not then show "Not connected" over a credential that is still
    // there and still works.
    const run = (args: readonly string[]): string => {
      if (args[0] === 'api') return USER_JSON;
      const err = new Error('logout failed') as Error & { stderr: string };
      err.stderr = 'The value of the GH_TOKEN environment variable is being used for authentication.';
      throw err;
    };
    const result = signOutGitHub(run, {});
    expect(result.signedOut).toBe(false);
    expect(result.error).toMatch(/GH_TOKEN/);
  });
});
