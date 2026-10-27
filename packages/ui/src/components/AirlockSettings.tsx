/**
 * GH-294 T5: the board's Airlock panel, the Settings section `agenfk airlock
 * edit` links to (`?settings=airlock`).
 *
 * Who may change the policy is the server's rule, and the panel only draws it
 * (user decision 2026-10-27, no passkeys anywhere): a standalone installation
 * edits its local policy here, saved with the revision the draft was made
 * against, so a policy changed in the meantime comes back as a conflict, never
 * a silent overwrite; a hub-joined installation cannot overrule the hub, so
 * the policy is shown read-only with a notice saying so, and no Save is offered.
 *
 * A change made elsewhere (the hub, another tab) never discards unsaved edits:
 * the panel says the policy changed and lets the person reload it or keep
 * their edits and save them over the new revision.
 *
 * Approvals are a person's either way: a pending request (an agent's tool call
 * a needs-human-approval rule stopped) shows every capability a grant would let
 * through, and is approved or denied here. A grant is single-use, expires, and
 * belongs to the session and card that asked; the agent retries the call.
 */
import React from 'react';
import { clsx } from 'clsx';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type AirlockPolicyDto, type AirlockPolicyViewDto, type AirlockModelSelectorDto,
  type AirlockRuleActionDto, type AirlockModeDto, type AirlockApprovalDto,
  type AirlockDecisionFilterDto,
} from '../api';
import { useSocketEvent } from '../SocketContext';
import { AirlockLearning } from './AirlockLearning';
import { AIRLOCK_ALERT_LABEL, isAirlockAlert } from '../airlockAlerts';

const MODES: Array<{ value: AirlockModeDto; label: string }> = [
  { value: 'off', label: 'Off: nothing is checked' },
  { value: 'observe', label: 'Observe: log what would be stopped' },
  { value: 'enforce', label: 'Enforce: stop it' },
];

const RULES: Array<{ key: keyof AirlockPolicyDto['rules']; label: string; description: string }> = [
  { key: 'uploadToUnlistedHost', label: 'Upload to an unlisted host', description: 'Sending a file or data to a host the allow list does not name.' },
  { key: 'credentialReadWithNetwork', label: 'Credential read with network', description: 'Reading a credential file and reaching the network in the same command.' },
  { key: 'namespaceEscape', label: 'Namespace escape', description: 'unshare or nsenter run as a command.' },
  { key: 'cloudMutation', label: 'Cloud mutation', description: 'Changing cloud resources with aws, gcloud, az, kubectl, terraform or pulumi.' },
];

const ACTIONS: Array<{ value: AirlockRuleActionDto; label: string }> = [
  { value: 'deny', label: 'Deny' },
  { value: 'needs-human-approval', label: 'Needs a person’s approval' },
  { value: 'off', label: 'Off' },
];

const lines = (text: string): string[] => text.split('\n').map(l => l.trim()).filter(Boolean);

interface Draft {
  mode: AirlockModeDto;
  /** Kept as objects, field by field: an untouched selector goes back exactly as it came. */
  models: AirlockModelSelectorDto[];
  appliesWhenModelUnknown: boolean;
  allow: string;
  deny: string;
  rules: AirlockPolicyDto['rules'];
}

const draftOf = (p: AirlockPolicyDto): Draft => ({
  mode: p.mode,
  models: p.models.map(m => ({ ...m })),
  appliesWhenModelUnknown: p.appliesWhenModelUnknown,
  allow: p.hosts.allow.join('\n'),
  deny: p.hosts.deny.join('\n'),
  rules: { ...p.rules },
});

/** The draft as a policy, on top of what it was made from (the IOC list is the hub's, never the board's). */
const policyOf = (base: AirlockPolicyDto, d: Draft): AirlockPolicyDto => ({
  ...base,
  mode: d.mode,
  models: d.models.map(m => ({ ...m })),
  appliesWhenModelUnknown: d.appliesWhenModelUnknown,
  hosts: { allow: lines(d.allow), deny: lines(d.deny) },
  rules: { ...d.rules },
});

const samePolicy = (a: AirlockPolicyDto, b: AirlockPolicyDto): boolean => JSON.stringify(a) === JSON.stringify(b);

type SaveProblem = { conflict: boolean; message: string; errors?: string[] };
type ServerError = { response?: { status?: number; data?: { error?: string; message?: string; errors?: unknown[] } } } | null;

/** What the server said, in words a person can act on. */
function problemOf(e: unknown): SaveProblem {
  const response = (e as ServerError)?.response;
  const data = response?.data ?? {};
  if (response?.status === 409 && data.error === 'AIRLOCK_REVISION_CONFLICT') {
    return { conflict: true, message: data.message ?? 'The policy changed since it was read. Reload and apply the change again.' };
  }
  if (Array.isArray(data.errors) && data.errors.length) {
    return { conflict: false, message: 'The server refused the policy:', errors: data.errors.map(String) };
  }
  return { conflict: false, message: data.message ?? data.error ?? 'Could not save the policy; it was not changed.' };
}

const FIELD = 'w-full rounded-lg border border-border-soft bg-canvas px-2.5 py-1.5 text-[13px] text-ink-secondary disabled:cursor-not-allowed disabled:opacity-60 read-only:opacity-80';
const LABEL = 'text-[13px] font-semibold text-ink';
const HELP = 'mt-0.5 text-[12px] leading-snug text-ink-tertiary';
const BLOCK = 'border-b border-border-soft py-4 last:border-b-0';
const SUBHEAD = 'text-[11px] font-bold uppercase tracking-[0.14em] text-ink-tertiary';
const SECONDARY_BUTTON = 'rounded-lg border border-border-soft px-2.5 py-1 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-50';

function Problem({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div role="alert" className="mt-4 rounded-lg border border-status-danger-text/40 bg-status-danger-bg px-3 py-2 text-[12px] text-status-danger-text">
      {children}
    </div>
  );
}

const CLIENT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any client' },
  { value: 'pi', label: 'pi' },
  { value: 'opencode', label: 'opencode' },
  { value: '*', label: '* (any)' },
];

function SelectorRows({
  models, readOnly, onChange,
}: {
  models: AirlockModelSelectorDto[];
  readOnly: boolean;
  onChange: (models: AirlockModelSelectorDto[]) => void;
}): React.ReactElement {
  // A cleared field means "any": the key goes. Fields nobody touched stay exactly as stored.
  const setField = (i: number, k: keyof AirlockModelSelectorDto, v: string) =>
    onChange(models.map((m, j) => {
      if (j !== i) return m;
      const next = { ...m } as Record<string, string>;
      if (v === '') delete next[k]; else next[k] = v;
      return next as AirlockModelSelectorDto;
    }));

  return (
    <fieldset className={BLOCK}>
      <legend className={LABEL}>Model selectors</legend>
      <p className={HELP}>
        The sessions Airlock applies to. Each part takes * and ? as wildcards; an empty part matches anything. No selectors: every session.
      </p>
      {models.map((m, i) => (
        <div key={i} className="mt-2 flex flex-wrap items-center gap-2" data-testid="airlock-selector">
          <select
            aria-label={`Client, selector ${i + 1}`}
            value={m.client ?? ''}
            disabled={readOnly}
            onChange={e => setField(i, 'client', e.target.value)}
            className={clsx(FIELD, 'w-auto')}
          >
            {CLIENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input
            aria-label={`Provider, selector ${i + 1}`}
            placeholder="any provider"
            value={m.provider ?? ''}
            readOnly={readOnly}
            onChange={e => setField(i, 'provider', e.target.value)}
            className={clsx(FIELD, 'min-w-0 flex-1 font-mono')}
          />
          <input
            aria-label={`Model, selector ${i + 1}`}
            placeholder="any model"
            value={m.model ?? ''}
            readOnly={readOnly}
            onChange={e => setField(i, 'model', e.target.value)}
            className={clsx(FIELD, 'min-w-0 flex-1 font-mono')}
          />
          {!readOnly && (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => onChange(models.filter((_, j) => j !== i))}>
              <span className="sr-only">{`Remove selector ${i + 1}`}</span>
              <span aria-hidden="true">Remove</span>
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button type="button" className={clsx(SECONDARY_BUTTON, 'mt-2')} onClick={() => onChange([...models, {}])}>
          Add a model selector
        </button>
      )}
    </fieldset>
  );
}

function PolicyForm({
  view, onSave, saving,
}: {
  view: AirlockPolicyViewDto;
  /** Resolves with the stored view, or null when the save failed (the parent shows why). */
  onSave: (policy: AirlockPolicyDto, expectedRevision: number) => Promise<AirlockPolicyViewDto | null>;
  saving: boolean;
}): React.ReactElement {
  // `base` is the view the draft was made against; `view` is what the server says now.
  const [base, setBase] = React.useState<AirlockPolicyViewDto>(view);
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(view.effective));
  const [seen, setSeen] = React.useState<AirlockPolicyViewDto>(view);
  const dirty = !samePolicy(policyOf(base.effective, draft), policyOf(base.effective, draftOf(base.effective)));

  // A new view from the server (a save, the hub, another tab): adopted unless
  // it would throw away edits nobody has saved. Done while rendering, as React
  // recommends for state that follows a prop, so nothing paints in between.
  if (view !== seen) {
    setSeen(view);
    const moved = view.revision !== base.revision || view.source !== base.source || view.hubManaged !== base.hubManaged;
    if (moved && (!dirty || view.hubManaged || samePolicy(policyOf(view.effective, draft), view.effective))) {
      setBase(view);
      setDraft(draftOf(view.effective));
    }
  }
  const changedElsewhere = view.revision !== base.revision || view.source !== base.source;

  const readOnly = view.hubManaged;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft(d => ({ ...d, [k]: v }));
  const adopt = (v: AirlockPolicyViewDto) => { setBase(v); setDraft(draftOf(v.effective)); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const stored = await onSave(policyOf(base.effective, draft), base.revision);
    if (stored) { setSeen(stored); adopt(stored); }
  };

  return (
    <form onSubmit={submit} aria-label="Airlock policy">
      {changedElsewhere && dirty && !readOnly && (
        <div role="status" className="mt-4 rounded-lg border border-status-warn-text/40 bg-status-warn-bg px-3 py-2 text-[12px] text-status-warn-text">
          {`The policy changed elsewhere (it is now at revision ${view.revision}); your unsaved edits are against revision ${base.revision}, so saving them as they are will be refused.`}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={SECONDARY_BUTTON} onClick={() => adopt(view)}>
              {`Discard my edits and load revision ${view.revision}`}
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => setBase(view)}>
              {`Keep my edits and save them over revision ${view.revision}`}
            </button>
          </div>
        </div>
      )}

      <div className={BLOCK}>
        <label htmlFor="airlock-mode" className={LABEL}>Mode</label>
        <p className={HELP}>Whether tool calls by the selected agents are checked, and what happens to one a rule catches.</p>
        <select
          id="airlock-mode"
          value={draft.mode}
          disabled={readOnly}
          onChange={e => set('mode', e.target.value as AirlockModeDto)}
          className={clsx(FIELD, 'mt-2 w-auto')}
        >
          {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>

      <SelectorRows models={draft.models} readOnly={readOnly} onChange={models => set('models', models)} />
      <div className={BLOCK}>
        <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
          <input
            type="checkbox"
            checked={draft.appliesWhenModelUnknown}
            disabled={readOnly}
            onChange={e => set('appliesWhenModelUnknown', e.target.checked)}
            className="h-3.5 w-3.5 accent-current disabled:cursor-not-allowed"
          />
          Apply when the session’s model is unknown
        </label>
      </div>

      <div className={clsx(BLOCK, 'grid gap-4 sm:grid-cols-2')}>
        <div>
          <label htmlFor="airlock-allow" className={LABEL}>Allowed hosts</label>
          <p className={HELP}>Hosts an upload may go to. One per line: a name, *.domain, or a CIDR.</p>
          <textarea id="airlock-allow" rows={4} value={draft.allow} readOnly={readOnly} onChange={e => set('allow', e.target.value)} className={clsx(FIELD, 'mt-2 font-mono')} />
        </div>
        <div>
          <label htmlFor="airlock-deny" className={LABEL}>Denied hosts</label>
          <p className={HELP}>Hosts no tool call may reach. Cloud metadata endpoints are always denied.</p>
          <textarea id="airlock-deny" rows={4} value={draft.deny} readOnly={readOnly} onChange={e => set('deny', e.target.value)} className={clsx(FIELD, 'mt-2 font-mono')} />
        </div>
      </div>

      <div className={BLOCK}>
        <p className={LABEL}>Rules</p>
        <div className="mt-2 space-y-3">
          {RULES.map(rule => (
            <div key={rule.key} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label htmlFor={`airlock-rule-${rule.key}`} className="text-[13px] text-ink">{rule.label}</label>
                <p className={HELP}>{rule.description}</p>
              </div>
              <select
                id={`airlock-rule-${rule.key}`}
                value={draft.rules[rule.key]}
                disabled={readOnly}
                onChange={e => setDraft(d => ({ ...d, rules: { ...d.rules, [rule.key]: e.target.value as AirlockRuleActionDto } }))}
                className={clsx(FIELD, 'w-auto shrink-0')}
              >
                {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
          ))}
        </div>
        {view.effective.iocHosts.hosts.length > 0 && (
          <p className={clsx(HELP, 'mt-3')}>
            {`${view.effective.iocHosts.hosts.length} indicator-of-compromise hosts are denied as well (list revision ${view.effective.iocHosts.revision || 'unset'}).`}
          </p>
        )}
      </div>

      {!readOnly && (
        <div className="flex justify-end py-4">
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-navy disabled:opacity-50"
          >
            Save policy
          </button>
        </div>
      )}
    </form>
  );
}

const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '');

const STATUS_LABEL: Record<AirlockApprovalDto['status'], string> = {
  pending: 'Pending',
  granted: 'Approved, not used yet',
  consumed: 'Approved and used',
  expired: 'Approval expired unused',
  denied: 'Denied',
};

/** A request a person cannot read whole cannot be approved: why, or null when it can. */
const unapprovable = (a: AirlockApprovalDto): string | null =>
  a.capabilities?.some(c => c.concealed === true)
    ? 'Cannot be approved: redaction would hide code that runs inside a secret-looking value. Deny it, or have the agent pass the secret without running anything inside it.'
    : a.capabilities?.some(c => c.complete === false)
      ? 'Too long to show in full, so it cannot be approved here. Deny it, or have the agent split the call.'
      : null;

/** Everything a grant would let through, one capability per line. */
function BoundCapabilities({ approval }: { approval: AirlockApprovalDto }): React.ReactElement {
  const caps = approval.capabilities?.length ? approval.capabilities : [{ kind: 'command' as const, value: approval.summary }];
  return (
    <div className="space-y-0.5">
      {caps.map((c, i) => (
        <div key={i} className="flex items-baseline gap-2 text-[12px]">
          <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-tertiary">{c.access ? `${c.kind} (${c.access})` : c.kind}</span>
          {/* Whole, never an excerpt: a person approves what they read. Long values wrap and scroll. */}
          <code className="block max-h-48 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-all font-mono text-ink">{c.value}</code>
        </div>
      ))}
    </div>
  );
}

function Approvals(): React.ReactElement {
  const queryClient = useQueryClient();
  const approvals = useQuery({ queryKey: ['airlock-approvals'], queryFn: api.getAirlockApprovals });
  const answer = useMutation({
    mutationFn: ({ approval, grant }: { approval: AirlockApprovalDto; grant: boolean }) =>
      (grant ? api.grantAirlockApproval(approval.key, approval.generation) : api.denyAirlockApproval(approval.key, approval.generation)),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['airlock-approvals'] }); },
  });
  const busy = (key: string) => answer.isPending && answer.variables?.approval.key === key;
  const answerError = (answer.error as ServerError)?.response?.data?.message;

  const approveButton = (a: AirlockApprovalDto, primary: boolean) => (
    <button
      type="button"
      aria-label={`Approve: ${a.summary}`}
      disabled={busy(a.key)}
      onClick={() => answer.mutate({ approval: a, grant: true })}
      className={primary ? 'rounded-lg bg-brand px-3 py-1 text-xs font-bold text-navy disabled:opacity-50' : SECONDARY_BUTTON}
    >
      Approve
    </button>
  );

  const pending = approvals.data?.pending ?? [];
  const recent = approvals.data?.recent ?? [];
  const denied = approvals.data?.denied ?? [];

  return (
    <div className={BLOCK}>
      <h3 className={SUBHEAD}>Waiting for approval</h3>
      <p className={HELP}>
        An approval lets that exact call, from the session and card that asked, through once within 30 minutes; the agent retries it. A denial holds until someone approves it.
      </p>
      {answer.isError && <Problem>{answerError ?? 'Could not record that answer; nothing changed.'}</Problem>}
      {approvals.isPending && <p role="status" className="mt-2 text-[12px] text-ink-tertiary">Loading approvals…</p>}
      {approvals.isError && (
        <Problem>
          Could not load the approvals, so requests may be waiting that are not shown here.
          <button type="button" onClick={() => void approvals.refetch()} className="ml-2 underline">Retry</button>
        </Problem>
      )}
      {approvals.isSuccess && pending.length === 0 && <p className="mt-2 text-[12px] text-ink-tertiary">Nothing is waiting.</p>}
      {pending.length > 0 && (
        <ul className="mt-2 space-y-2" aria-label="Pending approvals">
          {pending.map(a => (
            <li key={a.key} className="rounded-lg border border-border-soft bg-canvas px-3 py-2">
              <BoundCapabilities approval={a} />
              <p className="mt-1 text-[11px] text-ink-tertiary">
                {`${a.rule} · ${a.itemId ? `card ${a.itemId.slice(0, 8)} · ` : ''}asked ${when(a.requestedAt)}`}
              </p>
              {unapprovable(a) && <p className="mt-1 text-[12px] text-status-warn-text">{unapprovable(a)}</p>}
              <div className="mt-2 flex gap-2">
                {!unapprovable(a) && approveButton(a, true)}
                <button
                  type="button"
                  aria-label={`Deny: ${a.summary}`}
                  disabled={busy(a.key)}
                  onClick={() => answer.mutate({ approval: a, grant: false })}
                  className="rounded-lg border border-status-danger-text/40 px-3 py-1 text-xs font-semibold text-status-danger-text disabled:opacity-50"
                >
                  Deny
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {denied.length > 0 && (
        <>
          <h3 className={clsx(SUBHEAD, 'mt-4')}>Denied</h3>
          <ul className="mt-2 space-y-2" aria-label="Denied requests">
            {denied.map(a => (
              <li key={a.key} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <BoundCapabilities approval={a} />
                  <p className="mt-0.5 text-[11px] text-ink-tertiary">{`${a.rule} · denied ${when(a.deniedAt)}`}</p>
                </div>
                {!unapprovable(a) && approveButton(a, false)}
              </li>
            ))}
          </ul>
        </>
      )}
      {recent.length > 0 && (
        <>
          <h3 className={clsx(SUBHEAD, 'mt-4')}>Answered</h3>
          <ul className="mt-2 space-y-1" aria-label="Answered approvals">
            {recent.map(a => (
              <li key={a.key} className="flex items-start justify-between gap-3">
                <div className="min-w-0"><BoundCapabilities approval={a} /></div>
                <span className="shrink-0 text-[12px] text-ink-tertiary">
                  {a.status === 'granted' ? `${STATUS_LABEL.granted} (until ${when(a.expiresAt)})` : STATUS_LABEL[a.status]}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const DECISION_TONE: Record<string, string> = {
  deny: 'text-status-danger-text',
  'needs-human-approval': 'text-status-warn-text',
  allow: 'text-status-ok-text',
};

/** TEL-2: the server filters, so the list is the newest matching decisions. '' is every one. */
const DECISION_CLIENTS = [{ value: '', label: 'All clients' }, { value: 'pi', label: 'pi' }, { value: 'opencode', label: 'opencode' }] as const;
const DECISION_SOURCES = [{ value: '', label: 'All sources' }, { value: 'tool', label: 'Tool calls' }, { value: 'proxy', label: 'Sandbox proxy' }] as const;

function Decisions(): React.ReactElement {
  const [client, setClient] = React.useState<'' | 'pi' | 'opencode'>('');
  const [source, setSource] = React.useState<'' | 'tool' | 'proxy'>('');
  const filter: AirlockDecisionFilterDto = { ...(client ? { client } : {}), ...(source ? { source } : {}) };
  const { data, isError } = useQuery({ queryKey: ['airlock-decisions', filter], queryFn: () => api.getAirlockDecisions(20, filter) });
  const decisions = data?.decisions ?? [];
  const filtered = !!(client || source);
  return (
    <div className={BLOCK}>
      <h3 className={SUBHEAD}>Recent decisions</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        <select aria-label="Filter by client" value={client} onChange={e => setClient(e.target.value as typeof client)} className={clsx(FIELD, 'w-auto')}>
          {DECISION_CLIENTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select aria-label="Filter by source" value={source} onChange={e => setSource(e.target.value as typeof source)} className={clsx(FIELD, 'w-auto')}>
          {DECISION_SOURCES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {isError && <p className="mt-2 text-[12px] text-status-warn-text">Could not read the decision log.</p>}
      {!isError && decisions.length === 0 && (
        <p className="mt-2 text-[12px] text-ink-tertiary">{filtered ? 'No decisions match these filters.' : 'Nothing stopped or flagged yet.'}</p>
      )}
      {decisions.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-label="Recent decisions">
          {decisions.map((d, i) => (
            <li key={d.id ?? i} className="text-[12px]">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={clsx('font-semibold', DECISION_TONE[d.decision] ?? 'text-ink')}>{d.decision}</span>
                {d.rule && <span className="text-ink-secondary">{d.rule}</span>}
                {isAirlockAlert(d.alert) && <span className="font-semibold text-status-danger-text">{AIRLOCK_ALERT_LABEL[d.alert]}</span>}
                <span className="text-ink-tertiary">{`${when(d.ts)} · ${d.client} · ${d.source ?? 'tool'}${d.model ? ` · ${d.model}` : ''}${d.mode === 'observe' ? ' · observed' : ''}`}</span>
              </div>
              {d.target && <code className="block break-all text-ink-tertiary">{d.target}</code>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AirlockSettings(): React.ReactElement {
  const queryClient = useQueryClient();
  const policy = useQuery({ queryKey: ['airlock-policy'], queryFn: api.getAirlockPolicy });
  const [problem, setProblem] = React.useState<SaveProblem | null>(null);
  const [savedRevision, setSavedRevision] = React.useState<number | null>(null);

  // Live: a request recorded, a grant used, the policy changed by the hub or another tab.
  useSocketEvent('airlock_approvals_changed', () => { void queryClient.invalidateQueries({ queryKey: ['airlock-approvals'] }); });
  useSocketEvent('airlock_decision', () => { void queryClient.invalidateQueries({ queryKey: ['airlock-decisions'] }); });
  useSocketEvent('airlock_policy_changed', () => { void queryClient.invalidateQueries({ queryKey: ['airlock-policy'] }); });

  const save = useMutation({
    mutationFn: ({ p, expectedRevision }: { p: AirlockPolicyDto; expectedRevision: number }) => api.saveAirlockPolicy({ policy: p, expectedRevision }),
    onMutate: () => { setProblem(null); setSavedRevision(null); },
    onSuccess: view => { queryClient.setQueryData(['airlock-policy'], view); setSavedRevision(view.revision); },
    onError: e => setProblem(problemOf(e)),
  });

  const onSave = async (p: AirlockPolicyDto, expectedRevision: number): Promise<AirlockPolicyViewDto | null> => {
    try { return await save.mutateAsync({ p, expectedRevision }); } catch { return null; }
  };

  const reload = () => {
    setProblem(null);
    void policy.refetch();
  };

  const view = policy.data;
  return (
    <div data-testid="airlock-settings">
      {policy.isError && <Problem>Could not read the Airlock policy. Check that AgEnFK is running.</Problem>}
      {view && (
        <>
          <div className={BLOCK}>
            <p className="text-[12px] text-ink-tertiary">
              {`Revision ${view.revision} · from ${view.source === 'hub' ? 'the hub' : 'this installation'}`}
            </p>
            {view.hubManaged && (
              <div className="mt-2 rounded-lg border border-status-warn-text/40 bg-status-warn-bg px-3 py-2 text-[12px] text-status-warn-text">
                This policy is managed by your organization&apos;s hub and cannot be changed on this installation. An org admin changes it on the hub.
              </div>
            )}
          </div>
          <PolicyForm view={view} saving={save.isPending} onSave={onSave} />
          {problem && (
            <Problem>
              {problem.message}
              {problem.errors && (
                <ul className="mt-1 list-disc pl-4">{problem.errors.map(e => <li key={e}>{e}</li>)}</ul>
              )}
              {problem.conflict && (
                <button type="button" onClick={reload} className="ml-2 underline">Reload the policy</button>
              )}
            </Problem>
          )}
          {savedRevision !== null && !problem && (
            <p role="status" className="py-2 text-[12px] text-status-ok-text">{`Saved (revision ${savedRevision}).`}</p>
          )}
        </>
      )}
      <Approvals />
      <Decisions />
      <AirlockLearning />
    </div>
  );
}
