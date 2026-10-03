/**
 * A folder on disk becomes a project.
 *
 * ALL OF IT HAPPENS HERE, in the main process, and that is forced rather than
 * chosen: `projectRoot` is a CWD — where `git add -A && git commit` runs, and
 * where worktrees are cut from — so the server keeps it behind an internal
 * token and `PUT /projects/:id` refuses the field outright (bug e60e20aa). The
 * token is a file in the user's home. A renderer holding it would be the mass
 * assignment the route exists to prevent, so the renderer asks for a project
 * and gets one back; no path crosses that border in either direction.
 */
import * as path from 'path';

export interface AddProjectDeps {
  /** The native picker. Resolves to the chosen path, or null when cancelled. */
  readonly chooseDirectory: () => Promise<string | null>;
  readonly createProject: (name: string) => Promise<{ id: string; name: string }>;
  /** The internal-token route. Only the main process can call it. */
  readonly setProjectRoot: (projectId: string, root: string) => Promise<void>;
}

/**
 * THE TWO-STEP DOOR, which is what the screen actually needs.
 *
 * Picking and creating used to be one call, so the native picker WAS the
 * decision: choose a folder and a project existed, with a name nobody was
 * offered and no sentence saying what had just happened. The design asks for
 * folder → name → "Add project", so choosing and creating have to be separate
 * moments.
 *
 * The path is remembered HERE and never travels back in. It goes out once, to
 * be shown — the rule is that the renderer never supplies a path, not that it
 * may never see one — and the only thing that comes back is a name, which is
 * text. `projectRoot` stays a value only the main process can set.
 */
export function folderDoor(deps: AddProjectDeps): {
  choose: () => Promise<{ path: string; name: string } | null>;
  add: (name: string) => Promise<{ id: string; name: string }>;
} {
  let chosen: string | null = null;
  return {
    choose: async () => {
      const picked = await deps.chooseDirectory();
      // Cancelling is not a failure, and it must not disarm a folder the
      // person picked a moment ago and is still looking at.
      if (!picked) return null;
      chosen = picked.replace(/[/\\]+$/, '');
      return { path: chosen, name: path.basename(chosen) || chosen };
    },
    add: async (name: string) => {
      if (!chosen) throw new Error('Choose a folder first.');
      const project = await deps.createProject(name.trim() || path.basename(chosen));
      await deps.setProjectRoot(project.id, chosen);
      return project;
    },
  };
}
