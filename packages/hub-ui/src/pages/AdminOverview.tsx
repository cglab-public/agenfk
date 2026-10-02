// Where /admin lands: one card per area with the few numbers that say whether
// it needs attention, and links into its sections. A count that cannot load
// shows a dash, never a zero that reads as "none".
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Card, CardHeader } from '../components/ui';
import { ADMIN_GROUPS, AdminGroup } from './adminSections';
import { SILENT_DAYS, silentDays } from './installationStaleness';

interface UserRow { role: string; active: number }
interface InstallationRow { lastSeen: string | null }
interface KeyRow { revokedAt: string | null }
interface AuthConfig { passwordEnabled: boolean; googleEnabled: boolean; entraEnabled: boolean }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function useAdminGet<T>(key: string, url: string) {
  return useQuery<T>({ queryKey: [key], queryFn: async () => (await api.get(url)).data });
}

export function AdminOverview() {
  const users = useAdminGet<UserRow[]>('admin-users', '/v1/admin/users');
  const installs = useAdminGet<InstallationRow[]>('admin-installations', '/v1/admin/installations');
  const keys = useAdminGet<KeyRow[]>('api-keys', '/v1/admin/api-keys');
  const auth = useAdminGet<AuthConfig>('auth-config', '/v1/admin/auth-config');

  const count = <T,>(q: { data?: T; isError: boolean }, label: string, fmt: (d: T) => string): string =>
    q.isError ? `${label}: —` : q.data === undefined ? `${label}: …` : fmt(q.data);

  const facts: Record<string, string[]> = {
    people: [
      count(users, 'Users', rows => {
        const active = rows.filter(u => u.active);
        return `${plural(active.length, 'active user')} · ${plural(active.filter(u => u.role === 'admin').length, 'admin')}`;
      }),
      count(installs, 'Installations', rows => {
        const silent = rows.filter(r => silentDays(r.lastSeen) !== null).length;
        return `${plural(rows.length, 'installation')} · ${silent} silent for ${SILENT_DAYS}+ days`;
      }),
    ],
    access: [
      count(auth, 'Sign-in', c => {
        const on = [c.passwordEnabled && 'Password', c.googleEnabled && 'Google', c.entraEnabled && 'Microsoft Entra'].filter(Boolean);
        return on.length ? `Sign-in: ${on.join(', ')}` : 'Sign-in: no provider on';
      }),
      count(keys, 'API keys', rows => plural(rows.filter(k => !k.revokedAt).length, 'active API key')),
    ],
    fleet: [],
    hub: [],
  };

  return (
    <div className="space-y-4">
      <h2 className="text-title font-semibold text-ink">Overview</h2>
      <div className="grid gap-4 md:grid-cols-2">
        {ADMIN_GROUPS.map(g => <AreaCard key={g.id} group={g} facts={facts[g.id] ?? []} />)}
      </div>
    </div>
  );
}

function AreaCard({ group, facts }: { group: AdminGroup; facts: string[] }) {
  const headingId = `admin-area-${group.id}`;
  return (
    <Card aria-labelledby={headingId}>
      <CardHeader id={headingId} title={group.label} />
      {facts.length > 0 && (
        <ul className="mb-3 space-y-1 text-body text-ink-secondary">
          {facts.map(f => <li key={f}>{f}</li>)}
        </ul>
      )}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-body">
        {group.sections.map(s => (
          <li key={s.to}><Link to={`/admin/${s.to}`} className="text-accent-ink hover:underline">{s.label}</Link></li>
        ))}
      </ul>
    </Card>
  );
}
