import { Link, useParams } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import { api } from '../api';
import { TimelineBar } from '../components/TimelineBar';

interface TimelineRow {
  event_id: string; occurred_at: string; type: string; project_id: string | null; item_id: string | null; user_key: string; payload: any;
}
interface EventTypesResponse { types: string[] }

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const TYPE_BADGE: Record<string, string> = {
  'item.created':       'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800',
  'item.updated':       'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800',
  'item.moved':         'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800',
  'step.transitioned':  'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  'validate.invoked':   'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  'validate.passed':    'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  'validate.failed':    'bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  'comment.added':      'bg-pink-50 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300 border-pink-200 dark:border-pink-800',
  'tokens.logged':      'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800',
  'test.logged':        'bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800',
};
const DEFAULT_BADGE = 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700';

export function UserDetailPage() {
  const { userKey = '' } = useParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const decoded = decodeURIComponent(userKey);

  const eventTypes = useQuery<EventTypesResponse>({
    queryKey: ['event-types'],
    queryFn: async () => (await api.get('/v1/event-types')).data,
  });

  const params = new URLSearchParams();
  params.set('users', decoded);
  if (selected.size) params.set('types', [...selected].join(','));
  params.set('limit', '200');

  const tl = useQuery<{ events: TimelineRow[] }>({
    queryKey: ['timeline', userKey, [...selected].sort().join(',')],
    queryFn: async () => (await api.get(`/v1/timeline?${params}`)).data,
  });

  const toggle = (t: string) => {
    const next = new Set(selected);
    if (next.has(t)) next.delete(t); else next.add(t);
    setSelected(next);
  };

  const types = eventTypes.data?.types ?? [];

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to org
      </Link>

      <header className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white text-base font-bold flex items-center justify-center shadow-sm">
          {decoded.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-400 font-semibold">User</p>
          <h1 className="mt-0.5 text-xl font-bold tracking-tight font-mono text-slate-900 dark:text-slate-100 truncate">{decoded}</h1>
        </div>
      </header>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Filter by event type</h2>
          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="text-[11px] font-medium text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
            >
              Clear ({selected.size})
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {types.length === 0 && (
            <span className="text-[11px] text-slate-400">No events recorded for this user yet.</span>
          )}
          {types.map(t => {
            const on = selected.has(t);
            return (
              <button
                key={t}
                onClick={() => toggle(t)}
                className={`px-2.5 py-1 rounded-full font-mono text-[11px] border transition-colors ${on
                  ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-300 hover:text-indigo-700 dark:hover:text-indigo-300'}`}
              >
                {t}
              </button>
            );
          })}
        </div>
        <TimelineBar users={[decoded]} types={[...selected]} title="Activity timeline" />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Recent events</h2>
          <span className="text-[11px] text-slate-500">{tl.data?.events.length ?? 0} shown</span>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
          {(tl.data?.events ?? []).map(e => {
            const badge = TYPE_BADGE[e.type] ?? DEFAULT_BADGE;
            return (
              <details key={e.event_id} className="group">
                <summary className="flex items-center gap-3 px-5 py-2.5 cursor-pointer list-none hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400 group-open:rotate-180 transition-transform shrink-0" />
                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono border ${badge}`}>{e.type}</span>
                  <span className="text-[12px] text-slate-700 dark:text-slate-300 truncate flex-1">{e.item_id ?? e.project_id ?? '—'}</span>
                  <span className="text-[11px] text-slate-400 tabular-nums shrink-0">{formatTime(e.occurred_at)}</span>
                </summary>
                <pre className="px-5 pb-3 text-[11px] font-mono text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-words bg-slate-50/60 dark:bg-slate-950/40 border-t border-slate-100 dark:border-slate-800 -mt-0.5">{JSON.stringify(e.payload, null, 2)}</pre>
              </details>
            );
          })}
          {tl.data?.events.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-slate-500">No events match the current filter.</div>
          )}
        </div>
      </section>
    </div>
  );
}
