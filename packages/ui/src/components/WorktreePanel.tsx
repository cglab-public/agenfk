/**
 * What the visible session has changed on disk (CGLAB-173).
 *
 * The question it answers is "which files has this agent touched", asked while
 * you are watching it work — so you do not have to leave the terminal and run
 * git yourself.
 *
 * It used to carry a second "Files" tab, a directory browser. Removed rather
 * than hidden, on use: it never answered the question above — that is this
 * panel's whole job and the changed list already does it — and browsing the
 * tree has a better owner sitting right beside it, the button that opens the
 * worktree in VS Code, Cursor or Zed. Hiding it would have left dead code and
 * half a feature to reappear in the next refactor.
 *
 * Its one hard requirement is not to lie. A panel that shows a clean tree
 * while it is still asking, or because the read failed, is worse than no panel
 * at all: a clean tree is precisely the thing you opened it to check, and
 * being told it confidently is how you stop checking.
 *
 * It no longer carries its own header. `CHANGED (n)` and `STAGED (n)` were two
 * static labels at the top of this panel, over a list that showed both kinds
 * together with a badge on the staged rows. They are buttons in the terminal's
 * top bar now, and the reason is not the row of pixels they gave back: this
 * panel is a fixed 288px beside the terminal and there was no way to be rid of
 * it. Moving the counts out is what lets the panel close, and a closed panel
 * is the window's full width back for the terminal.
 *
 * So this shows ONE of the two lists at a time, named by the button that
 * opened it, and the staged badge on a row went with the split - a list called
 * Staged does not need to say it on every line.
 */
import React from 'react';
import { clsx } from 'clsx';
import { useGitStatus, type WorktreeView } from '../gitStatus';

/** Colour carries the kind, and the letter carries it again for greyscale. */
const STATE_MARK: Record<string, { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-emerald-600 dark:text-emerald-400' },
  modified: { letter: 'M', className: 'text-amber-600 dark:text-amber-400' },
  deleted: { letter: 'D', className: 'text-rose-600 dark:text-rose-400' },
  renamed: { letter: 'R', className: 'text-sky-600 dark:text-sky-400' },
  untracked: { letter: '?', className: 'text-ink-tertiary' },
};


export function WorktreePanel({ itemId, view }: {
  itemId: string | null;
  view: WorktreeView;
}): React.ReactElement {
  const { data, isError, isPending } = useGitStatus(itemId);

  // One list at a time, named by the button that opened it. `staged` is the
  // git distinction itself, so this is a filter rather than a second request.
  const files = (data?.files ?? []).filter(f => (view === 'staged' ? f.staged : !f.staged));

  return (
    <aside
      aria-label="Worktree"
      className="flex h-full w-72 shrink-0 flex-col border-l border-border-soft bg-nav-surface"
    >
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
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
          <p className="px-3 py-4 text-[11px] text-ink-tertiary">
            {view === 'staged' ? 'Nothing staged in this worktree.' : 'No changes in this worktree.'}
          </p>
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
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
