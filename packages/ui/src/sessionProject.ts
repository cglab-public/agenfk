/**
 * The project a terminal belongs to, by name, for its header (INFRA-425).
 *
 * TerminalTab renders `projectName / title` and nothing ever filled the first
 * half. Derived here, where the sessions are handed to the tab, rather than
 * stored on the session: a session restored from before this change gets a
 * name too, and a renamed project is shown by its new name.
 *
 * A session's own `projectId` wins, then the project of its card. One that
 * can be placed by neither, or whose title already IS the project's name (a
 * project terminal), is returned untouched — the same object — and an
 * array in which nothing changed is returned as itself, so React sees no new
 * props for a list that did not move.
 */
export function withProjectNames<T extends { itemId?: string; projectId?: string; projectName?: string; title?: string }>(
  sessions: readonly T[],
  itemProject: ReadonlyMap<string, string>,
  projectNames: ReadonlyMap<string, string>,
): readonly T[] {
  let changed = false;
  const named = sessions.map(session => {
    const projectId = session.projectId ?? (session.itemId ? itemProject.get(session.itemId) : undefined);
    const name = projectId ? projectNames.get(projectId) : undefined;
    // A project terminal is titled with the project's name already; prefixing
    // it again would read "agenfk / agenfk".
    if (!name || name === session.projectName || name === session.title) return session;
    changed = true;
    return { ...session, projectName: name };
  });
  return changed ? named : sessions;
}
