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
 * Per-project overrides (PO-2) have their own card and are saved as part of the
 * policy, its next revision: the stored policy goes back with them, `{}` when
 * the last is removed (a save that leaves `projects` out keeps them, so the
 * policy card cannot wipe them). The org's known repositories are offered as keys.
 *
 * Below them (HUB-2): each installation with the revision it last reported
 * applying, those behind the current one highlighted and named as such, and
 * the policy's revision history from the config audit.
 *
 * The dataset (DS-2): an org-wide switch, off by default, for capturing full
 * tool-call rows (secrets removed by the installation) to train the scorer;
 * what it holds; and its JSONL download (Clef records), admin only.
 *
 * Last (HUB-1): the org's recent denials and alerts, newest first and a page
 * at a time, filterable by client, installation, source, alert and mode. One
 * made in observe mode is named as what enforce would have done; one that
 * raised an alert is highlighted with its category.
 */

type Mode = 'off' | 'observe' | 'enforce';
type RuleAction = 'deny' | 'needs-human-approval' | 'off';
type RuleKey = 'uploadToUnlistedHost' | 'credentialReadWithNetwork' | 'namespaceEscape' | 'cloudMutation' | 'publishThroughAllowedHost';
interface ModelSelector { client?: string; provider?: string; model?: string }

interface AirlockPolicy {
  schemaVersion: 1;
  mode: Mode;
  models: ModelSelector[];
  appliesWhenModelUnknown: boolean;
  hosts: { allow: string[]; deny: string[] };
  iocHosts: { revision: string; hosts: string[]; updatedAt: string | null };
  rules: Record<RuleKey, RuleAction>;
  projects?: Record<string, ProjectOverride>;
  machineImage?: string;
  homeAccess?: 'home-read-only' | 'home-read-write';
}

type HomeAccess = 'protect-credentials' | 'home-read-only' | 'home-read-write';
const HOME_ACCESS: Array<{ value: HomeAccess; label: string }> = [
  { value: 'protect-credentials', label: 'Protect credentials' },
  { value: 'home-read-only', label: 'Home folder, read-only' },
  { value: 'home-read-write', label: 'Home folder, read-write' },
];

/** Adds to the policy's host lists; each rule it sets wins over the org's. */
interface ProjectOverride {
  hosts?: { allow: string[]; deny: string[] };
  rules?: Partial<Record<RuleKey, RuleAction>>;
  machineImage?: string;
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
  { key: 'publishThroughAllowedHost', label: 'Publish through an allowed host (gists, issue bodies from files, npm, Hugging Face, PyPI, image pushes)' },
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
  publishThroughAllowedHost: 'needs-human-approval',
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
      {/* Not keyed by revision: a card keeps unsaved edits when the other one saves (useRevisionDraft). */}
      <PolicyCard view={view} />
      <ProjectOverridesCard view={view} />
      <IocCard key={`ioc-${view.iocRevision}`} view={view} />
      <DatasetCard />
      <InstallationsCard />
      <HistoryCard />
      <DecisionsCard />
      <AirlockLearningCard />
    </div>
  );
}

/**
 * A card's draft against the revision it was made from. A newer revision (the
 * other card's save, another admin) is adopted whenever the draft has no unsaved
 * edits - checked on every render, so edits put back as they were adopt it too;
 * otherwise the card says so and offers to discard them or keep them and save over
 * the new revision. An older revision never replaces the draft's: a card's own save
 * adopts what the hub returned (and puts it in the query cache) before any reload.
 */
function useRevisionDraft<T>(view: AirlockView, init: (v: AirlockView) => T) {
  const [base, setBase] = useState(view);
  const [draft, setDraft] = useState<T>(() => init(view));
  const dirty = JSON.stringify(draft) !== JSON.stringify(init(base));
  if (view.revision > base.revision && !dirty) {
    setBase(view);
    setDraft(init(view));
  }
  const adopt = (v: AirlockView) => { setBase(v); setDraft(init(v)); };
  return {
    base, draft, setDraft, adopt,
    stale: dirty && view.revision > base.revision,
    keep: () => setBase(view),
  };
}

/**
 * A save's answer goes into the cache before anything reloads it - unless a newer
 * revision got there first (another admin's, while the answer was on its way). The
 * card adopts what it saved either way; with no unsaved edits it then moves on to
 * that newer revision itself.
 */
const onSaved = (qc: ReturnType<typeof useQueryClient>, adopt: (v: AirlockView) => void) => (v: AirlockView) => {
  const cached = qc.getQueryData<AirlockView>(['admin-airlock']);
  if (!cached || cached.revision < v.revision) qc.setQueryData(['admin-airlock'], v);
  adopt(v);
  invalidateAll(qc);
};

function ChangedElsewhere({ view, base, onDiscard, onKeep }: { view: AirlockView; base: AirlockView; onDiscard: () => void; onKeep: () => void }) {
  return (
    <Callout tone="warn" className="mt-3">
      {`The policy changed elsewhere (it is now at revision ${view.revision}); your unsaved edits are against revision ${base.revision}, so saving them as they are will be refused.`}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={buttonClass('secondary')} onClick={onDiscard}>{`Discard my edits and load revision ${view.revision}`}</button>
        <button type="button" className={buttonClass('secondary')} onClick={onKeep}>{`Keep my edits and save them over revision ${view.revision}`}</button>
      </div>
    </Callout>
  );
}

interface PolicyDraft {
  mode: Mode;
  models: string;
  unknown: boolean;
  allow: string;
  deny: string;
  rules: Record<RuleKey, RuleAction>;
  image: string;
  home: HomeAccess;
}

const policyDraftOf = (v: AirlockView): PolicyDraft => ({
  mode: v.policy?.mode ?? 'off',
  models: (v.policy?.models ?? []).map(selectorLine).join('\n'),
  unknown: v.policy?.appliesWhenModelUnknown ?? true,
  allow: (v.policy?.hosts.allow ?? []).join('\n'),
  deny: (v.policy?.hosts.deny ?? []).join('\n'),
  rules: { ...DEFAULT_RULES, ...(v.policy?.rules ?? {}) },
  image: v.policy?.machineImage ?? '',
  home: v.policy?.homeAccess ?? 'protect-credentials',
});

function PolicyCard({ view }: { view: AirlockView }) {
  const qc = useQueryClient();
  const d = useRevisionDraft(view, policyDraftOf);
  const { mode, models, unknown, allow, deny, rules, image, home } = d.draft;
  const p = d.base.policy;

  const save = useMutation({
    // The overrides are the other card's: left out, the hub keeps them as stored.
    mutationFn: async () => (await api.put('/v1/admin/airlock', {
      expectedRevision: d.base.revision,
      policy: {
        schemaVersion: 1,
        mode,
        models: linesOf(models).map(parseSelector),
        appliesWhenModelUnknown: unknown,
        hosts: { allow: linesOf(allow), deny: linesOf(deny) },
        rules,
        ...(image.trim() ? { machineImage: image.trim() } : {}),
        ...(home !== 'protect-credentials' ? { homeAccess: home } : {}),
      },
    })).data as AirlockView,
    onSuccess: onSaved(qc, d.adopt),
  });
  const field = <K extends keyof PolicyDraft>(k: K) => (v: PolicyDraft[K]) => { save.reset(); d.setDraft(x => ({ ...x, [k]: v })); };
  const setMode = field('mode');
  const setModels = field('models');
  const setUnknown = field('unknown');
  const setAllow = field('allow');
  const setDeny = field('deny');
  const setRules = field('rules');
  const setImage = field('image');
  const setHome = field('home');

  return (
    <form className={`${cardClass} max-w-form`} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3 className="text-body font-semibold text-ink">Airlock policy</h3>
      {d.stale && <ChangedElsewhere view={view} base={d.base} onDiscard={() => d.adopt(view)} onKeep={d.keep} />}
      {p ? (
        <p className="mt-1 text-small text-ink-tertiary">
          Revision {d.base.revision}{d.base.updatedByEmail ? `, saved by ${d.base.updatedByEmail}` : ''}
          {d.base.updatedAt ? ` on ${utc(d.base.updatedAt)}` : ''}. Every installation joined to this hub adopts it and cannot
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
        <select aria-label="Mode" className={`${controlClass} mt-1.5`} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      <p className="mt-1 text-small text-ink-tertiary">{MODES.find(m => m.value === mode)?.help}</p>

      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Models</span>
        <textarea
          aria-label="Models" rows={3} className={`${controlClass} mt-1.5 font-mono`}
          value={models} onChange={(e) => setModels(e.target.value)}
          placeholder="pi cloudflare-workers-ai"
        />
      </label>
      <p className="mt-1 text-small text-ink-tertiary">
        One per line: client (pi, opencode or *), then provider, then model; leave out what does not matter. Empty means
        every session.
      </p>
      <label className="mt-2 flex items-center gap-2 text-body text-ink">
        <input type="checkbox" checked={unknown} onChange={(e) => setUnknown(e.target.checked)} />
        Apply when a session's model cannot be told
      </label>

      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Allowed hosts</span>
        <textarea aria-label="Allowed hosts" rows={4} className={`${controlClass} mt-1.5 font-mono`} value={allow} onChange={(e) => setAllow(e.target.value)} />
      </label>
      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Denied hosts</span>
        <textarea aria-label="Denied hosts" rows={3} className={`${controlClass} mt-1.5 font-mono`} value={deny} onChange={(e) => setDeny(e.target.value)} />
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
              onChange={(e) => setRules({ ...rules, [r.key]: e.target.value as RuleAction })}
            >
              {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
        ))}
      </fieldset>

      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Machine image</span>
        <input
          aria-label="Machine image" className={`${controlClass} mt-1.5 font-mono`} value={image}
          onChange={(e) => setImage(e.target.value)} placeholder="ghcr.io/cglab-public/agenfk-airlock-base:<version>"
        />
      </label>
      <p className="mt-1 text-small text-ink-tertiary">
        The image every Airlock session's machine is made from; each project override can name its own. Empty: the
        AgEnFK base image. Only this policy names an image, never a repository: the image is root in the machine.
      </p>

      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Home access</span>
        <select aria-label="Home access" className={`${controlClass} mt-1.5 max-w-[16rem]`} value={home} onChange={(e) => setHome(e.target.value as HomeAccess)}>
          {HOME_ACCESS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
        </select>
      </label>
      <p className="mt-1 text-small text-ink-tertiary">
        {home === 'protect-credentials'
          ? 'Every installation follows this; none can open more locally. A session\'s machine sees only its workspace and its agent\'s own state; the credential stores (~/.ssh, ~/.aws, logins in auth.json) stay unreadable.'
          : home === 'home-read-only'
            ? "Every installation follows this; none can open more locally. The whole home folder is mounted read-only: the agent can read your users' credentials (~/.ssh, ~/.aws, auth.json), and the network policy is what keeps them in. AgEnFK's own files stay unwritable and Airlock's records unreadable."
            : "Every installation follows this; none can open more locally. The whole home folder is mounted read-write: the agent can read your users' credentials (~/.ssh, ~/.aws, auth.json), and can change files programs on their machines run later (other projects' git hooks, tools' settings), so treat it as able to run code there. Nothing is held from it: only Airlock's own records stay hidden."}
      </p>

      <div className="mt-3">
        <button type="submit" className={buttonClass('primary')} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save policy'}
        </button>
      </div>
      {save.isError && <SaveError error={save.error} />}
    </form>
  );
}

interface OverrideDraft { key: string; allow: string; deny: string; rules: Partial<Record<RuleKey, RuleAction>>; image: string }

const overrideDraftsOf = (projects: Record<string, ProjectOverride> | undefined): OverrideDraft[] =>
  Object.entries(projects ?? {}).map(([key, o]) => ({
    key, allow: (o.hosts?.allow ?? []).join('\n'), deny: (o.hosts?.deny ?? []).join('\n'), rules: { ...o.rules }, image: o.machineImage ?? '',
  }));

/** The drafts as the policy holds them: hosts only when there are some, only the rules set, an image when named. */
export function projectsOf(drafts: OverrideDraft[]): Record<string, ProjectOverride> {
  const out: Record<string, ProjectOverride> = {};
  for (const d of drafts) {
    const allow = linesOf(d.allow);
    const deny = linesOf(d.deny);
    const rules = { ...d.rules };
    const image = d.image.trim();
    out[d.key.trim()] = {
      ...(allow.length || deny.length ? { hosts: { allow, deny } } : {}),
      ...(Object.keys(rules).length ? { rules } : {}),
      ...(image ? { machineImage: image } : {}),
    };
  }
  return out;
}

/** The repositories this org's installations reported (their git remotes), for the key's suggestions. */
const useKnownRepos = () => useQuery<{ remoteUrl: string }[]>({
  queryKey: ['admin-projects'],
  queryFn: async () => (await api.get('/v1/admin/projects')).data as { remoteUrl: string }[],
});

/** Why the drafts cannot be saved as they are (two naming one key would collapse into one), or null. */
export function duplicateKeyProblem(keys: string[]): string | null {
  const first = new Map<string, number>();
  for (const [i, raw] of keys.entries()) {
    const k = raw.trim();
    const j = first.get(k);
    if (j !== undefined) return `Overrides ${j + 1} and ${i + 1} both name ${k}: merge them into one.`;
    first.set(k, i);
  }
  return null;
}

const overrideDraftsOfView = (v: AirlockView) => overrideDraftsOf(v.policy?.projects);

function ProjectOverridesCard({ view }: { view: AirlockView }) {
  const qc = useQueryClient();
  const repos = useKnownRepos();
  const d = useRevisionDraft(view, overrideDraftsOfView);
  const drafts = d.draft;
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const { iocHosts: _ioc, ...stored } = d.base.policy!;
      return (await api.put('/v1/admin/airlock', {
        expectedRevision: d.base.revision,
        policy: { ...stored, projects: projectsOf(drafts) },
      })).data as AirlockView;
    },
    onSuccess: onSaved(qc, d.adopt),
  });
  const submit = () => {
    const dup = duplicateKeyProblem(drafts.map(x => x.key));
    setProblem(dup);
    if (!dup) save.mutate();
  };
  const change = (next: OverrideDraft[]) => { save.reset(); setProblem(null); d.setDraft(next); };
  const edit = (i: number, patch: Partial<OverrideDraft>) => change(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const setRule = (i: number, k: RuleKey, v: string) => {
    const rules = { ...drafts[i].rules };
    if (v === '') delete rules[k]; else rules[k] = v as RuleAction;
    edit(i, { rules });
  };

  return (
    <form aria-label="Per-project overrides" className={`${cardClass} max-w-form`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h3 className="text-body font-semibold text-ink">Per-project overrides</h3>
      {d.stale && <ChangedElsewhere view={view} base={d.base} onDiscard={() => d.adopt(view)} onKeep={d.keep} />}
      {!view.policy ? (
        <p className="mt-1 text-small text-ink-tertiary">Overrides are part of the policy: save one first.</p>
      ) : (
        <>
          <p className="mt-1 text-small text-ink-tertiary">
            For one repository (host/owner/repo, a git remote, or owner/repo on GitHub) or one project of a standalone
            installation (project:&lt;id&gt;). Its hosts are added to the policy&apos;s lists, and a host the policy denies stays
            denied; each rule it sets replaces the org&apos;s, to loosen or tighten it. Saving makes a new policy revision.
          </p>
          <p className="mt-1 text-small text-ink-tertiary">
            A repository is matched without its case, port or <span className="font-mono">.git</span> ending, so ssh and https
            remotes of one repository name the same one; two keys that come to the same repository are merged. Each
            installation reads a project&apos;s repository from its checkout once and keeps it, so a session cannot change which
            override it gets; after a project&apos;s origin changes, run{' '}
            <span className="font-mono">agenfk update-project &lt;id&gt; --project-root &lt;path&gt;</span> there to read it again.
          </p>
          <datalist id="airlock-known-repos">
            {(repos.data ?? []).map(r => <option key={r.remoteUrl} value={r.remoteUrl} />)}
          </datalist>
          {drafts.map((d, i) => {
            const n = i + 1;
            return (
              <fieldset key={i} className="mt-3 rounded-md border border-border-soft p-3">
                <legend className="sr-only">{`Override ${n}`}</legend>
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`Repository or project, override ${n}`} list="airlock-known-repos"
                    placeholder="github.com/owner/repo or project:<id>"
                    className={`${controlClass} font-mono`} value={d.key} onChange={(e) => edit(i, { key: e.target.value })}
                  />
                  <button type="button" className={buttonClass('secondary')} onClick={() => change(drafts.filter((_, j) => j !== i))}>
                    <span className="sr-only">{`Remove override ${n}`}</span>
                    <span aria-hidden="true">Remove</span>
                  </button>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <textarea aria-label={`Allowed hosts, override ${n}`} placeholder="added allowed hosts" rows={2} className={`${controlClass} font-mono`} value={d.allow} onChange={(e) => edit(i, { allow: e.target.value })} />
                  <textarea aria-label={`Denied hosts, override ${n}`} placeholder="added denied hosts" rows={2} className={`${controlClass} font-mono`} value={d.deny} onChange={(e) => edit(i, { deny: e.target.value })} />
                </div>
                <input
                  aria-label={`Machine image, override ${n}`} placeholder="machine image (the org's when empty)"
                  className={`${controlClass} mt-2 font-mono`} value={d.image} onChange={(e) => edit(i, { image: e.target.value })}
                />
                <div className="mt-2 space-y-1.5">
                  {RULES.map(r => (
                    <label key={r.key} className="flex items-center justify-between gap-3 text-small text-ink">
                      <span>{r.label}</span>
                      <select
                        aria-label={`${r.label}, override ${n}`} className={`${controlClass} max-w-[16rem]`}
                        value={d.rules[r.key] ?? ''} onChange={(e) => setRule(i, r.key, e.target.value)}
                      >
                        <option value="">The org&apos;s rule</option>
                        {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
          <div className="mt-3 flex gap-2">
            <button type="button" className={buttonClass('secondary')} onClick={() => change([...drafts, { key: '', allow: '', deny: '', rules: {}, image: '' }])}>
              Add a project override
            </button>
            <button type="submit" className={buttonClass('primary')} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save overrides'}
            </button>
          </div>
          {problem && <Callout tone="danger" live="assertive" className="mt-3">{problem}</Callout>}
          {save.isError && <SaveError error={save.error} />}
        </>
      )}
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

interface AirlockDataset {
  enabled: boolean;
  rows: number;
  labels: number;
  oldest: string | null;
  newest: string | null;
  limits: { maxRows: number; maxAgeDays: number; maxRowBytes: number };
}

const count = (n: number) => n.toLocaleString('en-US');

function DatasetCard() {
  const qc = useQueryClient();
  const q = useQuery<AirlockDataset>({
    queryKey: ['admin-airlock-dataset'],
    queryFn: async () => (await api.get('/v1/admin/airlock/dataset')).data as AirlockDataset,
  });
  const toggle = useMutation({
    mutationFn: async (enabled: boolean) => (await api.put('/v1/admin/airlock/dataset', { enabled })).data as AirlockDataset,
    onSuccess: (v) => qc.setQueryData(['admin-airlock-dataset'], v),
  });
  const d = q.data;
  return (
    <form aria-label="Airlock dataset" className={`${cardClass} max-w-form`} onSubmit={(e) => e.preventDefault()}>
      <h3 className="text-body font-semibold text-ink">Dataset</h3>
      {q.isError && !d ? <QueryError error={q.error} onRetry={() => q.refetch()} /> : !d ? (
        <p role="status" className="mt-1 text-small text-ink-tertiary">Loading…</p>
      ) : (
        <>
          <p className="mt-1 text-small text-ink-tertiary">
            While on, every joined installation sends each tool call Airlock judges, in full (commands, paths, the content a
            write sends, URLs, the card it was for), with secrets removed before it leaves the machine, and the approvals
            people give. It is kept here to train Airlock&apos;s scorer, and only an admin can download it. Off by default;
            once it is off the hub keeps no new rows at once, and installations stop sending them at their next policy
            sync (within minutes). Past sessions are only sent by{' '}
            <span className="font-mono">agenfk airlock dataset import</span>. Kept: the newest {count(d.limits.maxRows)} rows,
            none older than {d.limits.maxAgeDays} days.
          </p>
          <label className="mt-3 flex items-center gap-2 text-body text-ink">
            <input
              type="checkbox" checked={d.enabled} disabled={toggle.isPending}
              onChange={(e) => toggle.mutate(e.target.checked)}
            />
            Capture tool calls for the dataset
          </label>
          <p className="mt-2 text-small text-ink-secondary">
            {d.enabled ? 'On.' : 'Off.'} {count(d.rows)} rows, {count(d.labels)} labels
            {d.oldest && d.newest ? `, from ${utc(d.oldest)} to ${utc(d.newest)}` : ''}.
          </p>
          {d.rows > 0 && (
            <div className="mt-3">
              <a className={buttonClass('secondary')} href="/v1/admin/airlock/dataset/export" download>Download JSONL</a>
            </div>
          )}
          {toggle.isError && <SaveError error={toggle.error} />}
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
