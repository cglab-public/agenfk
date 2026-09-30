import { ReactNode } from 'react';
import { apiErrorText } from '../../apiError';
import { Callout } from './Callout';

/**
 * A panel whose query failed: what the server said, and Retry. Replaces a
 * "Loading…" that never ends and an empty state that isn't true.
 */
export function QueryError({ error, onRetry, live = 'polite', retrying = false }: {
  error: unknown;
  onRetry: () => void;
  /** 'assertive' for a page's main answer, whose failure is the news. */
  live?: 'polite' | 'assertive';
  /** A retry is in flight. The error stays until it answers, so say so. */
  retrying?: boolean;
}) {
  return (
    <Callout tone="danger" live={live} title={apiErrorText(error)}
      action={
        // aria-disabled, not disabled: disabling the focused button drops a
        // keyboard user's focus to <body> mid-retry.
        <button type="button" onClick={() => { if (!retrying) onRetry(); }} aria-disabled={retrying}
          className="text-xs font-semibold text-accent-ink hover:underline aria-disabled:opacity-60 aria-disabled:no-underline">
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      }
    >
      The hub could not load this.
    </Callout>
  );
}

/** Placeholder bars while a panel's first answer is on its way. */
export function Skeleton({ label, rows = 3, className }: { label: string; rows?: number; className?: string }) {
  return (
    <div role="status" aria-label={`Loading ${label}`} aria-busy="true" className={className}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 my-2 rounded bg-border-soft/60 animate-pulse" style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  );
}

interface QueryLike<T> {
  data: T | undefined;
  isError: boolean;
  error: unknown;
  isFetching?: boolean;
  refetch: () => unknown;
}

/**
 * What a panel shows before its data is usable. Loading is a skeleton, never
 * zeros: "0 reporting" while the request is in flight reads as an empty fleet.
 * A failure is the hub's message with Retry, never the empty state. Data already
 * on screen stays when a refetch fails, with the error above it.
 */
export function QueryState<T>({ query, label, isEmpty, empty, skeleton, live, children }: {
  query: QueryLike<T>;
  /** What is loading, for the skeleton's accessible name ("Loading users"). */
  label: string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  skeleton?: ReactNode;
  /** Polite by default: several panels on a page often fail together. */
  live?: 'polite' | 'assertive';
  children: (data: T) => ReactNode;
}) {
  const error = query.isError
    ? <QueryError error={query.error} onRetry={() => { void query.refetch(); }} live={live} retrying={query.isFetching} />
    : null;
  if (query.data === undefined) return error ?? <>{skeleton ?? <Skeleton label={label} />}</>;
  const body = isEmpty?.(query.data) ? empty : children(query.data);
  return <>{error}{body}</>;
}
