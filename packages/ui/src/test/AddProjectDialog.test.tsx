/**
 * @vitest-environment jsdom
 *
 * Add Project: three ways in, one at a time.
 *
 * What is pinned here is the separation and the promise around the disk. The
 * tabs must TRADE the fields rather than stack them, the destination must be
 * on screen before anything is written, and a failure must not leave a project
 * row pointing at half a checkout.
 */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AddProjectDialog, landingFolder } from '../components/AddProjectDialog';
import * as bridge from '../components/agentBridge';

vi.mock('../components/agentBridge', () => ({
  githubOwnersFromBridge: vi.fn(),
  createRepositoryFromBridge: vi.fn(),
  chooseProjectFolderFromBridge: vi.fn(),
  addChosenFolderFromBridge: vi.fn(),
  cloneDirFromBridge: vi.fn(),
  chooseCloneDirFromBridge: vi.fn(),
  cloneRepositoryFromBridge: vi.fn(),
}));

vi.mock('../api', () => ({ api: { listProjects: vi.fn() } }));

const onAdded = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (bridge.cloneDirFromBridge as any).mockImplementation(() => Promise.resolve({ path: '/Users/me/agenfk' }));
  (bridge.chooseCloneDirFromBridge as any).mockImplementation(() => Promise.resolve({ path: '/elsewhere' }));
  (bridge.githubOwnersFromBridge as any).mockImplementation(() => Promise.resolve([
    { login: 'devleor', avatarUrl: 'https://a/u.png', self: true },
    { login: 'cglab-PRIVATE', avatarUrl: null, self: false },
    { login: 'cargroup-private', avatarUrl: null, self: false },
  ]));
  (bridge.createRepositoryFromBridge as any).mockImplementation(
    () => Promise.resolve({ id: 'p9', name: 'horizon-ds' }));
  (bridge.cloneRepositoryFromBridge as any).mockImplementation(() => Promise.resolve({ id: 'p9', name: 'horizon-ds' }));
  (bridge.chooseProjectFolderFromBridge as any).mockImplementation(
    () => Promise.resolve({ path: '/Users/me/GitHub/horizon-ds', name: 'horizon-ds' }));
  (bridge.addChosenFolderFromBridge as any).mockImplementation(
    () => Promise.resolve({ id: 'p9', name: 'horizon-ds' }));
});
afterEach(cleanup);

const open = async (): Promise<void> => {
  render(<AddProjectDialog open onClose={onClose} onAdded={onAdded} />);
  await waitFor(() => screen.getByTestId('add-project'));
};

const toClone = async () => {
  await open();
  fireEvent.click(screen.getByTestId('add-project-tab-clone'));
  return waitFor(() => screen.getByTestId('add-project-clone'));
};

describe('the tabs', () => {
  it('shows nothing at all when closed', () => {
    render(<AddProjectDialog open={false} onClose={onClose} onAdded={onAdded} />);
    expect(screen.queryByTestId('add-project')).toBeNull();
  });

  it('opens on the folder you already have, the commonest way in', async () => {
    await open();
    expect(screen.getByTestId('add-project-folder')).toBeTruthy();
    expect(screen.queryByTestId('add-project-clone')).toBeNull();
  });

  it('TRADES the fields instead of stacking them — this is the whole point', async () => {
    // The bug being fixed: a URL field sitting under a folder button, with
    // neither having anything to do with the other.
    await toClone();
    expect(screen.queryByTestId('add-project-folder')).toBeNull();
    expect(screen.queryByTestId('add-project-create')).toBeNull();
  });

  it('marks the open tab for anything that reads state rather than pixels', async () => {
    await toClone();
    expect(screen.getByTestId('add-project-tab-clone').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('add-project-tab-folder').getAttribute('aria-selected')).toBe('false');
  });

  it('closes on the X, and on Cancel', async () => {
    await open();
    fireEvent.click(screen.getByTestId('add-project-close'));
    fireEvent.click(screen.getByTestId('add-project-cancel'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('picking a folder', () => {
  const pick = async () => {
    await open();
    fireEvent.click(screen.getByTestId('add-project-choose-folder'));
    return waitFor(() => expect(screen.getByTestId('add-project-folder-path').textContent)
      .toContain('/Users/me/GitHub/horizon-ds'));
  };

  it('CHOOSING IS NOT ADDING — the picker fills the fields and writes nothing', async () => {
    // The whole correction: the native picker used to be the decision, and a
    // project existed the moment it closed, under a name nobody was offered.
    await pick();
    expect(bridge.addChosenFolderFromBridge).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('suggests the name from the folder, and says where it came from', async () => {
    await pick();
    expect((screen.getByTestId('add-project-name') as HTMLInputElement).value).toBe('horizon-ds');
    expect(screen.getByTestId('add-project-name-from').textContent).toContain('from the folder');
  });

  it('keeps a name that was typed, even when another folder is chosen after it', async () => {
    // Their word beats the suggestion. A picker that overwrites what somebody
    // typed is a picker they stop trusting with the second field.
    await pick();
    fireEvent.change(screen.getByTestId('add-project-name'), { target: { value: 'Horizon DS' } });
    expect(screen.queryByTestId('add-project-name-from')).toBeNull();
    (bridge.chooseProjectFolderFromBridge as any).mockImplementation(
      () => Promise.resolve({ path: '/elsewhere/other-repo', name: 'other-repo' }));
    fireEvent.click(screen.getByTestId('add-project-choose-folder'));
    await waitFor(() => expect(screen.getByTestId('add-project-folder-path').textContent)
      .toContain('/elsewhere/other-repo'));
    expect((screen.getByTestId('add-project-name') as HTMLInputElement).value).toBe('Horizon DS');
  });

  it('will not add before a folder is chosen', async () => {
    await open();
    expect((screen.getByTestId('add-project-add') as HTMLButtonElement).disabled).toBe(true);
  });

  it('will not add with the name emptied', async () => {
    await pick();
    fireEvent.change(screen.getByTestId('add-project-name'), { target: { value: '  ' } });
    await waitFor(() =>
      expect((screen.getByTestId('add-project-add') as HTMLButtonElement).disabled).toBe(true));
  });

  it('adds under the name on screen, then closes', async () => {
    await pick();
    fireEvent.change(screen.getByTestId('add-project-name'), { target: { value: 'Horizon DS' } });
    fireEvent.click(screen.getByTestId('add-project-add'));
    await waitFor(() => expect(bridge.addChosenFolderFromBridge).toHaveBeenCalledWith('Horizon DS'));
    expect(onAdded).toHaveBeenCalledWith('p9');
    expect(onClose).toHaveBeenCalled();
  });

  it('says nothing when the picker is cancelled', async () => {
    // Cancelling a dialog is not a failure, and an error for it is the app
    // telling you off for changing your mind.
    (bridge.chooseProjectFolderFromBridge as any).mockImplementation(() => Promise.resolve(null));
    await open();
    fireEvent.click(screen.getByTestId('add-project-choose-folder'));
    await waitFor(() => expect(bridge.chooseProjectFolderFromBridge).toHaveBeenCalled());
    expect(screen.queryByTestId('add-project-error')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces the reason when the server refuses', async () => {
    (bridge.addChosenFolderFromBridge as any).mockImplementation(
      () => Promise.reject(new Error('The server refused to point the project at that folder (403).')),
    );
    await pick();
    fireEvent.click(screen.getByTestId('add-project-add'));
    await waitFor(() => screen.getByTestId('add-project-error'));
    expect(screen.getByTestId('add-project-error').textContent).toContain('403');
  });

  it('names the older build rather than doing nothing', async () => {
    (bridge.chooseProjectFolderFromBridge as any).mockImplementation(() => null);
    await open();
    fireEvent.click(screen.getByTestId('add-project-choose-folder'));
    await waitFor(() => screen.getByTestId('add-project-error'));
    expect(screen.getByTestId('add-project-error').textContent).toMatch(/predates|browser/);
  });
});

// The door that WRITES TO DISK, which is what separates it from picking a
// folder: the destination is settled and shown before anything runs, and a
// failure says where the leftovers are.
describe('cloning a repository', () => {
  it('arrives with a directory already proposed, so nobody has to answer an obvious question', async () => {
    await toClone();
    expect(screen.getByTestId('add-project-dir').textContent).toBe('/Users/me/agenfk');
  });

  it('lets that proposal be overruled — it is a default, not a decision', async () => {
    await toClone();
    fireEvent.click(screen.getByTestId('add-project-choose-dir'));
    await waitFor(() => expect(screen.getByTestId('add-project-dir').textContent).toBe('/elsewhere'));
  });

  it('says why when the folder picker itself refuses, instead of doing nothing', async () => {
    (bridge.chooseCloneDirFromBridge as any).mockImplementation(
      () => Promise.reject(new Error('This build cannot choose a folder.')),
    );
    await toClone();
    fireEvent.click(screen.getByTestId('add-project-choose-dir'));
    await waitFor(() => screen.getByTestId('add-project-error'));
  });

  it('spells out the folder the URL becomes', async () => {
    // "It will go somewhere under here" is not the same promise as naming it.
    await toClone();
    fireEvent.change(screen.getByTestId('add-project-url'), {
      target: { value: 'git@github.com:cglab-public/horizon-ds.git' },
    });
    // And it says the destination is kept, because it is: the picker writes
    // the choice to prefs, so the next clone starts where this one landed.
    await waitFor(() => expect(screen.getByTestId('add-project-target').textContent)
      .toBe('Becomes /Users/me/agenfk/horizon-ds. Remembered for next time.'));
  });

  it('will not clone without a URL — and it is the URL that is missing, not the directory', async () => {
    // Asserting "disabled" alone passes even with the URL check deleted,
    // because the directory could be the thing missing. So: prove the
    // directory IS there, then that typing a URL is what arms the button.
    await toClone();
    expect(screen.getByTestId('add-project-dir').textContent).toBe('/Users/me/agenfk');
    expect((screen.getByTestId('add-project-clone-run') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('add-project-url'), { target: { value: 'git@github.com:x/y.git' } });
    await waitFor(() =>
      expect((screen.getByTestId('add-project-clone-run') as HTMLButtonElement).disabled).toBe(false));
  });

  it('hands back the project the clone became', async () => {
    await toClone();
    fireEvent.change(screen.getByTestId('add-project-url'), { target: { value: 'git@github.com:x/horizon-ds.git' } });
    fireEvent.click(screen.getByTestId('add-project-clone-run'));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('p9'));
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps git’s own words when it fails, including where the leftovers are', async () => {
    (bridge.githubOwnersFromBridge as any).mockImplementation(() => Promise.resolve([
    { login: 'devleor', avatarUrl: 'https://a/u.png', self: true },
    { login: 'cglab-PRIVATE', avatarUrl: null, self: false },
    { login: 'cargroup-private', avatarUrl: null, self: false },
  ]));
  (bridge.createRepositoryFromBridge as any).mockImplementation(
    () => Promise.resolve({ id: 'p9', name: 'horizon-ds' }));
  (bridge.cloneRepositoryFromBridge as any).mockImplementation(() => Promise.reject(
      new Error('Permission denied (publickey).\nNothing was added. Anything left in /Users/me/agenfk/horizon-ds can be removed.'),
    ));
    await toClone();
    fireEvent.change(screen.getByTestId('add-project-url'), { target: { value: 'git@github.com:x/horizon-ds.git' } });
    fireEvent.click(screen.getByTestId('add-project-clone-run'));
    await waitFor(() => screen.getByTestId('add-project-error'));
    expect(screen.getByTestId('add-project-error').textContent).toContain('publickey');
    expect(screen.getByTestId('add-project-error').textContent).toContain('/Users/me/agenfk/horizon-ds');
    // And nothing was handed back: a failed clone is not a project.
    expect(onAdded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says it is cloning, and freezes the form, because a big repository takes minutes', async () => {
    let settle: (v: unknown) => void = () => {};
    (bridge.githubOwnersFromBridge as any).mockImplementation(() => Promise.resolve([
    { login: 'devleor', avatarUrl: 'https://a/u.png', self: true },
    { login: 'cglab-PRIVATE', avatarUrl: null, self: false },
    { login: 'cargroup-private', avatarUrl: null, self: false },
  ]));
  (bridge.createRepositoryFromBridge as any).mockImplementation(
    () => Promise.resolve({ id: 'p9', name: 'horizon-ds' }));
  (bridge.cloneRepositoryFromBridge as any).mockImplementation(() => new Promise(r => { settle = r; }));
    await toClone();
    fireEvent.change(screen.getByTestId('add-project-url'), { target: { value: 'git@github.com:x/y.git' } });
    fireEvent.click(screen.getByTestId('add-project-clone-run'));
    await waitFor(() => expect(screen.getByTestId('add-project-clone-run').textContent).toMatch(/cloning/i));
    // Switching tabs mid-clone would leave a running git behind a hidden form.
    expect((screen.getByTestId('add-project-tab-folder') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('add-project-url') as HTMLInputElement).disabled).toBe(true);
    settle({ id: 'p9', name: 'y' });
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });
});

// Everything below was found by an adversarial review, and every one of them
// was a behaviour no test was asking about.
describe('Escape, and what it must not take with it', () => {
  it('closes the dialog', async () => {
    await open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not reach the panel underneath, which would unmount the whole thing', async () => {
    // The panel behind this one also closes on Escape, at document level. The
    // objective, the proposal and the kept/dropped rows live there.
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    try {
      await open();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(behind).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });

  it('is ignored mid-clone, because the buttons that say so are disabled', async () => {
    // A keyboard route around a deliberately disabled control makes the
    // disabling a lie — and git keeps running either way.
    let settle: (v: unknown) => void = () => {};
    (bridge.githubOwnersFromBridge as any).mockImplementation(() => Promise.resolve([
    { login: 'devleor', avatarUrl: 'https://a/u.png', self: true },
    { login: 'cglab-PRIVATE', avatarUrl: null, self: false },
    { login: 'cargroup-private', avatarUrl: null, self: false },
  ]));
  (bridge.createRepositoryFromBridge as any).mockImplementation(
    () => Promise.resolve({ id: 'p9', name: 'horizon-ds' }));
  (bridge.cloneRepositoryFromBridge as any).mockImplementation(() => new Promise(r => { settle = r; }));
    await toClone();
    fireEvent.change(screen.getByTestId('add-project-url'), { target: { value: 'git@github.com:x/y.git' } });
    fireEvent.click(screen.getByTestId('add-project-clone-run'));
    await waitFor(() => expect(screen.getByTestId('add-project-clone-run').textContent).toMatch(/cloning/i));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    settle({ id: 'p9', name: 'y' });
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });
});

describe('reopening', () => {
  const reopen = async (el: { rerender: (u: React.ReactElement) => void }) => {
    el.rerender(<AddProjectDialog open={false} onClose={onClose} onAdded={onAdded} />);
    el.rerender(<AddProjectDialog open onClose={onClose} onAdded={onAdded} />);
    return waitFor(() => screen.getByTestId('add-project'));
  };

  it('is a fresh start, not a resume: the URL just cloned is gone', async () => {
    // Otherwise the primary button is armed with a URL whose folder now
    // exists, and the only thing refusing is main's "already exists".
    const el = render(<AddProjectDialog open onClose={onClose} onAdded={onAdded} />);
    fireEvent.click(screen.getByTestId('add-project-tab-clone'));
    fireEvent.change(screen.getByTestId('add-project-url'), { target: { value: 'git@github.com:x/y.git' } });
    await reopen(el);
    expect(screen.getByTestId('add-project-folder')).toBeTruthy();
    fireEvent.click(screen.getByTestId('add-project-tab-clone'));
    await waitFor(() => expect((screen.getByTestId('add-project-url') as HTMLInputElement).value).toBe(''));
    expect((screen.getByTestId('add-project-clone-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not keep yesterday’s error on screen', async () => {
    (bridge.chooseProjectFolderFromBridge as any).mockImplementation(() => null);
    const el = render(<AddProjectDialog open onClose={onClose} onAdded={onAdded} />);
    fireEvent.click(screen.getByTestId('add-project-choose-folder'));
    await waitFor(() => screen.getByTestId('add-project-error'));
    await reopen(el);
    expect(screen.queryByTestId('add-project-error')).toBeNull();
  });
});

describe('creating the repository on GitHub', () => {
  const toCreate = async () => {
    await open();
    fireEvent.click(screen.getByTestId('add-project-tab-create'));
    return waitFor(() => screen.getByTestId('add-project-owner'));
  };

  it('defaults to the person themselves, who owns most repositories', async () => {
    await toCreate();
    expect(screen.getByTestId('add-project-owner').textContent).toContain('devleor');
  });

  it('names who is acting, because this is the only door that writes where others can see', async () => {
    await toCreate();
    expect(screen.getByTestId('add-project-acting-as').textContent).toContain('@devleor');
    expect(screen.getByTestId('add-project-acting-as').textContent).toContain('github.com');
  });

  it('chooses an owner ON THE SAME SCREEN, without taking the form away', async () => {
    // Not a second modal, and not a view that replaces the first: the name,
    // the visibility and the destination stay on screen while one field is
    // answered.
    await toCreate();
    fireEvent.click(screen.getByTestId('add-project-owner'));
    await waitFor(() => screen.getByTestId('add-project-owner-list'));
    expect(screen.getByTestId('add-project-repo')).toBeTruthy();
    expect(screen.getByTestId('add-project-visibility-private')).toBeTruthy();
    expect(screen.getByTestId('add-project-create-dir')).toBeTruthy();
    expect(screen.getByTestId('add-project-create-run')).toBeTruthy();
    fireEvent.click(screen.getByTestId('add-project-owner-back'));
    await waitFor(() => expect(screen.queryByTestId('add-project-owner-list')).toBeNull());
  });

  it('keeps what was already typed while the list is open', async () => {
    // The bug this replaces: the form was unmounted to show the list, so
    // everything on it was rebuilt from scratch on the way back.
    await toCreate();
    fireEvent.change(screen.getByTestId('add-project-repo'), { target: { value: 'horizon-ds' } });
    fireEvent.click(screen.getByTestId('add-project-owner'));
    await waitFor(() => screen.getByTestId('add-project-owner-list'));
    expect((screen.getByTestId('add-project-repo') as HTMLInputElement).value).toBe('horizon-ds');
    fireEvent.click(screen.getByTestId('add-project-owner-option-cglab-PRIVATE'));
    await waitFor(() => expect(screen.getByTestId('add-project-owner').textContent).toContain('cglab-PRIVATE'));
    expect((screen.getByTestId('add-project-repo') as HTMLInputElement).value).toBe('horizon-ds');
  });

  it('Escape leaves the owner list first, and the dialog only after', async () => {
    await toCreate();
    fireEvent.click(screen.getByTestId('add-project-owner'));
    await waitFor(() => screen.getByTestId('add-project-owner-list'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('add-project-owner-list')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('searches the owners rather than making you scroll an org list', async () => {
    await toCreate();
    fireEvent.click(screen.getByTestId('add-project-owner'));
    fireEvent.change(await screen.findByTestId('add-project-owner-search'), { target: { value: 'cglab' } });
    await waitFor(() => screen.getByTestId('add-project-owner-option-cglab-PRIVATE'));
    expect(screen.queryByTestId('add-project-owner-option-cargroup-private')).toBeNull();
    fireEvent.click(screen.getByTestId('add-project-owner-option-cglab-PRIVATE'));
    await waitFor(() => expect(screen.getByTestId('add-project-owner').textContent).toContain('cglab-PRIVATE'));
  });

  it('says so when nothing matches, instead of showing an empty box', async () => {
    await toCreate();
    fireEvent.click(screen.getByTestId('add-project-owner'));
    fireEvent.change(await screen.findByTestId('add-project-owner-search'), { target: { value: 'zzz' } });
    await waitFor(() => screen.getByTestId('add-project-owner-none'));
  });

  it('defaults to private — publishing by accident is the mistake this prevents', async () => {
    await toCreate();
    expect(screen.getByTestId('add-project-visibility-private').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('add-project-visibility-public'));
    await waitFor(() =>
      expect(screen.getByTestId('add-project-visibility-public').getAttribute('aria-pressed')).toBe('true'));
  });

  it('names the project after the repository until somebody says otherwise', async () => {
    await toCreate();
    fireEvent.change(screen.getByTestId('add-project-repo'), { target: { value: 'horizon-ds' } });
    await waitFor(() => expect((screen.getByTestId('add-project-name') as HTMLInputElement).value).toBe('horizon-ds'));
  });

  it('spells out the folder it will land in', async () => {
    await toCreate();
    fireEvent.change(screen.getByTestId('add-project-repo'), { target: { value: 'horizon-ds' } });
    await waitFor(() => expect(screen.getByTestId('add-project-create-target').textContent)
      .toContain('/Users/me/agenfk/horizon-ds'));
  });

  it('creates with owner, name and visibility, then closes', async () => {
    await toCreate();
    fireEvent.change(screen.getByTestId('add-project-repo'), { target: { value: 'horizon-ds' } });
    fireEvent.click(screen.getByTestId('add-project-visibility-public'));
    fireEvent.click(screen.getByTestId('add-project-create-run'));
    await waitFor(() => expect(bridge.createRepositoryFromBridge).toHaveBeenCalledWith({
      owner: 'devleor', repo: 'horizon-ds', visibility: 'public', name: 'horizon-ds',
    }));
    expect(onAdded).toHaveBeenCalledWith('p9');
    expect(onClose).toHaveBeenCalled();
  });

  it('will not create without a repository name', async () => {
    await toCreate();
    expect((screen.getByTestId('add-project-create-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps GitHub’s words when it refuses, including that the repository WAS created', async () => {
    (bridge.createRepositoryFromBridge as any).mockImplementation(() => Promise.reject(
      new Error('Permission denied (publickey).\ndevleor/horizon-ds WAS created on GitHub.'),
    ));
    await toCreate();
    fireEvent.change(screen.getByTestId('add-project-repo'), { target: { value: 'horizon-ds' } });
    fireEvent.click(screen.getByTestId('add-project-create-run'));
    await waitFor(() => screen.getByTestId('add-project-error'));
    expect(screen.getByTestId('add-project-error').textContent).toContain('WAS created on GitHub');
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('signed out is a state with an instruction, not an empty menu', async () => {
    (bridge.githubOwnersFromBridge as any).mockImplementation(() => Promise.resolve([]));
    await open();
    fireEvent.click(screen.getByTestId('add-project-tab-create'));
    await waitFor(() => screen.getByTestId('add-project-signed-out'));
    expect(screen.getByTestId('add-project-signed-out').textContent).toContain('gh auth login');
    // And nothing to press: there is nobody to create as.
    expect(screen.queryByTestId('add-project-create-run')).toBeNull();
  });
});

describe('landingFolder', () => {
  it('reads the repository name out of every URL git accepts', () => {
    expect(landingFolder('/here', 'git@github.com:team/repo.git')).toBe('/here/repo');
    expect(landingFolder('/here', 'https://github.com/team/repo')).toBe('/here/repo');
    expect(landingFolder('/here/', 'https://github.com/team/repo/')).toBe('/here/repo');
  });

  it('answers with nothing when there is no name to read, instead of a path ending in a slash', () => {
    expect(landingFolder('/here', '')).toBe('');
  });
});
