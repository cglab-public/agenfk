/**
 * Verifies running for more than 10 seconds, in any project (3aea49f1, CGLAB-430).
 *
 * User 2026-09-28: "Ongoing verify calls >10s should appear somewhere in the
 * UI so the user can click on it and open the respective card (independent of
 * project)." A chip in the board's header - which the desktop shell wraps too -
 * counts them; its list says, for each, the project and card, the step, how
 * long, what it is doing and the last line it printed. A click switches to the
 * card's project and opens the card on Overview, where the run's output streams.
 *
 * The list is GET /verify-runs, replaced by every 'verify_runs' socket push; the
 * 10 seconds are counted here, on the board's one seconds clock.
 */
import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '../api';
import { useSocketEvent } from '../SocketContext';
import { useActiveProject } from '../ActiveProject';
import { subscribeToSeconds, formatElapsed } from '../secondsTick';
import type { VerifyRunEntry } from '../types';
import { VERIFY_RUNS_QUERY_KEY, VERIFY_RUNS_THRESHOLD_MS, phaseText } from '../verifyRuns';

/**
 * `placement`: where the list opens - below the chip in the board's header, above it in the desktop shell's status
 * bar (beae41a0: the board's header is hidden whenever another tab shows, so the shell carries its own).
 */
export function VerifyRunsChip({ placement = 'down' }: { placement?: 'down' | 'up' } = {}): React.ReactElement | null {
  const queryClient = useQueryClient();
  const { focusItem } = useActiveProject();
  const { data } = useQuery({ queryKey: VERIFY_RUNS_QUERY_KEY, queryFn: () => api.getVerifyRuns() });
  useSocketEvent<VerifyRunEntry[]>('verify_runs', list => queryClient.setQueryData(VERIFY_RUNS_QUERY_KEY, Array.isArray(list) ? list : []));
  // beae41a0: a restarted server or a dropped connection lost what was pushed meanwhile - read it again.
  useSocketEvent('connect', () => { void queryClient.invalidateQueries({ queryKey: VERIFY_RUNS_QUERY_KEY }); });
  const listId = React.useId();
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => subscribeToSeconds(() => setNow(Date.now())), []);
  const [openAsked, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const shown = (data ?? []).filter(e => now - Date.parse(e.startedAt) >= VERIFY_RUNS_THRESHOLD_MS);
  // Nothing left to list: the popover goes with the chip, and is not left asked for - the next run would
  // otherwise bring it back open, unasked. Adjusted while rendering (React's pattern for state that follows props).
  if (!shown.length && openAsked) setOpen(false);
  const open = openAsked && shown.length > 0;

  React.useEffect(() => {
    if (!open) return;
    // beae41a0: focus goes back to the chip, not to the page, when the list it was in goes.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);
  if (!shown.length) return null;
  const label = `${shown.length} ${shown.length === 1 ? 'verify' : 'verifies'} running`;
  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="verify-runs-chip"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(o => !o)}
        title="Verifies running for more than 10 seconds, in every project"
        className={`flex items-center gap-1.5 rounded-lg font-bold bg-brand/10 text-brand border border-brand/30 hover:bg-brand/15 transition-all ${placement === 'up' ? 'px-2 py-0 text-[11px]' : 'px-2.5 py-1.5 text-xs'}`}
      >
        <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        <span>{label}</span>
      </button>
      {open && (
        // A disclosure (beae41a0): the button shows a list of links to cards; it never claimed focus as a dialog would.
        <div
          id={listId}
          data-testid="verify-runs-list"
          role="region"
          aria-label="Verifies running"
          className={`absolute ${placement === 'up' ? 'left-0 bottom-full mb-2' : 'right-0 top-full mt-2'} z-30 w-80 max-w-[90vw] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg p-1`}
        >
          <ul className="max-h-96 overflow-auto">
            {shown.map(e => (
              <li key={e.runId ?? `${e.itemId}:person`}>
                <button
                  type="button"
                  data-testid="verify-run-entry"
                  onClick={() => { setOpen(false); focusItem(e.itemId, e.projectId, { open: true }); }}
                  className="w-full text-left rounded-lg px-2.5 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="flex-1 min-w-0 truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
                      {e.projectName ? <span className="text-slate-500 dark:text-slate-400 font-medium">{e.projectName} · </span> : null}
                      {e.title ?? e.itemId.slice(0, 8)}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-slate-500">{formatElapsed(now - Date.parse(e.startedAt))}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    {e.step} · {phaseText(e.phase)}
                  </div>
                  {e.lastLine && (
                    <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400 dark:text-slate-500">{e.lastLine}</div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
