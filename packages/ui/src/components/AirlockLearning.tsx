/**
 * GH-294 TEL-3: Airlock learning on the board - the proposed allowlist, the
 * hosts sessions reached that no list names. It is read when a person opens
 * it. Each host says what it rests on: the sandbox proxy, which the agent
 * cannot forge, or agent-reported tool calls and imported pi logs.
 *
 * Accepting is a person's act (user decision 2026-10-27), and the server is
 * the authority on it; this only draws it:
 *  - standalone: Allow writes the next local revision with the selected hosts
 *    added, against the revision the proposal was read at (a conflict, never a
 *    silent overwrite);
 *  - hub-joined: there is no Allow (the hub owns the policy); the person sends
 *    the selected hosts to the hub, where an org admin accepts them.
 *
 * Nothing starts selected, and the selection is kept by host across refreshes:
 * a host that arrives later comes in unselected, and one the person
 * deselected stays deselected (review finding 4).
 */
import React from 'react';
import axios from 'axios';
import { clsx } from 'clsx';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../apiUrl';
import { useSocketEvent } from '../SocketContext';
import { hostFacts, type HostContextDto, type HostLabelDto } from '../airlockHostText';

export interface AirlockProposedHostDto {
  host: string;
  hits: number;
  /** How many of the hits sent the host data. */
  uploads: number;
  sources: { tool: number; proxy: number; import: number };
  evidence: 'proxy' | 'agent-reported';
  firstSeen: string;
  lastSeen: string;
  clients: string[];
  cards: string[];
  /** What the latest import knew of it (absent from a server before 2026-11-02). */
  context?: HostContextDto | null;
  labels?: HostLabelDto[];
}
/** Proposed hosts sharing a registrable domain, offered as one `*.domain` entry. */
export interface AirlockProposedWildcardDto {
  pattern: string;
  hosts: string[];
  hits: number;
  uploads: number;
  evidence: 'proxy' | 'agent-reported';
}
export type DirectionDto = 'download' | 'upload' | 'both';
export interface AirlockLearningDto {
  proposal: { hosts: AirlockProposedHostDto[]; wildcards?: AirlockProposedWildcardDto[]; excluded: Array<{ host: string; reason: string }> };
  revision: number;
  source: 'hub' | 'local';
  hubManaged: boolean;
}

/** The learning routes, called as the board (x-agenfk-ui), never with the agent's token. */
export const learningApi = {
  get: async (): Promise<AirlockLearningDto> => (await axios.get(`${API_URL}/airlock/learning`)).data,
  accept: async (body: { entries: Array<{ pattern: string; direction: DirectionDto }>; expectedRevision: number }): Promise<{ revision: number }> =>
    (await axios.post(`${API_URL}/airlock/learning/accept`, body, { headers: { 'x-agenfk-ui': '1' } })).data,
  forward: async (body: { hosts: string[] }): Promise<{ forwarded: number }> =>
    (await axios.post(`${API_URL}/airlock/learning/forward`, body, { headers: { 'x-agenfk-ui': '1' } })).data,
};

const BLOCK = 'border-b border-border-soft py-4 last:border-b-0';
const SUBHEAD = 'text-[11px] font-bold uppercase tracking-[0.14em] text-ink-tertiary';
const HELP = 'mt-0.5 text-[12px] leading-snug text-ink-tertiary';
const SECONDARY_BUTTON = 'rounded-lg border border-border-soft px-2.5 py-1 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-50';
const PRIMARY_BUTTON = 'rounded-lg bg-brand px-3 py-1 text-xs font-bold text-navy disabled:opacity-50';

const REASONS: Record<string, string> = {
  'metadata-endpoint': 'cloud metadata endpoint',
  'ioc-host': 'on the IOC list',
  'denied-host': 'on the deny list',
  'already-allowed': 'already allowed',
  'private-address': 'private or local address',
  'reserved-name': 'reserved name (.test, .example, example.com)',
};

const DIRECTIONS: Array<{ value: DirectionDto; label: string }> = [
  { value: 'download', label: 'Download' },
  { value: 'upload', label: 'Upload' },
  { value: 'both', label: 'Both' },
];

/** Where a direction starts: what was seen - downloads only, or data sent to it too. */
const seenDirection = (uploads: number): DirectionDto => (uploads > 0 ? 'both' : 'download');

/** The direction hint: whether a tool call ever sent the host data. */
const sentData = (uploads: number): string => (uploads > 0 ? `sent data ${plural(uploads, 'time')}` : 'downloads only');

function plural(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}`; }
const day = (iso: string) => new Date(iso).toLocaleDateString();

function messageOf(e: unknown, fallback: string): string {
  const data = (e as { response?: { data?: { message?: string; error?: string } } } | null)?.response?.data;
  return data?.message ?? data?.error ?? fallback;
}

/** What is known of a host, to decide on it: its labels, reverse DNS name and projects, and a model hint marked as one. */
function HostContext({ labels, context }: { labels?: HostLabelDto[]; context?: HostContextDto | null }): React.ReactElement | null {
  const facts = hostFacts(labels, context);
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

function DirectionPicker({ pattern, value, onChange }: { pattern: string; value: DirectionDto; onChange: (d: DirectionDto) => void }): React.ReactElement {
  return (
    <select
      aria-label={`Direction for ${pattern}`}
      value={value}
      onChange={e => onChange(e.target.value as DirectionDto)}
      className="ml-auto shrink-0 rounded-md border border-border-soft bg-canvas px-1.5 py-0.5 text-[12px] text-ink-secondary"
    >
      {DIRECTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
    </select>
  );
}

function Proposal({ data, selected, setSelected, directions, setDirections }: {
  data: AirlockLearningDto;
  selected: ReadonlySet<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  directions: ReadonlyMap<string, DirectionDto>;
  setDirections: React.Dispatch<React.SetStateAction<Map<string, DirectionDto>>>;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const hosts = data.proposal.hosts;
  // A hub-joined board sends hosts: the hub offers its own wildcards and the admin picks the direction there.
  const wildcards = data.hubManaged ? [] : data.proposal.wildcards ?? [];
  const [done, setDone] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const picked = hosts.map(h => h.host).filter(h => selected.has(h));
  const pickedWildcards = wildcards.map(w => w.pattern).filter(p => selected.has(p));
  const directionOf = (pattern: string, uploads: number) => directions.get(pattern) ?? seenDirection(uploads);
  const setDirection = (pattern: string) => (d: DirectionDto) => setDirections(m => new Map(m).set(pattern, d));
  const entries = [
    ...hosts.filter(h => selected.has(h.host)).map(h => ({ pattern: h.host, direction: directionOf(h.host, h.uploads) })),
    ...wildcards.filter(w => selected.has(w.pattern)).map(w => ({ pattern: w.pattern, direction: directionOf(w.pattern, w.uploads) })),
  ];
  const count = picked.length + pickedWildcards.length;

  const act = useMutation({
    mutationFn: async () => (data.hubManaged
      ? `Sent ${plural((await learningApi.forward({ hosts: picked })).forwarded, 'host')} to your hub for an org admin.`
      : `Allowed ${plural(entries.length, 'entry', 'entries')} (revision ${(await learningApi.accept({ entries, expectedRevision: data.revision })).revision}).`),
    onMutate: () => { setDone(null); setProblem(null); },
    onSuccess: text => {
      setDone(text);
      void queryClient.invalidateQueries({ queryKey: ['airlock-policy'] });
      if (!data.hubManaged) void queryClient.invalidateQueries({ queryKey: ['airlock-learning'] });
    },
    onError: e => setProblem(messageOf(e, data.hubManaged ? 'Could not send the proposal to the hub.' : 'Could not allow the hosts; the policy was not changed.')),
  });

  const toggle = (pattern: string) => setSelected(s => {
    const next = new Set(s);
    if (next.has(pattern)) next.delete(pattern); else next.add(pattern);
    return next;
  });

  const excluded = data.proposal.excluded;
  return (
    <>
      {hosts.length === 0 ? (
        <p className="mt-2 text-[12px] text-ink-tertiary">No hosts to propose yet: every host sessions reached is already on a list, or none was seen.</p>
      ) : (
        <ul className="mt-2 space-y-1.5" aria-label="Proposed hosts">
          {hosts.map(h => (
            <li key={h.host} className="flex items-start gap-2 text-[12px]">
              <input type="checkbox" className="mt-0.5" aria-label={h.host} checked={selected.has(h.host)} onChange={() => toggle(h.host)} />
              <div className="min-w-0">
                <code className="break-all font-mono text-ink">{h.host}</code>
                <p className="text-ink-tertiary">
                  {`${plural(h.hits, 'hit')} · ${h.clients.join(', ') || 'unknown client'}${h.cards.length ? ` · ${plural(h.cards.length, 'card')}` : ''} · ${day(h.firstSeen)} – ${day(h.lastSeen)} · `}
                  <span className={clsx(h.evidence === 'proxy' ? 'text-status-ok-text' : 'text-status-warn-text')}>
                    {h.evidence === 'proxy' ? 'seen by the sandbox proxy' : 'agent-reported (tool calls or imported logs)'}
                  </span>
                  {` · `}
                  <span className={clsx((h.uploads ?? 0) > 0 && 'text-status-warn-text')}>{sentData(h.uploads ?? 0)}</span>
                </p>
                <HostContext labels={h.labels} context={h.context} />
              </div>
              {!data.hubManaged && <DirectionPicker pattern={h.host} value={directionOf(h.host, h.uploads ?? 0)} onChange={setDirection(h.host)} />}
            </li>
          ))}
        </ul>
      )}
      {wildcards.length > 0 && (
        <>
          <h4 className={clsx(SUBHEAD, 'mt-3')}>Wildcards</h4>
          <p className={HELP}>Hosts sharing a domain, as one entry. Never offered over shared hosting, tunnels or object storage.</p>
          <ul className="mt-2 space-y-1.5" aria-label="Proposed wildcards">
            {wildcards.map(w => (
              <li key={w.pattern} className="flex items-start gap-2 text-[12px]">
                <input type="checkbox" className="mt-0.5" aria-label={w.pattern} checked={selected.has(w.pattern)} onChange={() => toggle(w.pattern)} />
                <div className="min-w-0">
                  <code className="break-all font-mono text-ink">{w.pattern}</code>
                  <p className="text-ink-tertiary">
                    {`covers ${w.hosts.join(', ')} · ${plural(w.hits, 'hit')} · `}
                    <span className={clsx(w.uploads > 0 && 'text-status-warn-text')}>{sentData(w.uploads)}</span>
                  </p>
                </div>
                <DirectionPicker pattern={w.pattern} value={directionOf(w.pattern, w.uploads)} onChange={setDirection(w.pattern)} />
              </li>
            ))}
          </ul>
        </>
      )}
      {excluded.length > 0 && (
        <details className="mt-2 text-[12px] text-ink-tertiary">
          <summary>{`${plural(excluded.length, 'host')} left out`}</summary>
          <ul className="mt-1 space-y-0.5">
            {excluded.map(x => <li key={x.host}><code className="font-mono">{x.host}</code>{` · ${REASONS[x.reason] ?? x.reason}`}</li>)}
          </ul>
        </details>
      )}
      {hosts.length > 0 && (
        <div className="mt-3">
          {data.hubManaged && (
            <p className={HELP}>Your organization&apos;s hub owns this policy, so nothing is allowed here: an org admin accepts the hosts on the hub.</p>
          )}
          <button type="button" className={clsx(SECONDARY_BUTTON, 'mr-2 mt-2')} onClick={() => setSelected(new Set(hosts.map(h => h.host)))}>Select all</button>
          <button type="button" className={clsx(PRIMARY_BUTTON, 'mt-2')} disabled={count === 0 || act.isPending} onClick={() => act.mutate()}>
            {data.hubManaged
              ? `Send ${plural(picked.length, 'selected host')} to the hub`
              : pickedWildcards.length ? `Allow ${count} selected` : `Allow ${plural(picked.length, 'selected host')}`}
          </button>
        </div>
      )}
      {problem && (
        <div role="alert" className="mt-2 rounded-lg border border-status-danger-text/40 bg-status-danger-bg px-3 py-2 text-[12px] text-status-danger-text">{problem}</div>
      )}
      {done && !problem && <p role="status" className="mt-2 text-[12px] text-status-ok-text">{done}</p>}
    </>
  );
}

export function AirlockLearning(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  // Here, not in Proposal: it outlives a refresh of the list, and is kept by host.
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  // Directions the person picked, by host or wildcard; the rest start at what was seen.
  const [directions, setDirections] = React.useState<Map<string, DirectionDto>>(() => new Map());
  const queryClient = useQueryClient();
  const learning = useQuery({ queryKey: ['airlock-learning'], queryFn: learningApi.get, enabled: open });
  useSocketEvent('airlock_learning_changed', () => { if (open) void queryClient.invalidateQueries({ queryKey: ['airlock-learning'] }); });

  return (
    <div className={BLOCK} data-testid="airlock-learning">
      <h3 className={SUBHEAD}>Learning</h3>
      <p className={HELP}>
        Hosts sessions reached that no list names, from the sandbox proxy, tool calls and imported pi logs
        (<code className="font-mono">agenfk airlock learn --import-pi-sessions</code>). Nothing is allowed until a person accepts it.
      </p>
      {!open ? (
        <button type="button" className={clsx(SECONDARY_BUTTON, 'mt-2')} onClick={() => setOpen(true)}>Review the proposed allowlist</button>
      ) : (
        <>
          {learning.isPending && <p role="status" className="mt-2 text-[12px] text-ink-tertiary">Loading the proposal…</p>}
          {learning.isError && <p className="mt-2 text-[12px] text-status-warn-text">Could not read the proposal.</p>}
          {learning.data && <Proposal data={learning.data} selected={selected} setSelected={setSelected} directions={directions} setDirections={setDirections} />}
        </>
      )}
    </div>
  );
}
