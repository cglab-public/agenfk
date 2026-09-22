/**
 * Turning a folder on disk into a project.
 *
 * WHY THIS LIVES IN THE MAIN PROCESS, and not in the screen that asks for it:
 * `projectRoot` is a CWD. It is where `git add -A && git commit` runs and
 * where worktrees are cut from, so the server puts it behind an internal token
 * and `PUT /projects/:id` refuses the field outright (bug e60e20aa). The token
 * is a file in the user's home that the renderer cannot read and must not
 * carry. So the renderer asks for a project and receives one; the path never
 * crosses that border in either direction.
 */
import { describe, it, expect, vi } from 'vitest';
import { addProjectFromDirectory, folderDoor } from '../main/addProject';

const deps = (over: Record<string, unknown> = {}) => ({
  chooseDirectory: vi.fn(async () => '/Users/me/GitHub/horizon-lab'),
  createProject: vi.fn(async (name: string) => ({ id: 'p9', name })),
  setProjectRoot: vi.fn(async () => {}),
  ...over,
});

it('names the project after the folder, rather than asking twice', async () => {
  const d = deps();
  const project = await addProjectFromDirectory(d as never);
  expect(d.createProject).toHaveBeenCalledWith('horizon-lab');
  expect(project).toMatchObject({ id: 'p9', name: 'horizon-lab' });
});

it('points the new project at the chosen folder', async () => {
  const d = deps();
  await addProjectFromDirectory(d as never);
  expect(d.setProjectRoot).toHaveBeenCalledWith('p9', '/Users/me/GitHub/horizon-lab');
});

it('answers null when the picker is cancelled, and creates nothing', async () => {
  // Cancelling a file dialog is not an error, and a project created for a
  // cancelled dialog is a row somebody has to find and delete.
  const d = deps({ chooseDirectory: async () => null });
  await expect(addProjectFromDirectory(d as never)).resolves.toBeNull();
  expect(d.createProject).not.toHaveBeenCalled();
});

it('does not leave a rootless project behind when the repoint fails', async () => {
  /*
   * A project with no projectRoot cannot host an agent and cannot cut a
   * worktree — it is a row that looks like a project and is not one. If the
   * second call fails, the first has to be undone or the failure has to say
   * so; silence is what produced the four $HOME-rooted projects on this
   * machine.
   */
  const d = deps({ setProjectRoot: async () => { throw new Error('refused'); } });
  await expect(addProjectFromDirectory(d as never)).rejects.toThrow(/refused/);
});

it('trims a trailing separator before taking the name', async () => {
  // Some pickers hand back "/path/to/repo/" and basename on that is empty.
  const d = deps({ chooseDirectory: async () => '/Users/me/GitHub/horizon-lab/' });
  await addProjectFromDirectory(d as never);
  expect(d.createProject).toHaveBeenCalledWith('horizon-lab');
});

/*
 * THE TWO-STEP DOOR. The one-shot version above is still used by the older
 * channel; this is the one the screen drives, and the gap between choosing and
 * creating is the whole point — it is where the folder is shown and the name
 * is offered.
 */
describe('folderDoor', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    chooseDirectory: vi.fn(async () => '/Users/me/GitHub/horizon-ds'),
    createProject: vi.fn(async (name: string) => ({ id: 'p9', name })),
    setProjectRoot: vi.fn(async () => {}),
    ...over,
  });

  it('choosing shows the folder and suggests a name, and creates NOTHING', async () => {
    const d = deps();
    const door = folderDoor(d);
    expect(await door.choose()).toEqual({ path: '/Users/me/GitHub/horizon-ds', name: 'horizon-ds' });
    expect(d.createProject).not.toHaveBeenCalled();
    expect(d.setProjectRoot).not.toHaveBeenCalled();
  });

  it('creates under the name it was given, at the folder it remembers', async () => {
    // The name crosses the border; the path never does.
    const d = deps();
    const door = folderDoor(d);
    await door.choose();
    expect(await door.add('Horizon DS')).toEqual({ id: 'p9', name: 'Horizon DS' });
    expect(d.createProject).toHaveBeenCalledWith('Horizon DS');
    expect(d.setProjectRoot).toHaveBeenCalledWith('p9', '/Users/me/GitHub/horizon-ds');
  });

  it('falls back to the folder name when the field was emptied', async () => {
    const d = deps();
    const door = folderDoor(d);
    await door.choose();
    await door.add('   ');
    expect(d.createProject).toHaveBeenCalledWith('horizon-ds');
  });

  it('refuses to create before a folder was chosen', async () => {
    // Otherwise the name is attached to nothing, and a project with no root
    // cannot host an agent or cut a worktree.
    await expect(folderDoor(deps()).add('whatever')).rejects.toThrow(/choose a folder/i);
  });

  it('a cancelled second pick keeps the folder already chosen', async () => {
    // Cancelling is changing your mind about CHANGING it, not about the one
    // sitting in the field.
    const d = deps();
    const door = folderDoor(d);
    await door.choose();
    d.chooseDirectory.mockResolvedValueOnce(null as never);
    expect(await door.choose()).toBeNull();
    await door.add('kept');
    expect(d.setProjectRoot).toHaveBeenCalledWith('p9', '/Users/me/GitHub/horizon-ds');
  });

  it('trims a trailing separator, which would otherwise name the project ""', async () => {
    const d = deps({ chooseDirectory: vi.fn(async () => '/Users/me/GitHub/horizon-ds/') });
    expect(await folderDoor(d).choose()).toEqual({ path: '/Users/me/GitHub/horizon-ds', name: 'horizon-ds' });
  });
});
