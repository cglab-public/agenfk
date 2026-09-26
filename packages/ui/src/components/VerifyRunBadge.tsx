/**
 * A verify running on the card (9569b4d7).
 *
 * User 2026-09-25: "The running verify should be animated, even with the card
 * closed." So it sits on the Kanban card itself. The spinner is CSS - no timer
 * - and stops under reduced motion; the elapsed time ticks on the board's one
 * seconds clock (secondsTick.ts), so ten running cards are still one timer.
 */
import React from 'react';
import { Loader2 } from 'lucide-react';
import { subscribeToSeconds, formatElapsed } from '../secondsTick';
import type { ActiveRun } from '../types';

export function VerifyRunBadge({ run }: { run: ActiveRun }): React.ReactElement {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => subscribeToSeconds(() => setNow(Date.now())), []);
  const elapsed = formatElapsed(now - Date.parse(run.startedAt));
  return (
    // Not a live region: its text changes every second, and a status role would
    // have a screen reader announce every tick of every running card (review).
    <span
      data-testid="verify-running"
      title={`agenfk verify is running the checks for leaving ${run.step}`}
      className="inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded border bg-brand/10 text-brand border-brand/30"
    >
      <Loader2 size={10} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
      <span>Verifying… {elapsed}</span>
    </span>
  );
}

/** The Overview's view of the run: the badge, and the tail of what it printed, refreshed while it runs. */
export function VerifyRunOutput({ output }: { output: string }): React.ReactElement | null {
  // Test runners colour their output; the board shows it as plain text.
  // eslint-disable-next-line no-control-regex
  const tail = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').slice(-12).join('\n').trim();
  if (!tail) return null;
  return (
    <pre data-testid="verify-running-output" className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-950 text-slate-200 text-[10px] leading-snug p-2 whitespace-pre-wrap break-words">
      {tail}
    </pre>
  );
}
