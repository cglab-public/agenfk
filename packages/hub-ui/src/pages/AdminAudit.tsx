import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Badge, buttonClass, cardClass, Field, Input, LocalTime, QueryError, Select } from '../components/ui';
import { auditDiff } from './auditDiff';

/**
 * Admin → Audit log (STORY a89af514): who changed which setting, when, from
 * where, and from what to what. Newest first; the filters are the hub's, so
 * the CSV export carries exactly the view on screen. Rows are append-only on
 * the hub - nothing here edits one.
 */
export interface AuditRowView {
  id: string;
  at: string;
  actorUserId: string | null;
  actorEmail: string | null;
  source: 'board' | 'cli' | 'api-key' | 'federation' | 'system';
  ip: string | null;
  area: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  link: string | null;
}
interface AuditPage { rows: AuditRowView[]; next: string | null }

export const AUDIT_AREAS: Array<{ value: string; label: string }> = [
  { value: 'flows', label: 'Flows' },
  { value: 'sign-in', label: 'Sign-in' },
  { value: 'users', label: 'Users' },
  { value: 'people', label: 'Hidden people' },
  { value: 'identities', label: 'Identities' },
  { value: 'models', label: 'Models' },
  { value: 'api-keys', label: 'API keys & invites' },
  { value: 'installations', label: 'Installations' },
  { value: 'registry', label: 'Flow registry' },
  { value: 'upgrades', label: 'Upgrades' },
  { value: 'federation', label: 'Federation' },
  { value: 'jira', label: 'JIRA' },
  { value: 'org', label: 'Organization' },
];
const SOURCE_LABEL: Record<string, string> = { board: 'Board', cli: 'CLI', 'api-key': 'API key', federation: 'Federation', system: 'System' };

const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

function AuditRowItem({ row }: { row: AuditRowView }) {
  const [open, setOpen] = useState(false);
  const diffId = useId();
  const changes = auditDiff(row.before, row.after);
  return (
    <li data-testid="audit-row" className="py-3 border-b border-border-soft last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body">
        <LocalTime value={row.at} className="text-ink-tertiary font-mono text-caption" />
        <span className="font-semibold text-ink break-all">{row.actorEmail ?? 'unknown'}</span>
        <Badge tone="neutral">{SOURCE_LABEL[row.source] ?? row.source}</Badge>
        <span className="font-mono text-ink">{row.action}</span>
        {row.target && <span className="text-ink-secondary break-all">{row.target}</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-tertiary">
        <span>{AUDIT_AREAS.find(a => a.value === row.area)?.label ?? row.area}</span>
        {row.ip && <span className="font-mono">from {row.ip}</span>}
        {row.link && <Link to={row.link} className="underline text-ink-secondary">Open {AUDIT_AREAS.find(a => a.value === row.area)?.label ?? row.area}</Link>}
        <button
          type="button"
          className="underline text-ink-secondary"
          aria-expanded={open}
          aria-controls={diffId}
          onClick={() => setOpen(o => !o)}
        >
          {open ? 'Hide changes' : 'Show changes'}
        </button>
      </div>
      {open && (
        <div id={diffId} data-testid="audit-diff" className="mt-2 rounded-lg bg-canvas p-3 overflow-x-auto">
          {changes.length === 0
            ? <p className="text-caption text-ink-tertiary">No field-level difference recorded.</p>
            : (
              <ul className="space-y-1 text-caption">
                {changes.map(c => (
                  <li key={c.path} className="flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-mono text-ink">{c.path || '(value)'}</span>
                    <span className="font-mono text-ink-tertiary break-all">{show(c.before)} → <span className="text-ink">{show(c.after)}</span></span>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </li>
  );
}

export function AdminAudit() {
  const [area, setArea] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filters: Record<string, string> = Object.fromEntries(
    Object.entries({ area, actor: actor.trim(), from, to }).filter(([, v]) => v),
  );
  const qs = new URLSearchParams(filters).toString();

  const pages = useInfiniteQuery<AuditPage, Error, { pages: AuditPage[] }, unknown[], string | null>({
    queryKey: ['audit', qs],
    initialPageParam: null,
    queryFn: async ({ pageParam }) => (await api.get('/v1/admin/audit', { params: { ...filters, ...(pageParam ? { cursor: pageParam } : {}) } })).data,
    getNextPageParam: last => last.next ?? null,
  });
  const rows = pages.data?.pages.flatMap(p => p.rows) ?? [];

  return (
    <div className="space-y-4">
      <section className={cardClass}>
        <h3 className="text-body font-semibold text-ink">Audit log</h3>
        <p className="mt-1 text-body text-ink-tertiary">
          Every change to the hub's configuration: who made it, when, from where, and what it changed. Secrets are never recorded - only that one changed.
        </p>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="Area">
            <Select value={area} onChange={e => setArea(e.target.value)}>
              <option value="">All areas</option>
              {AUDIT_AREAS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </Select>
          </Field>
          <Field label="Actor">
            <Input type="search" value={actor} placeholder="email" onChange={e => setActor(e.target.value)} />
          </Field>
          <Field label="From">
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <a className={buttonClass('secondary')} href={`/v1/admin/audit.csv${qs ? `?${qs}` : ''}`} download>Export CSV</a>
        </div>
      </section>

      <section className={cardClass}>
        {pages.isError && <QueryError error={pages.error} onRetry={() => pages.refetch()} />}
        {pages.isPending && <p role="status" className="text-body text-ink-tertiary">Loading…</p>}
        {!pages.isPending && !pages.isError && rows.length === 0 && (
          <p className="text-body text-ink-tertiary">No changes recorded{qs ? ' for these filters' : ' yet'}.</p>
        )}
        {rows.length > 0 && <ul>{rows.map(r => <AuditRowItem key={r.id} row={r} />)}</ul>}
        {pages.hasNextPage && (
          <div className="mt-3">
            <button type="button" className={buttonClass('secondary')} disabled={pages.isFetchingNextPage} onClick={() => pages.fetchNextPage()}>
              {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
