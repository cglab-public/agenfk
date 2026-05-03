import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

interface MetricsResponse { bucket: string; series: Array<{ user_key: string; day: string; events_count: number; items_closed: number; tokens_in: number; tokens_out: number; validate_passes: number; validate_fails: number }> }
interface UsersResponse { user_key: string; last_seen: string; events_count: number }

export function OrgPage() {
  const metrics = useQuery<MetricsResponse>({ queryKey: ['metrics'], queryFn: async () => (await api.get('/v1/metrics')).data });
  const users = useQuery<UsersResponse[]>({ queryKey: ['users'], queryFn: async () => (await api.get('/v1/users')).data });

  const totals = (metrics.data?.series ?? []).reduce(
    (a, r) => ({
      events: a.events + r.events_count,
      closed: a.closed + r.items_closed,
      tokensIn: a.tokensIn + r.tokens_in,
      tokensOut: a.tokensOut + r.tokens_out,
      passes: a.passes + r.validate_passes,
      fails: a.fails + r.validate_fails,
    }),
    { events: 0, closed: 0, tokensIn: 0, tokensOut: 0, passes: 0, fails: 0 },
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Org rollup</h1>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Tile label="Events" value={totals.events} />
        <Tile label="Items closed" value={totals.closed} />
        <Tile label="Tokens in" value={totals.tokensIn} />
        <Tile label="Tokens out" value={totals.tokensOut} />
        <Tile label="Validate ✓" value={totals.passes} />
        <Tile label="Validate ✗" value={totals.fails} />
      </div>
      <h2 className="text-lg font-semibold mt-8">Users</h2>
      <div className="border rounded divide-y">
        {(users.data ?? []).map((u) => (
          <Link key={u.user_key} to={`/users/${encodeURIComponent(u.user_key)}`} className="flex items-center justify-between px-3 py-2 hover:bg-zinc-100/50 dark:hover:bg-zinc-800/50">
            <div className="font-mono text-sm">{u.user_key}</div>
            <div className="text-xs text-zinc-500">{u.events_count} events · last {u.last_seen}</div>
          </Link>
        ))}
        {users.data?.length === 0 && <div className="px-3 py-2 text-sm text-zinc-500">No users yet.</div>}
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border p-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}
