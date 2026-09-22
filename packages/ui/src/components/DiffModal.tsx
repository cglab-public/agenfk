/**
 * The diff of one file, on screen (be411ffb).
 *
 * The worktree panel could say a file changed and never what changed, so the
 * answer to "what did this agent just do" was to leave the app and run git by
 * hand - the thing that panel exists to avoid.
 *
 * Its own component rather than a pane in the 288px panel: a unified diff
 * needs WIDTH (two columns of a 40-column terminal is not a diff view), and a
 * modal is the one place the window can give it without shrinking anything
 * that is running.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { api } from '../api';

/** Colour by line kind. The glyph is the same information for a greyscale read. */
function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-sky-600 dark:text-sky-400';
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-ink-tertiary';
  if (line.startsWith('+')) return 'text-emerald-600 dark:text-emerald-400';
  if (line.startsWith('-')) return 'text-rose-600 dark:text-rose-400';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'text-ink-tertiary';
  return 'text-ink-secondary';
}

export function DiffModal({ itemId, filePath, staged, onClose }: {
  itemId: string;
  filePath: string;
  staged: boolean;
  onClose: () => void;
}): React.ReactElement {
  const { data, isError, isPending, error } = useQuery({
    queryKey: ['file-diff', itemId, filePath, staged],
    queryFn: () => api.getFileDiff(itemId, filePath, staged),
    // A file's diff is a snapshot of a moment; the poll belongs to the counts.
    staleTime: 5_000,
  });
  const lines = (data?.diff ?? '').split('\n');

  // Escape closes it, like every other overlay in the app.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Diff of ${filePath}`}
      data-testid="file-diff-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border-soft bg-canvas shadow-xl"
        // The overlay closes on click; the panel must not, or every drag that
        // ends outside the text would dismiss it.
        onClick={e => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border-soft bg-nav-surface px-3 py-2">
          <span className="truncate font-mono text-[11px] text-ink" title={filePath}>{filePath}</span>
          {staged && (
            <span className="shrink-0 rounded border border-border-soft px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-tertiary">
              staged
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close diff"
            className="ml-auto shrink-0 rounded p-1 text-ink-tertiary transition-colors hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>

        {/* The one assertion this must not make: "no changes" before the
            answer is in. The panel's own rule, applied here. */}
        {isPending && !isError && (
          <p className="px-3 py-4 text-[11px] text-ink-tertiary">Reading the diff…</p>
        )}
        {isError && (
          <p role="alert" className="m-3 rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
            Could not read the diff: {(error as Error)?.message ?? 'failed'}
          </p>
        )}
        {!isPending && !isError && data?.diff === '' && (
          <p className="px-3 py-4 text-[11px] text-ink-tertiary">No textual diff for this file.</p>
        )}

        {!isError && data?.diff !== '' && (
          <div className="min-h-0 flex-1 overflow-auto scrollbar-slim bg-canvas">
            <pre className="w-max min-w-full p-3 font-mono text-[11px] leading-[1.5]">
              {lines.map((line, i) => (
                // Index keys are right here: a diff's lines have no identity of
                // their own, and the list is replaced whole on refetch.
                <div key={i} className={clsx('whitespace-pre', lineClass(line))}>{line === '' ? ' ' : line}</div>
              ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
