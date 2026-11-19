import { useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { apiErrorText } from '../apiError';
import { Callout, QueryError, buttonClass, cardClass, cn, controlClass, scrollClass } from '../components/ui';
import { hostFacts, type HostContextDto, type HostLabelDto } from '../airlockHostText';

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
  /** How many of the hits sent the host data, across installations. */
  uploads: number;
  evidence: 'proxy' | 'agent-reported';
  clients: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** What the installations' imports knew of it (absent from a hub before 2026-11-02). */
  context?: HostContextDto | null;
  /** Projects beyond those listed. */
  moreProjects?: number;
  labels?: HostLabelDto[];
}
/** Proposed hosts sharing a registrable domain, offered as one `*.domain` entry. */
interface AirlockLearningWildcard { pattern: string; hosts: string[]; hits: number; uploads: number; evidence: 'proxy' | 'agent-reported' }
interface AirlockLearningList { revision: number; hosts: AirlockLearningHost[]; wildcards?: AirlockLearningWildcard[] }
type Direction = 'download' | 'upload' | 'both';

function plural(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}`; }

const DIRECTIONS: Array<{ value: Direction; label: string }> = [
  { value: 'download', label: 'Download' },
  { value: 'upload', label: 'Upload' },
  { value: 'both', label: 'Both' },
];
/** Where a direction starts: what was seen - downloads only, or data sent to it too. */
const seenDirection = (uploads: number): Direction => (uploads > 0 ? 'both' : 'download');
/** The direction hint: whether a tool call ever sent the host data. */
const sentData = (uploads: number): string => (uploads > 0 ? `sent data ${plural(uploads, 'time')}` : 'downloads only');

function DirectionPicker({ pattern, value, onChange }: { pattern: string; value: Direction; onChange: (d: Direction) => void }) {
  return (
    <select aria-label={`Direction for ${pattern}`} value={value} onChange={e => onChange(e.target.value as Direction)} className={cn(controlClass, 'ml-auto w-auto shrink-0')}>
      {DIRECTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
    </select>
  );
}

/** What is known of a host, to decide on it: its labels, reverse DNS name and projects, and a model hint marked as one. */
function HostContext({ labels, context, moreProjects = 0 }: { labels?: HostLabelDto[]; context?: HostContextDto | null; moreProjects?: number }) {
  const facts = hostFacts(labels, context, moreProjects);
  if (!facts.length && !context?.hint) return null;
  return (
    <>
      {facts.length > 0 && <p className="text-ink-tertiary">{facts.join(' · ')}</p>}
      {context?.hint && (
        <p className="text-ink-secondary">
          <span className="text-ink-tertiary">{`Model hint (${context.hintBy ?? 'unknown'}): `}</span>
          <span className="italic">{context.hint}</span>
        </p>
      )}
    </>
  );
}

function ProposedHosts({ list, selected, setSelected, directions, setDirections }: {
  list: AirlockLearningList;
  selected: ReadonlySet<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  directions: ReadonlyMap<string, Direction>;
  setDirections: Dispatch<SetStateAction<Map<string, Direction>>>;
}) {
  const qc = useQueryClient();
  const wildcards = list.wildcards ?? [];
  const directionOf = (pattern: string, uploads: number) => directions.get(pattern) ?? seenDirection(uploads);
  const setDirection = (pattern: string) => (d: Direction) => { accept.reset(); setDirections(m => new Map(m).set(pattern, d)); };
  const entries = [
    ...list.hosts.filter(h => selected.has(h.host)).map(h => ({ pattern: h.host, direction: directionOf(h.host, h.uploads ?? 0) })),
    ...wildcards.filter(w => selected.has(w.pattern)).map(w => ({ pattern: w.pattern, direction: directionOf(w.pattern, w.uploads) })),
  ];
  const pickedHosts = list.hosts.filter(h => selected.has(h.host)).length;
  const accept = useMutation({
    mutationFn: async () => (await api.post('/v1/admin/airlock/learning/accept', { entries, expectedRevision: list.revision })).data as { revision: number },
    onSuccess: () => {
      for (const key of ['admin-airlock', 'admin-airlock-installations', 'admin-airlock-history', 'admin-airlock-learning']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
  const toggle = (pattern: string) => setSelected(s => {
    const next = new Set(s);
    if (next.has(pattern)) next.delete(pattern); else next.add(pattern);
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
                {` · `}
                <span className={(h.uploads ?? 0) > 0 ? 'text-status-warn-text' : undefined}>{sentData(h.uploads ?? 0)}</span>
              </p>
              <HostContext labels={h.labels} context={h.context} moreProjects={h.moreProjects} />
            </div>
            <DirectionPicker pattern={h.host} value={directionOf(h.host, h.uploads ?? 0)} onChange={setDirection(h.host)} />
          </li>
        ))}
      </ul>
      {wildcards.length > 0 && (
        <>
          <h4 className="mt-4 text-small font-semibold text-ink">Wildcards</h4>
          <p className="text-small text-ink-tertiary">Hosts sharing a domain, as one entry. Never offered over shared hosting, tunnels or object storage.</p>
          <ul className="mt-2 space-y-1.5" aria-label="Proposed wildcards">
            {wildcards.map(w => (
              <li key={w.pattern} className="flex items-start gap-2 text-small">
                <input type="checkbox" className="mt-1" aria-label={w.pattern} checked={selected.has(w.pattern)} onChange={() => { accept.reset(); toggle(w.pattern); }} />
                <div className="min-w-0">
                  <code className="break-all font-mono text-ink">{w.pattern}</code>
                  <p className="text-ink-tertiary">
                    {`covers ${w.hosts.join(', ')} · ${plural(w.hits, 'hit')} · `}
                    <span className={w.uploads > 0 ? 'text-status-warn-text' : undefined}>{sentData(w.uploads)}</span>
                  </p>
                </div>
                <DirectionPicker pattern={w.pattern} value={directionOf(w.pattern, w.uploads)} onChange={setDirection(w.pattern)} />
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" className={buttonClass('secondary')} onClick={() => { accept.reset(); setSelected(new Set(list.hosts.map(h => h.host))); }}>Select all</button>
        <button type="button" className={buttonClass('primary')} disabled={entries.length === 0 || accept.isPending} onClick={() => accept.mutate()}>
          {entries.length > pickedHosts ? `Allow ${entries.length} selected` : `Allow ${plural(pickedHosts, 'selected host')}`}
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
  // Directions the admin picked, by host or wildcard; the rest start at what was seen.
  const [directions, setDirections] = useState<Map<string, Direction>>(() => new Map());
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
        <ProposedHosts list={q.data} selected={selected} setSelected={setSelected} directions={directions} setDirections={setDirections} />
      )}
    </section>
  );
}
