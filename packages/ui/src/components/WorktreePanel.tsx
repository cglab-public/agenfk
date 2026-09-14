/**
 * What the visible session has changed on disk (CGLAB-173).
 *
 * The question it answers is "which files has this agent touched", asked while
 * you are watching it work — so you do not have to leave the terminal and run
 * git yourself.
 *
 * Its one hard requirement is not to lie. A panel that shows a clean tree
 * while it is still asking, or because the read failed, is worse than no panel
 * at all: a clean tree is precisely the thing you opened it to check, and
 * being told it confidently is how you stop checking.
 */
import React from 'react';
import { clsx } from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/** Colour carries the kind, and the letter carries it again for greyscale. */
const STATE_MARK: Record<string, { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-emerald-600 dark:text-emerald-400' },
  modified: { letter: 'M', className: 'text-amber-600 dark:text-amber-400' },
  deleted: { letter: 'D', className: 'text-rose-600 dark:text-rose-400' },
  renamed: { letter: 'R', className: 'text-sky-600 dark:text-sky-400' },
  untracked: { letter: '?', className: 'text-ink-tertiary' },
};

type PanelView = 'changes' | 'files';

export function WorktreePanel({ itemId }: { itemId: string | null }): React.ReactElement {
  const [view, setView] = React.useState<PanelView>('changes');
  /**
   * Where in the tree we are, as an array of NAMES.
   *
   * Names the server gave us, joined here — never a path the user typed. The
   * endpoint anchors every read to the worktree by resolved path, and a UI
   * that accepted a typed path would be the filesystem browser that anchoring
   * exists to prevent.
   */
  const [crumbs, setCrumbs] = React.useState<string[]>([]);
  const dirPath = crumbs.join('/');

  const listing = useQuery({
    queryKey: ['worktree-files', itemId, dirPath],
    queryFn: () => api.listWorktreeFiles(itemId!, dirPath || undefined),
    enabled: Boolean(itemId) && view === 'files',
  });

  const { data, isError, isPending } = useQuery({
    queryKey: ['git-status', itemId],
    queryFn: () => api.getGitStatus(itemId!),
    // Nothing to ask about without a session, and asking anyway would 404 on
    // every render of an empty terminal panel.
    enabled: Boolean(itemId),
    // The agent is editing while you watch. Stale-by-default would show the
    // state from whenever you last opened the tab.
    refetchInterval: 4000,
  });

  const files = data?.files ?? [];

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-l border-border-soft bg-nav-surface">
      <header className="border-b border-border-soft">
        <div role="tablist" aria-label="Worktree" className="flex">
          {(['changes', 'files'] as PanelView[]).map(id => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={clsx(
                'flex-1 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide transition-colors',
                view === id ? 'bg-canvas text-ink' : 'text-ink-tertiary hover:text-ink-secondary',
              )}
            >
              {id === 'changes' ? 'Changes' : 'Files'}
            </button>
          ))}
        </div>
        {view === 'changes' && (
          <div className="flex items-center gap-3 px-3 py-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-secondary">
              Changed ({data?.changed ?? 0})
            </span>
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
              Staged ({data?.staged ?? 0})
            </span>
          </div>
        )}
        {view === 'files' && crumbs.length > 0 && (
          <button
            onClick={() => setCrumbs(c => c.slice(0, -1))}
            className="w-full px-3 py-2 text-left font-mono text-[10px] text-ink-tertiary hover:text-ink"
          >
            ← /{dirPath}
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
        {view === 'files' ? (
          <>
            {listing.isError && (
              <div
                role="alert"
                className="m-3 rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
              >
                Could not read this directory.
              </div>
            )}
            <ul className="flex flex-col">
              {(listing.data?.entries ?? []).map(entry => (
                <li key={entry.name} data-testid="file-entry">
                  <button
                    // Descends by NAME. The path is composed from what the
                    // server returned, never from anything typed.
                    onClick={() => entry.kind === 'directory' && setCrumbs(c => [...c, entry.name])}
                    disabled={entry.kind !== 'directory'}
                    className={clsx(
                      'flex w-full items-center gap-2 px-3 py-1 text-left text-[11px]',
                      entry.kind === 'directory'
                        ? 'text-ink-secondary hover:bg-canvas hover:text-ink'
                        : 'cursor-default text-ink-tertiary',
                    )}
                  >
                    <span className="w-3 shrink-0 font-mono">
                      {entry.kind === 'directory' ? '▸' : entry.kind === 'symlink' ? '↗' : ' '}
                    </span>
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
        <>
        {isError && (
          <div
            role="alert"
            className="m-3 rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
          >
            Could not read the worktree. It may not exist yet, or it is not a
            git repository.
          </div>
        )}

        {/* Only once the answer is in. "No changes" while still asking would be
            the panel asserting the one thing it has not checked. */}
        {!isError && !isPending && files.length === 0 && (
          <p className="px-3 py-4 text-[11px] text-ink-tertiary">No changes in this worktree.</p>
        )}

        <ul className="flex flex-col">
          {files.map((file, i) => {
            const mark = STATE_MARK[file.state] ?? STATE_MARK.modified;
            return (
              <li
                key={`${file.path}-${file.staged}-${i}`}
                className="flex items-baseline gap-2 px-3 py-1 text-[11px]"
              >
                <span className={clsx('w-3 shrink-0 font-mono font-bold', mark.className)}>
                  {mark.letter}
                </span>
                <span className="min-w-0 flex-1">
                  {/* Tail-truncated: the end of a path is what identifies the
                      file, so cutting the front keeps the useful half. */}
                  <span className="block truncate text-ink-secondary" title={file.path} dir="rtl">
                    {file.path}
                  </span>
                  {file.from && (
                    <span className="block truncate text-[10px] text-ink-tertiary" title={file.from}>
                      from {file.from}
                    </span>
                  )}
                </span>
                {file.staged && (
                  <span className="shrink-0 font-mono text-[9px] uppercase text-ink-tertiary">staged</span>
                )}
              </li>
            );
          })}
        </ul>
        </>
        )}
      </div>
    </aside>
  );
}
