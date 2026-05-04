import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

interface HistogramBucket { time: string; total: number; by_type: Record<string, number> }
interface HistogramResponse { bucket: 'day' | 'hour'; buckets: HistogramBucket[] }

interface Props {
  users?: string[];
  types?: string[];
  className?: string;
}

const RANGES: Array<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

const TYPE_COLOR: Record<string, string> = {
  'item.created': '#60a5fa',
  'item.updated': '#34d399',
  'item.moved': '#a78bfa',
  'step.transitioned': '#f59e0b',
  'validate.invoked': '#94a3b8',
  'validate.passed': '#10b981',
  'validate.failed': '#ef4444',
  'comment.added': '#f472b6',
  'tokens.logged': '#22d3ee',
  'test.logged': '#eab308',
};
const DEFAULT_COLOR = '#71717a';

function fmtBucketKey(d: Date, bucket: 'day' | 'hour'): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (bucket === 'day') return `${yyyy}-${mm}-${dd}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:00`;
}

function buildAxis(days: number, bucket: 'day' | 'hour'): string[] {
  const out: string[] = [];
  const now = new Date();
  const start = new Date(now.getTime() - days * 86400_000);
  if (bucket === 'day') {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    while (d <= end) {
      out.push(fmtBucketKey(d, 'day'));
      d.setUTCDate(d.getUTCDate() + 1);
    }
  } else {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), start.getUTCHours()));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
    while (d <= end) {
      out.push(fmtBucketKey(d, 'hour'));
      d.setUTCHours(d.getUTCHours() + 1);
    }
  }
  return out;
}

export function TimelineBar({ users, types, className }: Props) {
  const [days, setDays] = useState(30);
  const [bucket, setBucket] = useState<'day' | 'hour'>('day');

  const fromIso = useMemo(() => new Date(Date.now() - days * 86400_000).toISOString(), [days]);

  const params = new URLSearchParams();
  if (users?.length) params.set('users', users.join(','));
  if (types?.length) params.set('types', types.join(','));
  params.set('from', fromIso);
  params.set('bucket', bucket);

  const q = useQuery<HistogramResponse>({
    queryKey: ['histogram', users?.join(',') ?? '', types?.join(',') ?? '', days, bucket],
    queryFn: async () => (await api.get(`/v1/histogram?${params}`)).data,
  });

  const axis = useMemo(() => buildAxis(days, bucket), [days, bucket]);
  const byTime = useMemo(() => {
    const map = new Map<string, HistogramBucket>();
    for (const b of q.data?.buckets ?? []) map.set(b.time, b);
    return map;
  }, [q.data]);

  const maxTotal = useMemo(() => {
    let m = 0;
    for (const t of axis) {
      const b = byTime.get(t);
      if (b && b.total > m) m = b.total;
    }
    return m || 1;
  }, [axis, byTime]);

  const stackedTypes = types && types.length > 0 ? types : null;

  return (
    <div className={'border rounded p-3 ' + (className ?? '')}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-zinc-500">
          Events over the last {days} days{users?.length ? ` · ${users.length} user${users.length === 1 ? '' : 's'}` : ''}
        </div>
        <div className="flex gap-2">
          <div className="flex gap-1 text-xs">
            {RANGES.map(r => (
              <button key={r.label} onClick={() => setDays(r.days)}
                className={'px-2 py-0.5 rounded border ' + (days === r.days ? 'bg-zinc-900 text-white' : 'hover:bg-zinc-100')}>
                {r.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1 text-xs">
            {(['day', 'hour'] as const).map(b => (
              <button key={b} onClick={() => setBucket(b)}
                className={'px-2 py-0.5 rounded border ' + (bucket === b ? 'bg-zinc-900 text-white' : 'hover:bg-zinc-100')}>
                {b}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-end gap-px h-20" role="img" aria-label="Event timeline histogram">
        {axis.map(t => {
          const b = byTime.get(t);
          const total = b?.total ?? 0;
          const heightPct = (total / maxTotal) * 100;
          const segments = stackedTypes
            ? stackedTypes.map(tp => ({ type: tp, n: b?.by_type[tp] ?? 0 }))
            : [{ type: 'all', n: total }];
          const tooltip = `${t} · ${total} event${total === 1 ? '' : 's'}` +
            (b ? '\n' + Object.entries(b.by_type).map(([k, v]) => `${k}: ${v}`).join('\n') : '');
          return (
            <div key={t} title={tooltip} className="flex-1 flex flex-col-reverse min-w-[2px]"
                 style={{ height: '100%' }}>
              <div className="flex flex-col-reverse" style={{ height: `${heightPct}%` }}>
                {segments.map(s => {
                  const segPct = total ? (s.n / total) * 100 : 0;
                  if (!s.n) return null;
                  return (
                    <div key={s.type}
                         style={{ height: `${segPct}%`, background: stackedTypes ? (TYPE_COLOR[s.type] ?? DEFAULT_COLOR) : '#3b82f6' }} />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {stackedTypes && (
        <div className="flex flex-wrap gap-3 mt-2 text-xs text-zinc-500">
          {stackedTypes.map(tp => (
            <span key={tp} className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: TYPE_COLOR[tp] ?? DEFAULT_COLOR }} />
              <span className="font-mono">{tp}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
