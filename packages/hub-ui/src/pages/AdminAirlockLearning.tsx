import { useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { apiErrorText } from '../apiError';
import { Callout, QueryError, buttonClass, cardClass, scrollClass } from '../components/ui';

/**
 * Admin → Airlock → Proposed hosts (GH-294, TEL-3). Hub-joined installations
 * cannot change the org's policy, so a person there forwards the hosts their
 * sessions reached; the hub lists them one row per host, however many
 * installations proposed it. Allowing some of them saves the next policy
 * revision against the one this list was read at (audited like any save).
 * Hosts the policy already covers are never listed. Nothing starts
 * selected, and the selection is kept by host across refreshes: a host that
 * arrives later comes in unselected, and one deselected stays so.
 */
export interface AirlockLearningHost {
  host: string;
  installations: number;
  hits: number;
  proxyHits: number;
  evidence: 'proxy' | 'agent-reported';
  clients: string[];
  firstSeen: string | null;
  lastSeen: string | null;
}
interface AirlockLearningList { revision: number; hosts: AirlockLearningHost[] }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ProposedHosts({ list, selected, setSelected }: {
  list: AirlockLearningList;
  selected: ReadonlySet<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}) {
  const qc = useQueryClient();
  const picked = list.hosts.map(h => h.host).filter(h => selected.has(h));
  const accept = useMutation({
    mutationFn: async () => (await api.post('/v1/admin/airlock/learning/accept', { hosts: picked, expectedRevision: list.revision })).data as { revision: number },
    onSuccess: () => {
      for (const key of ['admin-airlock', 'admin-airlock-installations', 'admin-airlock-history', 'admin-airlock-learning']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
  const toggle = (host: string) => setSelected(s => {
    const next = new Set(s);
    if (next.has(host)) next.delete(host); else next.add(host);
    return next;
  });
  if (list.hosts.length === 0) {
    return <p className="mt-2 text-small text-ink-tertiary">No hosts proposed: no installation has sent one the policy does not already cover.</p>;
  }
  return (
    <>
      <ul className={`mt-3 space-y-1.5 ${scrollClass}`} aria-label="Proposed hosts">
        {list.hosts.map(h => (
          <li key={h.host} className="flex items-start gap-2 text-small">
            <input type="checkbox" className="mt-1" aria-label={h.host} checked={selected.has(h.host)} onChange={() => { accept.reset(); toggle(h.host); }} />
            <div className="min-w-0">
              <code className="break-all font-mono text-ink">{h.host}</code>
              <p className="text-ink-tertiary">
                {`${plural(h.installations, 'installation')} · ${plural(h.hits, 'hit')} · ${h.clients.join(', ') || 'unknown client'} · `}
                {h.evidence === 'proxy' ? `seen by the sandbox proxy (${plural(h.proxyHits, 'time')})` : 'agent-reported (tool calls or imported logs)'}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <button type="button" className={buttonClass('secondary')} onClick={() => { accept.reset(); setSelected(new Set(list.hosts.map(h => h.host))); }}>Select all</button>
        <button type="button" className={buttonClass('primary')} disabled={picked.length === 0 || accept.isPending} onClick={() => accept.mutate()}>
          {`Allow ${plural(picked.length, 'selected host')}`}
        </button>
      </div>
      {accept.isError && <Callout tone="danger" live="assertive" className="mt-3">{apiErrorText(accept.error)}</Callout>}
      {accept.isSuccess && <Callout tone="ok" live="polite" className="mt-3">{`Allowed (revision ${accept.data.revision}).`}</Callout>}
    </>
  );
}

export function AirlockLearningCard() {
  // Here, not in ProposedHosts: it outlives a refresh of the list, and is kept by host.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const q = useQuery<AirlockLearningList>({
    queryKey: ['admin-airlock-learning'],
    queryFn: async () => (await api.get('/v1/admin/airlock/learning')).data as AirlockLearningList,
  });
  return (
    <section className={`${cardClass} max-w-form`}>
      <h3 className="text-body font-semibold text-ink">Proposed hosts</h3>
      <p className="mt-1 text-small text-ink-tertiary">
        Hosts installations&apos; sessions reached that no list names, sent by a person there. Nothing is allowed until you allow it.
        Proxy evidence comes from the sandbox and cannot be forged by an agent; agent-reported hosts can.
      </p>
      {q.isError && !q.data ? <QueryError error={q.error} onRetry={() => q.refetch()} /> : !q.data ? (
        <p role="status" className="mt-2 text-small text-ink-tertiary">Loading…</p>
      ) : (
        <ProposedHosts list={q.data} selected={selected} setSelected={setSelected} />
      )}
    </section>
  );
}
