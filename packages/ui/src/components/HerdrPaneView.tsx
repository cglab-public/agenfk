/**
 * One herdr pane, on screen (96953f6a / CGLAB-266).
 *
 * Clicking a herdr row in the tree opens this: what that pane held when it was
 * read. It is where a person goes to see what the agent they did not start is
 * actually doing.
 *
 * A MIRROR, AND IT SAYS SO. Nothing streams here - the content is one
 * `pane.read` at the moment you asked. A surface that looks like a terminal and
 * never advances is worse than one that admits what it is, which is the warning
 * collie puts on its own page for the same reason.
 *
 * READ ONLY. The protocol can type into this pane and can move the operator's
 * real screen; neither is reachable from here. "Show in herdr" is the one
 * action offered, and it is a button somebody has to choose.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../apiUrl';
import { HerdrMark } from './HerdrMark';
import type { ProjectPaneRow } from '../herdrTreeRows';

export function HerdrPaneView({
  pane,
  onFocus,
}: {
  readonly pane: ProjectPaneRow;
  /** Bring it to the front in herdr. Absent means the action is not offered. */
  readonly onFocus?: (pane: ProjectPaneRow) => void;
}): React.ReactElement {
  const { data, isLoading, isError, error, dataUpdatedAt, refetch, isFetching } = useQuery<{
    text: string; truncated: boolean; revision?: number;
  }>({
    queryKey: ['herdr-pane', pane.paneId, pane.socketPath],
    enabled: Boolean(pane.socketPath),
    queryFn: async () => {
      const r = await fetch(
        `${API_URL}/herdr/panes/${encodeURIComponent(pane.paneId)}/content`
        + `?socket=${encodeURIComponent(pane.socketPath)}&lines=300&source=recent`,
      );
      if (r.status === 404) throw new Error('That pane is gone — herdr does not know it any more.');
      if (!r.ok) throw new Error(`Could not read the pane (${r.status}).`);
      return r.json();
    },
    // A photograph, so it does not refresh itself. The button says when it was
    // taken and takes another.
    staleTime: Infinity,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-2">
        <HerdrMark className="h-4 w-4 shrink-0 text-ink-tertiary" />
        <span className="font-mono text-[11px] text-ink-tertiary">{pane.agentId}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={pane.title}>
          {pane.title}
        </span>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="shrink-0 rounded px-2 py-1 font-mono text-[10px] text-ink-tertiary transition-colors hover:text-ink disabled:opacity-60"
        >
          {isFetching ? 'Reading…' : 'Read again'}
        </button>
        {onFocus && (
          /*
           * The ONE action, and it is explicit. `pane.focus` moves the pane,
           * the tab AND the workspace on the operator's real screen while they
           * are working - collie reaches for it from exactly one place too.
           */
          <button
            type="button"
            onClick={() => onFocus(pane)}
            className="shrink-0 rounded border border-border-soft px-2 py-1 text-[10px] text-ink-secondary transition-colors hover:text-ink"
          >
            Show in herdr
          </button>
        )}
      </header>

      <p className="shrink-0 px-4 pt-2 text-[11px] text-ink-tertiary">
        A mirror, not a terminal — this is what the pane held when it was read
        {dataUpdatedAt ? `, ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ''}.
      </p>

      {!pane.socketPath ? (
        // A guessed socket would read somebody else's pane, so the honest
        // answer is to say we cannot rather than to try.
        <p data-testid="herdr-pane-nosocket" className="px-4 py-3 text-[12px] text-amber-600 dark:text-amber-400">
          This pane did not say which herdr session it belongs to, so it cannot be read.
        </p>
      ) : isLoading ? (
        <p className="px-4 py-3 text-[12px] text-ink-tertiary">Reading…</p>
      ) : isError ? (
        <p data-testid="herdr-pane-error" className="px-4 py-3 text-[12px] text-amber-600 dark:text-amber-400">
          {(error as Error).message}
        </p>
      ) : (
        <pre
          data-testid="herdr-pane-content"
          className="m-4 mt-2 min-h-0 flex-1 overflow-auto rounded bg-sunken p-3 font-mono text-[11px] leading-snug text-ink-secondary"
        >
          {data?.text?.trimEnd() || 'This pane has nothing to show right now.'}
        </pre>
      )}

      {data?.truncated && (
        <p className="shrink-0 px-4 pb-3 text-[11px] text-ink-tertiary">
          herdr had more than it sent; this is the tail.
        </p>
      )}
    </div>
  );
}
