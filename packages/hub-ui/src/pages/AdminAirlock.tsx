import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { apiErrorText } from '../apiError';
import { Callout, QueryError, buttonClass, cardClass, controlClass } from '../components/ui';
import { AirlockLearningCard } from './AdminAirlockLearning';

/**
 * Admin → Airlock (GH-294). The org's Airlock policy: what a coding agent's
 * tool calls may reach, and which sessions it applies to. Every installation
 * joined to this hub adopts it on its next sync and cannot overrule it.
 *
 * The policy and the IOC host list are saved separately: the list changes more
 * often, and saving it does not make a new policy revision.
 *
 * Below them (HUB-2): each installation with the revision it last reported
 * applying, those behind the current one highlighted and named as such, and
 * the policy's revision history from the config audit.
 *
 * Last (HUB-1): the org's recent denials and alerts, newest first and a page
 * at a time, filterable by client, installation, source, alert and mode. One
 * made in observe mode is named as what enforce would have done; one that
 * raised an alert is highlighted with its category.
 */

type Mode = 'off' | 'observe' | 'enforce';
type RuleAction = 'deny' | 'needs-human-approval' | 'off';
type RuleKey = 'uploadToUnlistedHost' | 'credentialReadWithNetwork' | 'namespaceEscape' | 'cloudMutation';
interface ModelSelector { client?: string; provider?: string; model?: string }

interface AirlockPolicy {
  schemaVersion: 1;
  mode: Mode;
  models: ModelSelector[];
  appliesWhenModelUnknown: boolean;
  hosts: { allow: string[]; deny: string[] };
  iocHosts: { revision: string; hosts: string[]; updatedAt: string | null };
  rules: Record<RuleKey, RuleAction>;
}

export interface AirlockView {
  policy: AirlockPolicy | null;
  revision: number;
  iocRevision: number;
  updatedAt: string | null;
  updatedByEmail: string | null;
}

export interface AirlockInstallation {
  installationId: string;
  osUser: string | null;
  gitName: string | null;
  gitEmail: string | null;
  lastSeen: string | null;
  appliedRevision: number | null;
  appliedIocRevision: number | null;
  appliedAt: string | null;
  reportedAt: string | null;
  refusedRevision: number | null;
  refusedIocRevision: number | null;
  refusedError: string | null;
  refusedAt: string | null;
  behind: boolean;
}

interface AirlockInstallations { currentRevision: number; currentIocRevision: number; installations: AirlockInstallation[] }

interface Revisions { revision: number; iocRevision: number }
interface AirlockHistoryEntry {
  id: string;
  at: string;
  actorEmail: string | null;
  source: string;
  action: string;
  before: Revisions | null;
  after: Revisions | null;
}

type AirlockAlert = 'cloud-storage' | 'metadata-endpoint' | 'ioc-host';

export interface AirlockDecision {
  eventId: string;
  at: string;
  installationId: string;
  userKey: string;
  client: string | null;
  model: string | null;
  tool: string | null;
  capabilityKind: string | null;
  target: string | null;
  decision: 'allow' | 'deny' | 'needs-human-approval';
  rule: string | null;
  mode: Mode | null;
  source: 'tool' | 'proxy';
  alert: AirlockAlert | null;
  itemId: string | null;
  revision: number | null;
  policySource: 'hub' | 'local' | null;
}

const MODES: { value: Mode; label: string; help: string }[] = [
  { value: 'off', label: 'Off', help: 'Nothing is checked.' },
  { value: 'observe', label: 'Observe', help: 'Every tool call is allowed; what Enforce would have stopped is logged.' },
  { value: 'enforce', label: 'Enforce', help: 'Tool calls the rules deny are blocked.' },
];

const RULES: { key: RuleKey; label: string }[] = [
  { key: 'uploadToUnlistedHost', label: 'Upload to a host not on the allowed list' },
  { key: 'credentialReadWithNetwork', label: 'Read a credential and use the network in one command' },
  { key: 'namespaceEscape', label: 'Enter another namespace (unshare, nsenter)' },
  { key: 'cloudMutation', label: 'Change cloud resources (aws, gcloud, az, kubectl, terraform, pulumi)' },
];

const ACTIONS: { value: RuleAction; label: string }[] = [
  { value: 'deny', label: 'Deny' },
  { value: 'needs-human-approval', label: 'Needs a person to approve' },
  { value: 'off', label: 'Allow' },
];

const DEFAULT_RULES: Record<RuleKey, RuleAction> = {
  uploadToUnlistedHost: 'deny',
  credentialReadWithNetwork: 'deny',
  namespaceEscape: 'deny',
  cloudMutation: 'needs-human-approval',
};

/** One entry per line; blank lines and surrounding spaces dropped. */
export const linesOf = (text: string): string[] => text.split('\n').map(l => l.trim()).filter(Boolean);

/** A model selector as one line: `client provider model`, `*` for any. */
export function selectorLine(s: ModelSelector): string {
  const parts = [s.client ?? '*', s.provider ?? '*', s.model ?? '*'];
  while (parts.length > 1 && parts[parts.length - 1] === '*') parts.pop();
  return parts.join(' ');
}

export function parseSelector(line: string): ModelSelector {
  const [client, provider, model] = line.split(/\s+/);
  const out: ModelSelector = {};
  if (client && client !== '*') out.client = client;
  if (provider && provider !== '*') out.provider = provider;
  if (model && model !== '*') out.model = model;
  return out;
}

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function SaveError({ error }: { error: unknown }) {
  const errors: unknown = (error as any)?.response?.data?.errors;
  return (
    <Callout tone="danger" live="assertive" className="mt-3">
      {apiErrorText(error)}
      {Array.isArray(errors) && errors.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {errors.map((e, i) => <li key={i}>{String(e)}</li>)}
        </ul>
      )}
    </Callout>
  );
}

const useAirlock = () => useQuery<AirlockView>({
  queryKey: ['admin-airlock'],
  queryFn: async () => (await api.get('/v1/admin/airlock')).data as AirlockView,
});

const useInstallations = () => useQuery<AirlockInstallations>({
  queryKey: ['admin-airlock-installations'],
  queryFn: async () => (await api.get('/v1/admin/airlock/installations')).data as AirlockInstallations,
});

interface HistoryPage { entries: AirlockHistoryEntry[]; next: string | null }

/** Newest first, a page at a time: `next` is the hub's cursor past the page's last entry. */
const useHistory = () => useInfiniteQuery<HistoryPage, Error, { pages: HistoryPage[] }, unknown[], string | null>({
  queryKey: ['admin-airlock-history'],
  initialPageParam: null,
  queryFn: async ({ pageParam }) =>
    (await api.get('/v1/admin/airlock/history', { params: pageParam ? { cursor: pageParam } : {} })).data as HistoryPage,
  getNextPageParam: last => last.next ?? null,
});

interface DecisionsPage { decisions: AirlockDecision[]; next: string | null }

/** The hub's filters, as chosen; an empty value is not sent. */
interface DecisionFilters { client: string; installation: string; source: string; alert: string; mode: string }
const NO_FILTERS: DecisionFilters = { client: '', installation: '', source: '', alert: '', mode: '' };

const useDecisions = (filters: DecisionFilters) => useInfiniteQuery<DecisionsPage, Error, { pages: DecisionsPage[] }, unknown[], string | null>({
  queryKey: ['admin-airlock-decisions', filters],
  initialPageParam: null,
  queryFn: async ({ pageParam }) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
    if (pageParam) params.cursor = pageParam;
    return (await api.get('/v1/admin/airlock/decisions', { params })).data as DecisionsPage;
  },
  getNextPageParam: last => last.next ?? null,
});

/** A save moves the revision: the installations' standing and the history move with it. */
const invalidateAll = (qc: ReturnType<typeof useQueryClient>) => {
  for (const key of ['admin-airlock', 'admin-airlock-installations', 'admin-airlock-history']) {
    qc.invalidateQueries({ queryKey: [key] });
  }
};

export function AdminAirlock() {
  const airlock = useAirlock();
  if (airlock.isError && !airlock.data) return <QueryError error={airlock.error} onRetry={() => airlock.refetch()} />;
  if (!airlock.data) return <p role="status" className="text-body text-ink-tertiary">Loading…</p>;
  const view = airlock.data;
  return (
    <div className="space-y-4">
      {/* Keyed by revision: a save reloads the form from what the hub stored. */}
      <PolicyCard key={`policy-${view.revision}`} view={view} />
      <IocCard key={`ioc-${view.iocRevision}`} view={view} />
      <InstallationsCard />
      <HistoryCard />
      <DecisionsCard />
      <AirlockLearningCard />
    </div>
  );
}

function PolicyCard({ view }: { view: AirlockView }) {
  const qc = useQueryClient();
  const p = view.policy;
  const [mode, setMode] = useState<Mode>(p?.mode ?? 'off');
  const [models, setModels] = useState((p?.models ?? []).map(selectorLine).join('\n'));
  const [unknown, setUnknown] = useState(p?.appliesWhenModelUnknown ?? true);
  const [allow, setAllow] = useState((p?.hosts.allow ?? []).join('\n'));
  const [deny, setDeny] = useState((p?.hosts.deny ?? []).join('\n'));
  const [rules, setRules] = useState<Record<RuleKey, RuleAction>>({ ...DEFAULT_RULES, ...(p?.rules ?? {}) });

  const save = useMutation({
    mutationFn: async () => (await api.put('/v1/admin/airlock', {
      expectedRevision: view.revision,
      policy: {
        schemaVersion: 1,
        mode,
        models: linesOf(models).map(parseSelector),
        appliesWhenModelUnknown: unknown,
        hosts: { allow: linesOf(allow), deny: linesOf(deny) },
        rules,
      },
    })).data as AirlockView,
    onSuccess: () => invalidateAll(qc),
  });
  const edit = <T,>(set: (v: T) => void) => (v: T) => { save.reset(); set(v); };

  return (
    <form className={`${cardClass} max-w-form`} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3 className="text-body font-semibold text-ink">Airlock policy</h3>
      {p ? (
        <p className="mt-1 text-small text-ink-tertiary">
          Revision {view.revision}{view.updatedByEmail ? `, saved by ${view.updatedByEmail}` : ''}
          {view.updatedAt ? ` on ${utc(view.updatedAt)}` : ''}. Every installation joined to this hub adopts it and cannot
          change it locally.
        </p>
      ) : (
        <p className="mt-1 text-small text-ink-tertiary">
          No Airlock policy yet: each installation keeps its own. Saving one here makes it the policy of every installation
          joined to this hub.
        </p>
      )}

      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Mode</span>
        <select aria-label="Mode" className={`${controlClass} mt-1.5`} value={mode} onChange={(e) => edit(setMode)(e.target.value as Mode)}>
          {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      <p className="mt-1 text-small text-ink-tertiary">{MODES.find(m => m.value === mode)?.help}</p>

      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Models</span>
        <textarea
          aria-label="Models" rows={3} className={`${controlClass} mt-1.5 font-mono`}
          value={models} onChange={(e) => edit(setModels)(e.target.value)}
          placeholder="pi cloudflare-workers-ai"
        />
      </label>
      <p className="mt-1 text-small text-ink-tertiary">
        One per line: client (pi, opencode or *), then provider, then model; leave out what does not matter. Empty means
        every session.
      </p>
      <label className="mt-2 flex items-center gap-2 text-body text-ink">
        <input type="checkbox" checked={unknown} onChange={(e) => edit(setUnknown)(e.target.checked)} />
        Apply when a session's model cannot be told
      </label>

      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Allowed hosts</span>
        <textarea aria-label="Allowed hosts" rows={4} className={`${controlClass} mt-1.5 font-mono`} value={allow} onChange={(e) => edit(setAllow)(e.target.value)} />
      </label>
      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Denied hosts</span>
        <textarea aria-label="Denied hosts" rows={3} className={`${controlClass} mt-1.5 font-mono`} value={deny} onChange={(e) => edit(setDeny)(e.target.value)} />
      </label>
      <p className="mt-1 text-small text-ink-tertiary">
        One host per line: a name, *.wildcard or a CIDR range. Cloud metadata endpoints are always denied and cannot be
        allowed.
      </p>

      <fieldset className="mt-3 space-y-2">
        <legend className="eyebrow text-ink-tertiary">Rules</legend>
        {RULES.map(r => (
          <label key={r.key} className="flex items-center justify-between gap-3 text-body text-ink">
            <span>{r.label}</span>
            <select
              aria-label={r.label} className={`${controlClass} max-w-[16rem]`} value={rules[r.key]}
              onChange={(e) => edit(setRules)({ ...rules, [r.key]: e.target.value as RuleAction })}
            >
              {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
        ))}
      </fieldset>

      <div className="mt-3">
        <button type="submit" className={buttonClass('primary')} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save policy'}
        </button>
      </div>
      {save.isError && <SaveError error={save.error} />}
    </form>
  );
}

function IocCard({ view }: { view: AirlockView }) {
  const qc = useQueryClient();
  const [hosts, setHosts] = useState((view.policy?.iocHosts.hosts ?? []).join('\n'));
  const save = useMutation({
    mutationFn: async () => (await api.put('/v1/admin/airlock/ioc', { hosts: linesOf(hosts) })).data as AirlockView,
    onSuccess: () => invalidateAll(qc),
  });
  return (
    <form className={`${cardClass} max-w-form`} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3 className="text-body font-semibold text-ink">Indicators of compromise</h3>
      {!view.policy ? (
        <p className="mt-1 text-small text-ink-tertiary">Save a policy first: the IOC host list is part of it.</p>
      ) : (
        <>
          <p className="mt-1 text-small text-ink-tertiary">
            Hosts known to be malicious, denied whatever else the policy allows. Saving the list does not make a new policy
            revision; installations still pick it up on their next sync.
          </p>
          <label className="block mt-3">
            <span className="eyebrow text-ink-tertiary">IOC hosts</span>
            <textarea
              aria-label="IOC hosts" rows={4} className={`${controlClass} mt-1.5 font-mono`}
              value={hosts} onChange={(e) => { save.reset(); setHosts(e.target.value); }}
            />
          </label>
          <div className="mt-3">
            <button type="submit" className={buttonClass('primary')} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save IOC list'}
            </button>
          </div>
          {save.isError && <SaveError error={save.error} />}
        </>
      )}
    </form>
  );
}

const whoOf = (i: AirlockInstallation) => i.gitEmail ?? i.gitName ?? i.osUser ?? i.installationId;

/** What an installation applies, in words; the revision alone when it has the IOC list too. */
function standingOf(i: AirlockInstallation, current: AirlockInstallations): { text: string; tone: string } {
  if (current.currentRevision === 0) return { text: 'No hub policy', tone: 'text-ink-tertiary' };
  if (i.appliedRevision === null) return { text: 'Behind: not reported yet', tone: 'text-status-warn-text' };
  if (!i.behind) return { text: 'Up to date', tone: 'text-status-ok-text' };
  return i.appliedRevision < current.currentRevision
    ? { text: `Behind: revision ${i.appliedRevision} of ${current.currentRevision}`, tone: 'text-status-warn-text' }
    : { text: 'Behind: older IOC list', tone: 'text-status-warn-text' };
}

function InstallationsCard() {
  const q = useInstallations();
  return (
    <section className={cardClass}>
      <h3 className="text-body font-semibold text-ink">Installations</h3>
      {q.isError && !q.data ? <QueryError error={q.error} onRetry={() => q.refetch()} /> : !q.data ? (
        <p role="status" className="mt-1 text-small text-ink-tertiary">Loading…</p>
      ) : q.data.installations.length === 0 ? (
        <p className="mt-1 text-small text-ink-tertiary">No installation has joined this hub yet.</p>
      ) : (
        <>
          <p className="mt-1 text-small text-ink-tertiary">
            {q.data.currentRevision > 0
              ? `Current revision ${q.data.currentRevision}. `
              : 'No hub policy yet. '}
            Each installation reports the revision it applies after its sync; one behind is highlighted.
          </p>
          <div className="mt-3 -mx-5 relative overflow-x-auto">
            <table aria-label="Installations" className="w-full text-body">
              <thead>
                <tr className="eyebrow text-ink-tertiary">
                  <th className="text-left px-5 py-2">Installation</th>
                  <th className="text-left px-2 py-2">Applied</th>
                  <th className="text-left px-2 py-2">Since</th>
                  <th className="text-left px-2 py-2">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-soft">
                {q.data.installations.map(i => {
                  const standing = standingOf(i, q.data!);
                  return (
                    <tr key={i.installationId} data-behind={i.behind ? 'true' : 'false'} className={i.behind ? 'bg-status-warn-bg' : undefined}>
                      <td className="px-5 py-2.5">
                        <div className="text-small text-ink">{whoOf(i)}</div>
                        <div className="font-mono text-caption text-ink-tertiary">{i.installationId}</div>
                      </td>
                      <td className="px-2 py-2.5 text-small text-ink-secondary">
                        {i.appliedRevision === null ? '—' : `Revision ${i.appliedRevision}`}
                      </td>
                      <td className="px-2 py-2.5 text-small text-ink-secondary">{i.appliedAt ? utc(i.appliedAt) : '—'}</td>
                      <td className="px-2 py-2.5 text-small">
                        <span className={`font-semibold ${standing.tone}`}>{standing.text}</span>
                        {i.refusedError !== null && (
                          <div className="mt-0.5 text-caption text-status-danger-text">
                            Refused {i.refusedRevision === null ? 'the hub policy' : `revision ${i.refusedRevision}`}
                            {i.refusedIocRevision !== null ? ` with IOC list ${i.refusedIocRevision}` : ''}: {i.refusedError}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** One audit row as a revision change, in words. */
function changeOf(e: AirlockHistoryEntry): string {
  if (!e.after) return 'Policy removed';
  if (!e.before) return `First saved as revision ${e.after.revision}`;
  if (e.action === 'airlock.ioc') return `IOC list ${e.before.iocRevision} → ${e.after.iocRevision}`;
  return `Revision ${e.before.revision} → ${e.after.revision}`;
}

function HistoryCard() {
  const q = useHistory();
  const entries = q.data?.pages.flatMap(p => p.entries) ?? [];
  return (
    <section className={`${cardClass} max-w-form`}>
      <h3 className="text-body font-semibold text-ink">Revision history</h3>
      {q.isError && !q.data ? <QueryError error={q.error} onRetry={() => q.refetch()} /> : !q.data ? (
        <p role="status" className="mt-1 text-small text-ink-tertiary">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="mt-1 text-small text-ink-tertiary">No changes yet.</p>
      ) : (
        <>
          <ul aria-label="Revision history" className="mt-2 divide-y divide-border-soft">
            {entries.map(e => (
              <li key={e.id} className="py-2 text-small">
                <span className="text-ink">{changeOf(e)}</span>
                <span className="text-ink-tertiary">, by {e.actorEmail ?? e.source} on {utc(e.at)}</span>
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <div className="mt-2">
              <button type="button" className={buttonClass('secondary')} disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const ALERTS: { value: AirlockAlert; label: string }[] = [
  { value: 'cloud-storage', label: 'Cloud storage' },
  { value: 'metadata-endpoint', label: 'Metadata endpoint' },
  { value: 'ioc-host', label: 'IOC host' },
];
const alertLabel = (a: AirlockAlert) => ALERTS.find(x => x.value === a)?.label ?? a;

/** The verdict in words; in observe mode, what enforce would have done. */
function verdictOf(d: AirlockDecision): string {
  const observe = d.mode === 'observe';
  if (d.decision === 'deny') return observe ? 'Observe: would deny' : 'Denied';
  if (d.decision === 'needs-human-approval') return observe ? 'Observe: would need approval' : 'Needs approval';
  return 'Allowed';
}

function DecisionFilter({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <label className="block">
      <span className="eyebrow text-ink-tertiary">{label}</span>
      <select aria-label={label} className={`${controlClass} mt-1.5`} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function DecisionsCard() {
  const [filters, setFilters] = useState<DecisionFilters>(NO_FILTERS);
  const q = useDecisions(filters);
  const installations = useInstallations();
  const decisions = q.data?.pages.flatMap(p => p.decisions) ?? [];
  const filtered = Object.values(filters).some(Boolean);
  const set = (key: keyof DecisionFilters) => (v: string) => setFilters(f => ({ ...f, [key]: v }));
  return (
    <section className={cardClass}>
      <h3 className="text-body font-semibold text-ink">Recent denials</h3>
      <p className="mt-1 text-small text-ink-tertiary">
        What Airlock stopped or held for approval across the org, newest first, and every call that raised an alert.
        In observe mode nothing is stopped; what enforce would have done is listed.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <DecisionFilter label="Client" value={filters.client} onChange={set('client')} options={[
          { value: '', label: 'Any' }, { value: 'pi', label: 'pi' }, { value: 'opencode', label: 'opencode' },
        ]} />
        <DecisionFilter label="Installation" value={filters.installation} onChange={set('installation')} options={[
          { value: '', label: 'Any' },
          ...(installations.data?.installations ?? []).map(i => ({ value: i.installationId, label: whoOf(i) })),
        ]} />
        <DecisionFilter label="Source" value={filters.source} onChange={set('source')} options={[
          { value: '', label: 'Any' }, { value: 'tool', label: 'Tool call' }, { value: 'proxy', label: 'Sandbox proxy' },
        ]} />
        <DecisionFilter label="Alert" value={filters.alert} onChange={set('alert')} options={[
          { value: '', label: 'Any' }, { value: 'any', label: 'Alerts only' }, ...ALERTS,
        ]} />
        <DecisionFilter label="Policy mode" value={filters.mode} onChange={set('mode')} options={[
          { value: '', label: 'Any' }, { value: 'enforce', label: 'Enforce' }, { value: 'observe', label: 'Observe' },
        ]} />
      </div>
      {q.isError && !q.data ? <QueryError error={q.error} onRetry={() => q.refetch()} /> : !q.data ? (
        <p role="status" className="mt-3 text-small text-ink-tertiary">Loading…</p>
      ) : decisions.length === 0 ? (
        <p className="mt-3 text-small text-ink-tertiary">
          {filtered ? 'No denials or alerts match these filters.' : 'No denials or alerts yet.'}
        </p>
      ) : (
        <>
          <div className="mt-3 -mx-5 relative overflow-x-auto">
            <table aria-label="Recent denials" className="w-full text-body">
              <thead>
                <tr className="eyebrow text-ink-tertiary">
                  <th className="text-left px-5 py-2">When</th>
                  <th className="text-left px-2 py-2">Who</th>
                  <th className="text-left px-2 py-2">Client</th>
                  <th className="text-left px-2 py-2">What</th>
                  <th className="text-left px-2 py-2">Verdict</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-soft">
                {decisions.map(d => (
                  <tr key={d.eventId} data-alert={d.alert ?? undefined} className={d.alert ? 'bg-status-danger-bg' : undefined}>
                    <td className="px-5 py-2.5 text-small text-ink-secondary whitespace-nowrap">{utc(d.at)}</td>
                    <td className="px-2 py-2.5">
                      <div className="text-small text-ink">{d.userKey}</div>
                      <div className="font-mono text-caption text-ink-tertiary">{d.installationId}</div>
                    </td>
                    <td className="px-2 py-2.5 text-small text-ink-secondary">
                      <div>{d.client ?? '—'}</div>
                      <div className="text-caption text-ink-tertiary">{d.source === 'proxy' ? 'sandbox proxy' : 'tool call'}</div>
                    </td>
                    <td className="px-2 py-2.5 text-small">
                      <div className="text-ink-secondary">{d.tool ?? '—'}</div>
                      <div className="font-mono text-caption text-ink break-all">{d.target ?? '—'}</div>
                    </td>
                    <td className="px-2 py-2.5 text-small">
                      <span className={`font-semibold ${d.decision === 'allow' ? 'text-ink-secondary' : 'text-status-danger-text'}`}>{verdictOf(d)}</span>
                      {d.rule && <div className="font-mono text-caption text-ink-tertiary">{d.rule}</div>}
                      {d.alert && <div className="mt-0.5 text-caption font-semibold text-status-danger-text">Alert: {alertLabel(d.alert)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {q.hasNextPage && (
            <div className="mt-2">
              <button type="button" className={buttonClass('secondary')} disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
