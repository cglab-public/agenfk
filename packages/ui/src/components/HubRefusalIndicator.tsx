import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, X } from 'lucide-react';
import { api } from '../api';

export interface HubRefusals {
  count: number;
  actionable: number;
  since: string | null;
  reasons: Record<string, number>;
  unparseable: number;
  hint: string | null;
}

const DISMISS_KEY = 'agenfk_dismissed_hub_refusals';

function readDismissed(): string | null {
  try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
}

/**
 * Events the hub refused and this machine kept in its deadletter (#223). A
 * machine whose every event is refused used to look perfectly healthy here;
 * this stays until the deadletter is emptied (requeued or discarded), or until
 * the viewer dismisses this exact state — more refusals bring it back.
 */
export const HubRefusalIndicator: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);

  const { data } = useQuery<HubRefusals>({
    queryKey: ['hubRefusals'],
    // Wrapped, not passed by reference: a board spec whose api mock lacks this
    // method then fails the query (rendering nothing) instead of crashing.
    queryFn: () => api.getHubRefusals(),
    refetchInterval: 60_000,
    retry: false,
  });

  if (!data || !(data.actionable > 0)) return null;
  const stateKey = `${data.count}|${data.since}`;
  if (dismissed === stateKey) return null;

  const title = `Hub refused ${data.actionable} event(s) since ${data.since ?? 'an unknown time'}`;
  const reasons = Object.entries(data.reasons ?? {}).sort((a, b) => b[1] - a[1]);

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, stateKey); } catch { /* private mode: dismiss for this session only */ }
    setDismissed(stateKey);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        data-testid="hub-refusal-indicator"
        onClick={() => setOpen(o => !o)}
        title={title}
        className="relative p-2 rounded-lg border shadow-sm transition-all hover:scale-105 bg-status-danger-bg text-status-danger-text border-status-danger-text/40 hover:border-status-danger-text"
      >
        <ShieldAlert size={18} />
        <span className="absolute -top-1 -right-1 flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-status-danger-text"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-status-danger-text"></span>
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-80 rounded-xl border border-status-danger-text/40 bg-surface shadow-2xl p-4 text-xs">
          <div className="flex items-start justify-between gap-2">
            <p className="font-bold text-status-danger-text">{title}</p>
            <button onClick={() => setOpen(false)} aria-label="Close" className="text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          </div>
          <p className="mt-1 text-slate-600 dark:text-slate-300">
            These events are not on the hub: its metrics are missing them until they are sent again.
          </p>
          <ul className="mt-2 font-mono text-slate-600 dark:text-slate-300">
            {reasons.map(([reason, n]) => <li key={reason}>{reason}: {n}</li>)}
            {data.unparseable > 0 && <li>unparseable: {data.unparseable}</li>}
          </ul>
          {data.hint && <p className="mt-2 text-slate-700 dark:text-slate-200">{data.hint}</p>}
          <div className="mt-3 flex justify-end">
            <button onClick={dismiss} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 font-medium">
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
