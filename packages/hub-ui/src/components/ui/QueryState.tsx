import { apiErrorText } from '../../apiError';
import { Callout } from './Callout';

/**
 * A panel whose query failed: what the server said, and Retry. Replaces a
 * "Loading…" that never ends and an empty state that isn't true.
 */
export function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Callout tone="danger" live="polite" title={apiErrorText(error)}
      action={<button type="button" onClick={onRetry} className="text-xs font-semibold text-accent-ink hover:underline">Retry</button>}
    >
      The hub could not load this.
    </Callout>
  );
}
