/**
 * The worktree's git state, asked once for everyone who needs it.
 *
 * Its own module rather than a second export from WorktreePanel, for two
 * reasons that point the same way. Fast refresh only works on a file that
 * exports components alone, and this is now read from two places that are not
 * each other's parent: the panel that lists the files, and the pair of buttons
 * in the terminal's top bar that carry the counts.
 *
 * SHARED, not duplicated. The counts have to stay honest while the panel is
 * CLOSED - with it shut they are the only thing on screen saying the worktree
 * has changes at all - so both callers ask, and React Query's key makes that
 * one cache entry and one poll. The shell already does this for settings and
 * the project list; a second source for one fact is how two parts of this app
 * came to disagree before.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Which half of the worktree's state the panel is showing. */
export type WorktreeView = 'changed' | 'staged';

export function useGitStatus(itemId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['git-status', itemId],
    queryFn: () => api.getGitStatus(itemId!),
    // Nothing to ask about without a session, and asking anyway would 404 on
    // every render of an empty terminal panel.
    enabled: enabled && Boolean(itemId),
    // The agent is editing while you watch. Stale-by-default would show the
    // state from whenever you last opened the tab.
    refetchInterval: 4000,
  });
}
