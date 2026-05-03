import { useParams } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

interface TimelineRow {
  event_id: string; occurred_at: string; type: string; project_id: string | null; item_id: string | null; user_key: string; payload: any;
}

const TYPES = ['item.created', 'item.updated', 'item.moved', 'step.transitioned', 'validate.invoked', 'validate.passed', 'validate.failed', 'comment.added', 'tokens.logged', 'test.logged'];

export function UserDetailPage() {
  const { userKey = '' } = useParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const params = new URLSearchParams();
  params.set('users', decodeURIComponent(userKey));
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

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold font-mono">{decodeURIComponent(userKey)}</h1>
      <div className="flex flex-wrap gap-2 text-xs">
        {TYPES.map(t => (
          <button key={t} onClick={() => toggle(t)}
                  className={'px-2 py-1 rounded border ' + (selected.has(t) ? 'bg-zinc-900 text-white' : 'hover:bg-zinc-100')}>
            {t}
          </button>
        ))}
      </div>
      <ul className="space-y-1">
        {(tl.data?.events ?? []).map(e => (
          <li key={e.event_id} className="border rounded px-3 py-2">
            <div className="flex justify-between text-xs text-zinc-500">
              <span>{e.occurred_at}</span>
              <span className="font-mono">{e.type}</span>
            </div>
            <details>
              <summary className="cursor-pointer text-sm">{e.item_id ?? e.project_id ?? '—'}</summary>
              <pre className="mt-1 text-xs whitespace-pre-wrap break-words">{JSON.stringify(e.payload, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
